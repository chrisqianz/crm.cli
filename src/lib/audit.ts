/**
 * P4: the audit hash chain.
 *
 * Every mutation lands in `audit_log` as exactly one row. Each row stores
 * `prev_hash` (the previous row's `row_hash`, genesis = 64 zeros) and its
 * own `row_hash` = sha256 over the row's content including `prev_hash`.
 * Tampering with row N breaks row N (content hash mismatch) and row N+1
 * (prev_hash mismatch) — `verifyChain` reports the first broken seq.
 *
 * Rows written before P4 (empty hashes) are "legacy": they are reported,
 * excluded from the chain, and never break it.
 */
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'

import { eq } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import * as entitySchema from '../db/schema-sqlite'
import type { CrmDb } from '../db/seam'
import { resolveEntity, resolveTask } from '../resolve'

/** Genesis prev_hash for the first chained row of a table. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64)

export interface AuditEvent {
  action: string
  actor_id: string
  actor_name: string
  after_json?: string | null
  before_json?: string | null
  entity_id?: string | null
  entity_type?: string | null
  ip?: string | null
  source: string
}

export interface AuditRowValues {
  action: string
  actor_id: string
  actor_name: string
  after_json: string | null
  at: string
  before_json: string | null
  entity_id: string | null
  entity_type: string | null
  ip: string | null
  prev_hash: string
  seq: number
  source: string
}

/**
 * Deterministic row hash: a single canonical line, one field per
 * pipe-separated segment, nulls normalized to ''.
 */
