/**
 * P5: backup/restore services (litestream).
 *
 * All operations target the process-local database — backups are a
 * server-host concern. Remote clients reach only `backup.status` /
 * `backup.sync` through RPC; `init` / `restore` / `check` stay local so a
 * stray remote token can never write to an operator's replica directory.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { recordAudit, verifyChain } from '../lib/audit'
import { ServiceError } from '../lib/errors'
import { die } from '../lib/helpers'
import {
  configPathFor,
  type Destination,
  parseDestination,
  renderConfig,
  replicaUrl,
  resolveLitestream,
  runLitestream,
} from '../lib/litestream'
import { NEEDS_DB } from '../remote/dispatch'

const AUDIT_ACTIONS = ['backup.init', 'backup.sync', 'backup.restore'] as const

type AuditEvent = (typeof AUDIT_ACTIONS)[number]

/**
 * Every backup operation is about the database this process was pointed at
 * (`--db` / `CRM_DB` / a `[database] path`). There is no default to fall back
 * on, so an unconfigured host says so with the fixed server-host message
 * rather than deriving a litestream config for `undefined`.
 */
function requireDbPath(config: CRMConfig): string {
  if (!config.database.path) {
    die(NEEDS_DB)
  }
  return config.database.path
}

async function audit(
  db: DB,
  action: AuditEvent,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await recordAudit(db, {
      action,
      actor_id: 'backup',
      actor_name: 'backup',
      before_json: null,
      after_json: JSON.stringify(detail),
      source: 'cli-local',
    })
  } catch {
    // audit failure never fails the operation
  }
}

function loadDestination(configPath: string): Destination {
  // read the `path:` / `bucket:`+`prefix:` back out of our own generated
  // config — simpler and safer than parsing arbitrary YAML
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const text = readFileSync(configPath, 'utf8')
  const s3 = text.match(/bucket:\s*(\S+)/)
  if (s3) {
    const prefix = text.match(/prefix:\s*(.*)/)?.[1]?.trim() ?? ''
    return { kind: 's3', bucket: s3[1], prefix }
  }
  const replica = text.match(/^ {6}path:\s*(\S+)/m)
  if (replica) {
    return { kind: 'file', path: replica[1] }
  }
  throw new ServiceError('INVALID', 'backup config is not a crm-managed file')
}

/** `backup init --destination <path|s3://bucket/prefix>`. */
export async function backupInit(
  db: DB,
  config: CRMConfig,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const destination = String(params.destination ?? '')
  const dest = parseDestination(destination)
  const dbPath = requireDbPath(config)
  const configPath = configPathFor(dbPath)
  const bin = resolveLitestream()
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  writeFileSync(configPath, renderConfig(dbPath, dest))
  if (dest.kind === 'file' && dest.path) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dest.path, { recursive: true })
  }
  const res = await runLitestream(bin, [
    'replicate',
    '-once',
    '-force-snapshot',
    '--config',
    configPath,
  ])
  if (res.exitCode !== 0) {
    throw new ServiceError(
      'INTERNAL',
      `litestream init failed (exit ${res.exitCode}): ${tail(res.stderr)}`,
    )
  }
  await audit(db, 'backup.init', { destination, config: configPath })
  return { destination, config: configPath, replica: replicaUrl(dest) }
}

/** `backup sync` — one-shot replication pass. */
export async function backupSync(
  db: DB,
  config: CRMConfig,
  _params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dbPath = requireDbPath(config)
  const configPath = configPathFor(dbPath)
  if (!existsSync(configPath)) {
    throw new ServiceError(
      'INVALID',
      'no backup configured — run `crm backup init --destination <path|s3://...>` first',
    )
  }
  const bin = resolveLitestream()
  const res = await runLitestream(bin, [
    'replicate',
    '-once',
    '--config',
    configPath,
  ])
  if (res.exitCode !== 0) {
    throw new ServiceError(
      'INTERNAL',
      `litestream sync failed (exit ${res.exitCode}): ${tail(res.stderr)}`,
    )
  }
  await audit(db, 'backup.sync', { destination: configPath })
  return { ok: true }
}

interface StatusRow {
  database: string
  local_txid: string
  status: string
  wal_size: string
}

