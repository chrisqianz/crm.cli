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
import * as entitySchema from '../drizzle-schema'
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
 * Row access across libsql surface differences: a plain object row
 * (local file transactions) or a libsql Row with .get()/index access.
 */
function rowValue(row: unknown, key: string, index: number): unknown {
  const r = row as Record<string, unknown> & {
    get?: (i: number) => unknown
  }
  if (typeof r[key] !== 'undefined') {
    return r[key]
  }
  if (typeof r.get === 'function') {
    return r.get(index)
  }
  return (row as unknown as unknown[])[index]
}

/**
 * Append one audit row to the chain. Runs inside a write transaction so
 * concurrent writers (multiple CLI processes, RPC connections) cannot
 * fork the chain: the read of the previous hash and the insert happen
 * under the same write lock.
 */
export async function recordAudit(db: DB, e: AuditEvent): Promise<void> {
  const client = (
    db as unknown as {
      $client: { transaction(mode: string): Promise<TransactionLike> }
    }
  ).$client
  // 'write' acquires the SQLite write lock immediately (the closest thing
  // to EXCLUSIVE in libsql's modes), so the prev-hash read and the insert
  // cannot interleave with another writer.
  const tx = await client.transaction('write')
  try {
    const last = await tx.execute(
      `SELECT row_hash FROM audit_log WHERE row_hash != '' ORDER BY seq DESC LIMIT 1`,
    )
    const prevHash =
      last.rows.length > 0
        ? String(rowValue(last.rows[0], 'row_hash', 0))
        : AUDIT_GENESIS_HASH
    const at = new Date().toISOString()
    await tx.execute(
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
    // the transaction result set carries no lastInsertRowid, so read the
    // row back by its deterministic fields (inside this write-locked tx)
    const ins = await tx.execute(
      'SELECT seq FROM audit_log WHERE at = ? AND action = ? AND prev_hash = ? ORDER BY seq DESC LIMIT 1',
      [at, e.action, prevHash],
    )
    const seq = Number(String(rowValue(ins.rows[0], 'seq', 0)))
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
    await tx.execute('UPDATE audit_log SET row_hash = ? WHERE seq = ?', [
      rowHash,
      seq,
    ])
    await tx.commit()
  } catch (err) {
    await tx.rollback()
    throw err
  }
}

/** Minimal structural shape of a libsql result set / transaction. */
interface ExecuteResult {
  columns: string[]
  rows: Array<{ get(i: number): unknown }>
}

interface TransactionLike {
  commit(): Promise<void>
  execute(sql: string, args?: unknown[]): Promise<ExecuteResult>
  rollback(): Promise<void>
}

interface ExecuteClient {
  execute(sql: string, args?: unknown[]): Promise<ExecuteResult>
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
export async function verifyChain(db: DB): Promise<VerifyResult> {
  const client = (db as unknown as { $client: ExecuteClient }).$client
  const r = await client.execute(
    `SELECT seq, at, actor_id, actor_name, action, entity_type, entity_id,
            before_json, after_json, source, ip, prev_hash, row_hash
     FROM audit_log ORDER BY seq`,
  )
  const cols = r.columns
  const rows = r.rows.map((row) => {
    const o: Record<string, unknown> = {}
    cols.forEach((c, i) => {
      o[c] = rowValue(row, c, i)
    })
    return o as unknown as AuditRowValues & { row_hash: string }
  })

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
      return rows[0] as unknown as Record<string, unknown>
    }
  }
  return null
}
