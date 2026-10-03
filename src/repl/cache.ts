/**
 * The dynamic completion plane: entity refs fetched through dispatch and
 * held per entity, so Tab answers from memory and never blocks the line.
 * Offline is a state, not an error — the plane simply stays empty.
 */

import type { Entity } from './parser'

export class RefCache {
  private readonly data = new Map<Entity, string[]>()
  private readonly inflight = new Map<Entity, Promise<void>>()
  private readonly fetch: (entity: Entity) => Promise<string[]>
  private readonly cap: number

  /** `fetch` returns display strings (labels and ids interleaved); the cap
   * bounds what a bare `<entity> show <TAB>` can ever dump on the terminal. */
  constructor(fetch: (entity: Entity) => Promise<string[]>, cap = 200) {
    this.fetch = fetch
    this.cap = cap
  }

  get(entity: Entity): string[] {
    return this.data.get(entity) ?? []
  }

  /** Idempotent and concurrency-safe: parallel warms share one fetch, and a
   * failed fetch leaves the plane cold rather than poisoning the cache. */
  async warm(entity: Entity): Promise<void> {
    if (this.data.has(entity)) {
      return
    }
    const pending = this.inflight.get(entity)
    if (pending) {
      await pending
      return
    }
    const p = this.fetch(entity)
      .then((rows) => {
        this.data.set(entity, rows.slice(0, this.cap))
      })
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(entity)
      })
    this.inflight.set(entity, p)
    await p
  }

  /** Forget one entity so the next warm re-fetches (after a bulk change). */
  refresh(entity: Entity): void {
    this.data.delete(entity)
  }

  /** The two planes a human hits within the first minute of a session. */
  async warmStart(): Promise<void> {
    await Promise.all([this.warm('contact'), this.warm('task')])
  }
}
