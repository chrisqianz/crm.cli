/**
 * Audit service — `crm audit list/verify/export`, shared by local and
 * remote mode. The chain itself lives in src/lib/audit.ts.
 */
import { and, desc, eq, gt } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import * as schema from '../drizzle-schema'
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
  db: DB,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const limit = parseLimit(p.limit, 50)
  const actor = p.actor as string | undefined
  const action = p.action as string | undefined
  const entity = p.entity as string | undefined
  const since = p.since as string | undefined

  const filters = [
    actor ? eq(schema.auditLog.actor_name, actor) : null,
    action ? eq(schema.auditLog.action, action) : null,
    entity ? eq(schema.auditLog.entity_id, entity) : null,
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
  return { rows: rows as unknown as Record<string, unknown>[] }
}

export async function auditVerify(
  db: DB,
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
  db: DB,
  _config: CRMConfig,
  _p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .orderBy(schema.auditLog.seq)
  return { rows: rows as unknown as Record<string, unknown>[] }
}