export function computeRowHash(row: AuditRowValues): string {
  const payload = [
    row.seq,
    row.at,
    row.actor_id,
    row.actor_name,
    row.action,
    row.entity_type ?? '',
    row.entity_id ?? '',
    row.before_json ?? '',
    row.after_json ?? '',
    row.source,
    row.ip ?? '',
    row.prev_hash,
  ].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Normalize one cell read through the raw seam.
 *
 * This is the load-bearing dialect boundary for the chain: a hash is only
 * reproducible over strings, and the two drivers disagree about the same
 * column (postgres hands back a `string` for a BIGINT but a `number` for an
 * INTEGER identity — the schema contract pins `seq` to INTEGER precisely so
 * `Number()` here stays exact). Everything nullable collapses to null, which
 * `computeRowHash` already renders as ''.
 */
function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/**
 * Append one audit row to the chain. Runs inside a write transaction so
 * concurrent writers (multiple CLI processes, RPC connections) cannot
 * fork the chain: the read of the previous hash and the insert happen
 * under the same write lock.
 *
 * The transaction lock is per *client*: two overlapping recordAudit calls
 * on the same in-process client interleave their transactions and fail
 * with SQLITE_BUSY ("cannot commit transaction - SQL statements in
 * progress") — the classic trigger is the fire-and-forget conn.closed
 * audit racing the next request's audit. Every audit write on a client
 * therefore goes through one promise chain: sequential by construction.
 */
const auditWriteChain = new WeakMap<object, Promise<void>>()

export function recordAudit(db: CrmDb, e: AuditEvent): Promise<void> {
  const chain = auditWriteChain.get(db) ?? Promise.resolve()
  const next = chain
    .catch(() => {
      // a failed predecessor must not poison the rest of the chain
    })
    .then(() => recordAuditTx(db, e))
  auditWriteChain.set(db, next)
  return next
}

/**
 * Write one chained row: read the head, insert with `row_hash` still empty,
 * read back the seq the database assigned, then hash content that includes
 * that seq. Commit is on return; any throw rolls the whole thing back, so a
 * failed audit never leaves an unchained row that would break verification.
 *
 * The in-process chain in `recordAudit` is not an optimization — it is what
 * keeps the chain linear. On sqlite it avoids the SQLITE_BUSY that two
 * overlapping write transactions produce on one client; on postgres there is
 * no such collision, which is worse: two concurrent transactions each read
 * the same head, each insert, and the chain forks silently. One transaction
 * per handle is the invariant the hash depends on.
 */
async function recordAuditTx(db: CrmDb, e: AuditEvent): Promise<void> {
  // The seam's transaction holds the write lock for its whole life on sqlite
  // (`transaction('write')`) and one dedicated pool client on postgres, so
  // nothing else can append between the head read and the insert.
  await db.$crm.raw.transaction(async (tx) => {
    const last = await tx.query(
      `SELECT row_hash FROM audit_log WHERE row_hash != '' ORDER BY seq DESC LIMIT 1`,
    )
    const prevHash =
      last.length > 0 ? String(last[0].row_hash) : AUDIT_GENESIS_HASH
    const at = new Date().toISOString()
    await tx.query(
      `INSERT INTO audit_log
        (at, actor_id, actor_name, action, entity_type, entity_id,
         before_json, after_json, source, ip, prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      [
        at,
        e.actor_id,
        e.actor_name,
        e.action,
        e.entity_type ?? null,
        e.entity_id ?? null,
        e.before_json ?? null,
        e.after_json ?? null,
        e.source,
        e.ip ?? null,
        prevHash,
      ],
    )
    // Neither driver reports an insert id from inside a transaction, so read
    // the row back by fields that are unique *because* of the chain: prev_hash
    // can only be the head once, and this tx holds the writer's lock.
    const ins = await tx.query(
      'SELECT seq FROM audit_log WHERE at = ? AND action = ? AND prev_hash = ? ORDER BY seq DESC LIMIT 1',
      [at, e.action, prevHash],
    )
    const seq = Number(ins[0].seq)
    const rowHash = computeRowHash({
      seq,
      at,
      actor_id: e.actor_id,
      actor_name: e.actor_name,
      action: e.action,
      entity_type: e.entity_type ?? null,
      entity_id: e.entity_id ?? null,
      before_json: e.before_json ?? null,
      after_json: e.after_json ?? null,
      source: e.source,
      ip: e.ip ?? null,
      prev_hash: prevHash,
    })
    await tx.query('UPDATE audit_log SET row_hash = ? WHERE seq = ?', [
      rowHash,
      seq,
    ])
  })
}

export interface VerifyResult {
  /** First broken row, if the chain fails. */
  brokenSeq: number | null
  /** Chained rows verified. */
  chained: number
  /** Seq of the first chained row, if any. */
  genesisSeq: number | null
  /** Rows with empty hashes (pre-P4) — reported, not part of the chain. */
  legacy: number
  ok: boolean
  reason: string | null
}

/**
 * Walk the chain in seq order. Rules:
 *  - legacy rows (row_hash = '') are skipped until the first chained row
 *  - the first chained row's prev_hash must be the genesis constant
 *  - every chained row must link (prev_hash = prior row_hash) and its
 *    content hash must recompute to its stored row_hash
 */
export async function verifyChain(db: CrmDb): Promise<VerifyResult> {
  const read = await db.$crm.raw.query(
    `SELECT seq, at, actor_id, actor_name, action, entity_type, entity_id,
            before_json, after_json, source, ip, prev_hash, row_hash
     FROM audit_log ORDER BY seq`,
  )
  // Every value goes through the same normalization the writer used, so a
  // row read back through postgres hashes identically to one read through
  // sqlite — a chain that only verifies on one dialect is not a chain.
  const rows: (AuditRowValues & { row_hash: string })[] = read.map((r) => ({
    action: String(r.action),
    actor_id: String(r.actor_id),
    actor_name: String(r.actor_name),
    after_json: text(r.after_json),
    at: String(r.at),
    before_json: text(r.before_json),
    entity_id: text(r.entity_id),
    entity_type: text(r.entity_type),
    ip: text(r.ip),
    prev_hash: String(r.prev_hash),
    seq: Number(r.seq),
    source: String(r.source),
    row_hash: String(r.row_hash),
  }))

  let legacy = 0
  let chained = 0
  let expectedPrev = AUDIT_GENESIS_HASH
  let genesisSeq: number | null = null
  let seenChained = false

  for (const row of rows) {
    if (row.row_hash === '') {
      legacy++
      continue
    }
    if (!seenChained) {
      seenChained = true
      genesisSeq = row.seq
      if (row.prev_hash !== AUDIT_GENESIS_HASH) {
        return {
          ok: false,
          legacy,
          chained: 0,
          genesisSeq,
          brokenSeq: row.seq,
          reason: 'first chained row does not start from the genesis hash',
        }
      }
    } else if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        legacy,
        chained,
        genesisSeq,
        brokenSeq: row.seq,
        reason: `prev_hash does not match row ${expectedPrev === '' ? '?' : 'the previous row'} — a row was inserted, deleted, or reordered`,
      }
    }
    const recomputed = computeRowHash(row)
    if (recomputed !== row.row_hash) {
      return {
        ok: false,
        legacy,
        chained,
        genesisSeq,
        brokenSeq: row.seq,
        reason:
          'content hash mismatch — this row was altered after being written',
      }
    }
    expectedPrev = row.row_hash
    chained++
  }

  return {
    ok: true,
    legacy,
    chained,
    genesisSeq,
    brokenSeq: null,
    reason: null,
  }
}

// ── P4 audit helpers (local funnel) ──

export function osUserName(): string {
  try {
    return userInfo().username
  } catch {
    return 'local'
  }
}

/** Best-effort entity target of a write method, for the audit row. */
export async function auditMeta(
  db: DB,
  config: CRMConfig,
  method: string,
  params: Record<string, unknown>,
  result: Record<string, unknown> | null,
): Promise<{ entity_type?: string; entity_id?: string }> {
  const prefix = method.split('.')[0]
  const entityId =
    (result?.id as string | undefined) ??
    (params.id as string | undefined) ??
    (params.ref as string | undefined) ??
    (params.id1 as string | undefined)
  if (prefix === 'contact' || prefix === 'company' || prefix === 'deal') {
    if (method.endsWith('.add')) {
      return { entity_type: prefix, entity_id: entityId }
    }
    const ref =
      (params.ref as string | undefined) ?? (params.id1 as string | undefined)
    if (ref) {
      const resolved = await resolveEntity(db, ref, config)
      if (resolved) {
        return { entity_type: resolved.type, entity_id: resolved.entity.id }
      }
    }
    return { entity_type: prefix, entity_id: entityId }
  }
  if (method === 'activity.log') {
    return { entity_type: 'activity', entity_id: entityId }
  }
  if (prefix === 'task') {
    if (method.endsWith('.add')) {
      return { entity_type: 'task', entity_id: entityId }
    }
    const ref = (params.ref as string | undefined) ?? ''
    if (ref) {
      const resolved = await resolveTask(db, ref)
      if (resolved) {
        return { entity_type: 'task', entity_id: resolved.id }
      }
    }
    return { entity_type: 'task', entity_id: entityId }
  }
  if (method === 'tag' || method === 'untag') {
    const ref = (params.ref as string | undefined) ?? ''
    if (ref) {
      const resolved = await resolveEntity(db, ref, config)
      if (resolved) {
        return { entity_type: resolved.type, entity_id: resolved.entity.id }
      }
    }
    return {}
  }
  // import.* / index.rebuild: batch or meta writes — no single entity
  return {}
}

/**
 * Snapshot the audit target before/after a write. Insert → before is
 * null; delete → after is null; batch/meta writes → the operation
 * result instead of an entity row.
 */
export async function auditSnapshot(
  db: DB,
  config: CRMConfig,
  method: string,
  params: Record<string, unknown>,
  result: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  const meta = await auditMeta(db, config, method, params, result ?? null)
  if (meta.entity_type && meta.entity_id) {
    const row = await auditEntityRow(db, meta.entity_type, meta.entity_id)
    if (row) {
      return JSON.stringify(row)
    }
    if (method.endsWith('.add')) {
      return null // not visible yet (called before the write)
    }
    return null // deleted / merged away
  }
  return result ? JSON.stringify(result) : null
}

export async function auditEntityRow(
  db: DB,
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  if (entityType === 'contact') {
    const rows = await db
      .select()
      .from(entitySchema.contacts)
      .where(eq(entitySchema.contacts.id, entityId))
    if (rows.length > 0) {
      // SAFETY: entity column map — see the comment on the contacts
      // branch; the other entity branches share the same invariant.
      return rows[0] as unknown as Record<string, unknown>
    }
    return null
  }
  if (entityType === 'company') {
    const rows = await db
      .select()
      .from(entitySchema.companies)
      .where(eq(entitySchema.companies.id, entityId))
    if (rows.length > 0) {
      // SAFETY: entity column map — same invariant as the contacts branch.
      return rows[0] as unknown as Record<string, unknown>
    }
    return null
  }
  if (entityType === 'deal') {
    const rows = await db
      .select()
      .from(entitySchema.deals)
      .where(eq(entitySchema.deals.id, entityId))
    if (rows.length > 0) {
      // SAFETY: entity column map — same invariant as the contacts branch.
      return rows[0] as unknown as Record<string, unknown>
    }
    return null
  }
  if (entityType === 'task') {
    const rows = await db
      .select()
      .from(entitySchema.tasks)
      .where(eq(entitySchema.tasks.id, entityId))
    if (rows.length > 0) {
      // SAFETY: entity column map — same invariant as the contacts branch.
      return rows[0] as unknown as Record<string, unknown>
    }
    return null
  }
  if (entityType === 'activity') {
    const rows = await db
      .select()
      .from(entitySchema.activities)
      .where(eq(entitySchema.activities.id, entityId))
    if (rows.length > 0) {
      // SAFETY: entity column map — same invariant as the contacts branch.
      return rows[0] as unknown as Record<string, unknown>
    }
  }
  return null
}
