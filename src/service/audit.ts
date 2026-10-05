/**
 * Audit service — `crm audit list/verify/export`, shared by local and
 * remote mode. The chain itself lives in src/lib/audit.ts.
 */
import { and, desc, eq, gt, like } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { CrmDb } from '../db/seam'
import { verifyChain } from '../lib/audit'
import { ServiceError } from '../lib/errors'

function parseLimit(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') {
    return fallback
  }
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0 || n > 10_000) {
    throw new ServiceError(
      'INVALID',
      'Error: --limit must be a positive integer (max 10000)',
    )
  }
  return n
}

export async function auditList(
  db: CrmDb,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const schema = db.$crm.schema

  const limit = parseLimit(p.limit, 50)
  const actor = p.actor as string | undefined
  const action = p.action as string | undefined
  const entity = p.entity as string | undefined
  const entityType = p.entity_type as string | undefined
  const since = p.since as string | undefined

  const filters = [
    actor ? eq(schema.auditLog.actor_name, actor) : null,
    action ? eq(schema.auditLog.action, action) : null,
    entity ? eq(schema.auditLog.entity_id, entity) : null,
    entityType ? like(schema.auditLog.entity_type, `%${entityType}%`) : null,
    since ? gt(schema.auditLog.at, since) : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null)

  const rows =
    filters.length > 0
      ? await db
          .select()
          .from(schema.auditLog)
          .where(and(...filters))
          .orderBy(desc(schema.auditLog.seq))
          .$dynamic()
          .limit(limit)
      : await db
          .select()
          .from(schema.auditLog)
          .orderBy(desc(schema.auditLog.seq))
          .$dynamic()
          .limit(limit)
  // SAFETY: auditLog rows are the audit_log table's column map, which is
  // structurally string-keyed; the generic service boundary needs plain
  // records so the CLI/console can render them without schema imports.
  return { rows: rows as unknown as Record<string, unknown>[] }
}

export async function auditVerify(
  db: CrmDb,
  _config: CRMConfig,
  _p: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await verifyChain(db)
  return {
    ok: result.ok,
    legacy: result.legacy,
    chained: result.chained,
    genesis_seq: result.genesisSeq,
    broken_seq: result.brokenSeq,
    reason: result.reason,
  }
}

/** Export = the full chain (no limit), for json/csv consumers. */
export async function auditExport(
  db: CrmDb,
  _config: CRMConfig,
  _p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const schema = db.$crm.schema

  const rows = await db
    .select()
    .from(schema.auditLog)
    .orderBy(schema.auditLog.seq)
  // SAFETY: same column-map invariant as auditList — see that comment.
  return { rows: rows as unknown as Record<string, unknown>[] }
}

function parseSeq(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) {
    throw new ServiceError(
      'INVALID',
      'Error: audit row id must be a positive integer seq',
    )
  }
  return n
}

/** One audit row by chain seq, for the diff view (B4). */
export async function auditGet(
  db: CrmDb,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ row: Record<string, unknown> }> {
  const schema = db.$crm.schema

  const seq = parseSeq(p.seq)
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.seq, seq))
    .limit(1)
  if (rows.length === 0) {
    throw new ServiceError('NOT_FOUND', `audit row seq ${seq} not found`)
  }
  // SAFETY: same column-map invariant as auditList — see that comment.
  return { row: rows[0] as unknown as Record<string, unknown> }
}