/** `backup status` — per-DB replication status from litestream. */
export async function backupStatus(
  _db: DB,
  config: CRMConfig,
  _params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dbPath = requireDbPath(config)
  const configPath = configPathFor(dbPath)
  if (!existsSync(configPath)) {
    throw new ServiceError(
      'INVALID',
      'no backup configured — run `crm backup init --destination <path|s3://...>` first',
    )
  }
  const bin = resolveLitestream()
  const res = await runLitestream(bin, [
    'status',
    '--config',
    configPath,
    '--json',
  ])
  if (res.exitCode !== 0) {
    throw new ServiceError(
      'INTERNAL',
      `litestream status failed (exit ${res.exitCode}): ${tail(res.stderr)}`,
    )
  }
  let rows: StatusRow[] = []
  try {
    rows = JSON.parse(res.stdout) as StatusRow[]
  } catch {
    throw new ServiceError(
      'INTERNAL',
      `litestream status returned unparseable JSON: ${res.stdout.slice(0, 200)}`,
    )
  }
  return {
    config: configPath,
    databases: rows.map((r) => ({
      database: r.database,
      status: r.status,
      local_txid: r.local_txid ?? null,
      wal_size: r.wal_size ?? null,
    })),
  }
}

/** `backup restore --to <path>` — rebuild a fresh DB from the replica. */
export async function backupRestore(
  db: DB,
  config: CRMConfig,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const to = String(params.to ?? '')
  if (!to) {
    throw new ServiceError('INVALID', 'usage: crm backup restore --to <path>')
  }
  const dbPath = requireDbPath(config)
  const configPath = configPathFor(dbPath)
  if (!existsSync(configPath)) {
    throw new ServiceError(
      'INVALID',
      'no backup configured — run `crm backup init --destination <path|s3://...>` first',
    )
  }
  if (existsSync(to)) {
    throw new ServiceError(
      'CONFLICT',
      `refusing to restore: ${to} already exists`,
    )
  }
  const dest = loadDestination(configPath)
  const bin = resolveLitestream()
  const res = await runLitestream(bin, ['restore', '-o', to, replicaUrl(dest)])
  if (res.exitCode !== 0) {
    throw new ServiceError(
      'INTERNAL',
      `litestream restore failed (exit ${res.exitCode}): ${tail(res.stderr)}`,
    )
  }
  await audit(db, 'backup.restore', { to, replica: replicaUrl(dest) })
  return { to }
}

/** `backup check` — restore to a temp file, verify chain, compare counts. */
export async function backupCheck(
  db: DB,
  config: CRMConfig,
  _params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dbPath = requireDbPath(config)
  const configPath = configPathFor(dbPath)
  if (!existsSync(configPath)) {
    throw new ServiceError(
      'INVALID',
      'no backup configured — run `crm backup init --destination <path|s3://...>` first',
    )
  }
  const dest = loadDestination(configPath)
  const bin = resolveLitestream()
  const tmp = mkdtempSync(join(tmpdir(), 'crm-backup-check-'))
  try {
    const to = join(tmp, 'check.db')
    const res = await runLitestream(bin, [
      'restore',
      '-o',
      to,
      replicaUrl(dest),
    ])
    if (res.exitCode !== 0) {
      throw new ServiceError(
        'INTERNAL',
        `litestream restore failed (exit ${res.exitCode}): ${tail(res.stderr)}`,
      )
    }
    const restored = rawClient(to)
    try {
      const v = await verifyChain(wrapper(restored))
      if (!v.ok) {
        throw new ServiceError(
          'INTERNAL',
          `backup check failed: ${v.reason ?? 'chain broken'}`,
        )
      }
      const counts = await rawCounts(restored, [
        'contacts',
        'companies',
        'deals',
      ])
      const live = (db as unknown as { $client: RawClient }).$client
      const liveCounts = await rawCounts(live, [
        'contacts',
        'companies',
        'deals',
      ])
      const stale = Object.entries(counts).filter(
        ([k, n]) => n !== liveCounts[k],
      )
      return {
        ok: stale.length === 0,
        rows: counts,
        liveRows: liveCounts,
        note:
          stale.length === 0
            ? 'backup matches live database'
            : `restored replica is missing ${stale.map(([t, n]) => `${t} (${n} rows)`).join(', ')} — run \`crm backup sync\` to catch up`,
      }
    } finally {
      restored.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

interface RawClient {
  close: () => void
  execute: (sql: string) => Promise<{ rows: unknown[] }>
}

function rawClient(dbPath: string): RawClient {
  const { createClient } =
    require('@libsql/client') as typeof import('@libsql/client')
  return createClient({ url: `file:${dbPath}` }) as unknown as RawClient
}

function wrapper(client: RawClient): DB {
  return { $client: client } as unknown as DB
}

async function rawCounts(
  client: RawClient,
  tables: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of tables) {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM ${t}`)
    out[t] = Number(String((r.rows[0] as Record<string, unknown>).n))
  }
  return out
}

function tail(s: string, n = 300): string {
  const t = s.trim()
  return t.length > n ? `…${t.slice(-n)}` : t
}
