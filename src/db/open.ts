import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'

import type { CRMConfig } from '../config'
import { openDB } from '../db'
import { postgresRaw } from './raw-postgres'
import { type ColumnSpec, TABLES, type TableSpec } from './schema'
import { tables as pgTables } from './schema-pg'
import type { CrmDb, CrmSeam } from './seam'

/**
 * The open seam (AL-1-2, spec/alignment.md D1).
 *
 * One entry point decides WHICH server holds the database and hands back a
 * handle that carries `$crm` (see `src/db/seam.ts`). Nothing else in the
 * codebase constructs a driver: `serve` and the local commands keep calling
 * `openDB` for now — wiring them through here is AL-1-6, once the service
 * layer stops naming libsql at every call site.
 *
 * Two rules worth stating because they are load-bearing:
 *
 * - The postgres schema is GENERATED from the shared contract
 *   (`src/db/schema.ts`), not hand-mirrored. A handwritten mirror drifts
 *   silently the first time a column is added; generated DDL can only drift
 *   if the generator itself is wrong, and `test/enterprise/postgres-open.test.ts`
 *   compares every generated column against `information_schema`.
 * - No migration path runs here. A postgres database is bootstrapped fresh;
 *   existing sqlite data arrives through `crm migrate export` (AL-1-7), which
 *   keeps this module free of sqlite-era history.
 */

/** Configured backend. Unknown strings pass through so validation can name them. */
export function resolveBackend(config: CRMConfig): string {
  const configured = config.database.backend
  if (configured) {
    return configured
  }
  // A url with no backend stated is an instruction, not a hint.
  return config.database.url ? 'postgres' : 'sqlite'
}

/**
 * Boot-time contract for the `[database]` section. Returns a message that
 * tells an operator what to type, or null when the config is openable.
 *
 * Kept pure (no driver import) so it is testable without a server: refusing
 * to start is the behaviour that protects a deployment from a typo.
 */
export function validateDatabaseConfig(config: CRMConfig): string | null {
  const backend = resolveBackend(config)
  if (backend === 'postgres') {
    if (!config.database.url) {
      return [
        'database backend "postgres" needs database.url.',
        'Add it to [database]:',
        '  url = "postgres://crm:crm@127.0.0.1:5432/crm"',
        'or set CRM_DATABASE_URL.',
      ].join('\n')
    }
    return null
  }
  if (backend === 'sqlite') {
    // An entirely unconfigured [database] is not a contradiction: local mode
    // resolves its file elsewhere (--db / CRM_DB / the ~/.crm default), so this
    // function judges only what the config actually asserts. A section that
    // SAYS sqlite and names no file is a typo worth refusing over.
    if (config.database.backend === 'sqlite' && !config.database.path) {
      return [
        'database backend "sqlite" needs a file path.',
        'Pass --db <path>, set CRM_DB, or set [database] path.',
        'A machine talking to a central server should set [remote] and log in instead.',
      ].join('\n')
    }
    return null
  }
  return `unknown database backend "${backend}" — expected "sqlite" or "postgres"`
}

/** Column kinds map 1:1; JSON-ish columns are TEXT on both dialects by contract. */
const PG_TYPES: Record<ColumnSpec['kind'], string> = {
  boolean: 'boolean',
  integer: 'integer',
  text: 'text',
  timestamp: 'timestamp with time zone',
}

interface ForeignKey {
  onDelete: 'cascade' | 'set null'
  table: string
}

/**
 * Per-dialect DDL the contract deliberately does not carry: foreign keys are
 * declared per column, keyed by PHYSICAL table name (both `deals` and `tasks`
 * have a `company` column — only deals references companies).
 */
const FOREIGN_KEYS: Record<string, Record<string, ForeignKey>> = {
  deals: { company: { onDelete: 'set null', table: 'companies' } },
  tokens: { user_id: { onDelete: 'cascade', table: 'users' } },
}

/**
 * Social columns on contacts are unique-with-partial-index in sqlite
 * (`WHERE col IS NOT NULL`) so that many contacts may omit a handle. Same
 * semantics here, spelled the same way; it is parity surface the contract
 * records nowhere, so it is asserted in the postgres test.
 */
const PARTIAL_UNIQUE: Record<string, string[]> = {
  contacts: ['linkedin', 'x', 'bluesky', 'telegram'],
}

function defaultLiteral(value: string, kind: ColumnSpec['kind']): string {
  if (kind === 'integer') {
    return value
  }
  // Text literals are accepted for every other kind: postgres coerces the
  // unknown-typed literal to the column type (so '0' is a valid boolean).
  return `'${value.replaceAll("'", "''")}'`
}

function columnDdl(table: TableSpec, column: ColumnSpec): string {
  const parts = [`"${column.name}" ${PG_TYPES[column.kind]}`]
  if (column.serial) {
    parts.push('GENERATED ALWAYS AS IDENTITY')
  }
  // PRIMARY KEY and IDENTITY already imply NOT NULL; spelling it out again
  // after IDENTITY is a constraint order postgres does not accept.
  if (column.primary) {
    parts.push('PRIMARY KEY')
  }
  if (column.unique && !column.primary) {
    parts.push('UNIQUE')
  }
  if (column.notNull && !column.primary && !column.serial) {
    parts.push('NOT NULL')
  }
  const reference = FOREIGN_KEYS[table.name]?.[column.name]
  if (reference) {
    const action = reference.onDelete.toUpperCase()
    parts.push(`REFERENCES "${reference.table}"("id") ON DELETE ${action}`)
  }
  if (column.default !== null && !column.serial) {
    parts.push(`DEFAULT ${defaultLiteral(column.default, column.kind)}`)
  }
  return `  ${parts.join(' ')}`
}

function createTable(table: TableSpec): string {
  const columns = table.columns
    .map((column) => columnDdl(table, column))
    .join(',\n')
  return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n${columns}\n)`
}

/**
 * Statements that must all succeed for the database to be usable. Executed in
 * one transaction — postgres rolls DDL back too, so a failed bootstrap leaves
 * no half-built schema to guess about.
 */
export const SCHEMA_SQL_PG: string[] = Object.values(TABLES).map(createTable)

/**
 * Statements that adapt to existing data instead of failing the bootstrap.
 * sqlite enforces username uniqueness case-insensitively through
 * `COLLATE NOCASE`; the equivalent here is a `lower()` expression index,
 * which fails on a table that already holds 'Bob' and 'bob' — a pre-existing
 * conflict, not a reason to refuse to start.
 */
export const SCHEMA_SQL_PG_BEST_EFFORT: string[] = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users (lower(username))',
]

/**
 * Tables that exist for one dialect only. sqlite gets an FTS5 virtual table;
 * postgres gets the same-named plain table plus the generated `tsv` column and
 * the GIN index that make it searchable — `to_tsvector('simple', …)` is the
 * closest equivalent to fts5's `unicode61` tokenizer, which likewise does no
 * stemming or stopword removal, so a query answered by one engine is answered
 * by the other.
 *
 * `content` stays nullable and `coalesce` keeps the generated expression
 * immutable-safe: the sqlite side indexes empty strings rather than nulls, and
 * `to_tsvector` rejects null input outright.
 */
export const SCHEMA_SQL_PG_EXTRA: string[] = [
  "CREATE TABLE IF NOT EXISTS search_index (entity_type text, entity_id text, content text, tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED)",
  'CREATE INDEX IF NOT EXISTS idx_search_index_tsv ON search_index USING gin (tsv)',
  ...Object.entries(PARTIAL_UNIQUE).flatMap(([table, columns]) =>
    columns.map(
      (column) =>
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_${table}_${column}" ON "${table}" ("${column}") WHERE "${column}" IS NOT NULL`,
    ),
  ),
]

/** Create the contract schema on a postgres database. Idempotent. */
export async function bootstrapPgSchema(seam: CrmSeam): Promise<void> {
  const statements = [...SCHEMA_SQL_PG, ...SCHEMA_SQL_PG_EXTRA]
  await seam.raw.transaction(async (tx) => {
    for (const sql of statements) {
      await tx.query(sql)
    }
  })
  for (const sql of SCHEMA_SQL_PG_BEST_EFFORT) {
    try {
      await seam.raw.query(sql)
    } catch (error) {
      console.warn(`[db] postgres index skipped: ${(error as Error).message}`)
    }
  }
}

/**
 * A postgres database as the service layer sees it: the four query verbs, the
 * seam, and the pool (kept so `closeDatabase` can end it — a pool otherwise
 * holds the event loop open).
 */
export interface PostgresHandle extends CrmDb {
  readonly pool: Pool
}

/**
 * Bind a live pool into the handle shape the service layer consumes.
 *
 * SAFETY: this is the ONE assertion in the seam — everywhere else the types
 * are derived. `CrmDb`'s verbs are typed against the sqlite table namespace
 * (`CrmTables`) because drizzle binds column types to a dialect module and a
 * union of two db instance types does not type-check (both verified by spike).
 * What is handed back here is drizzle's POSTGRES builder over `schema-pg`,
 * which declares the same columns with the same `text()`/`integer()` scalars,
 * so both drivers return identical row shapes and the same query source
 * compiles to valid SQL on either server. Two things keep the claim honest:
 * `CrmDb` exposes only the four verbs that exist on both dialects (no
 * `onConflictDoUpdate`, no `db.run`), and `test/enterprise/postgres-open.test.ts`
 * runs builder queries against a real server rather than trusting the cast.
 */
function pgHandle(pool: Pool): PostgresHandle {
  const seam = {
    dialect: 'postgres',
    raw: postgresRaw(pool),
    schema: pgTables,
  }
  const builder = drizzlePg(pool, { schema: pgTables })
  // SAFETY: asserted, not derived — `CrmDb`'s verbs are typed against the sqlite
  // table namespace because drizzle binds column types to a dialect module, while
  // this is drizzle's POSTGRES builder over `schema-pg`. Both declarations use the
  // same text()/integer() scalars, so the row shapes the verbs resolve to are
  // identical on either server. See the function doc comment for what checks it.
  return Object.assign(builder, {
    $crm: seam,
    pool,
  }) as unknown as PostgresHandle
}

/**
 * One pool per url, mirroring `openDB`'s one-connection-per-path memo in
 * `src/db.ts`. Two pools against one url means two connection budgets and a
 * service layer that can starve itself.
 */
const pgDbs = new Map<string, Promise<PostgresHandle>>()

async function openPgDb(url: string): Promise<PostgresHandle> {
  // Loaded on demand: a sqlite-only install should not pay for the postgres
  // driver on every command.
  const { Pool: PoolCtor } = await import('pg')
  // keepAlive is not a micro-optimisation: Docker/K8s NAT and load balancers
  // drop idle TCP mappings silently, and the client only finds out on the next
  // query, as "Connection terminated unexpectedly". TCP keepalive keeps the
  // mapping (and the session) alive across an idle CRM server. `docker` port
  // forwarding in tests hits exactly this path.
  const pool = new PoolCtor({
    connectionString: url,
    max: 10,
    keepAlive: true,
  })
  // node-postgres emits 'error' on the pool when an idle client dies — a
  // database restart, a firewall dropping the socket, a `pg_terminate_backend`.
  // With no listener that emit is an uncaught exception, so a transient
  // connection loss would take the whole CRM server down. The pool heals
  // itself: the next query opens a fresh client. Say so, keep the url out of
  // the line (it is a credential), and stay up.
  pool.on('error', (error: Error) => {
    console.warn(
      `[db] a postgres connection died; the pool will replace it: ${error.message}`,
    )
  })
  const handle = pgHandle(pool)
  try {
    await bootstrapPgSchema(handle.$crm)
  } catch (error) {
    // A pool pointing at a database that refused the schema is not a usable
    // memo entry — release it and let the next attempt start over.
    await handle.pool.end().catch(() => undefined)
    throw error
  }
  return handle
}

/**
 * Open whatever backend the config selects.
 *
 * Never throws synchronously: a bad database section and a database that
 * refuses to open are both async failures, so a caller can `await` one way and
 * `catch` one way. The alternative (throw now, reject later) is the kind of
 * seam that only shows up in the one caller written three months from now.
 */
export function openDatabase(config: CRMConfig): Promise<CrmDb> {
  const problem = validateDatabaseConfig(config)
  if (problem) {
    return Promise.reject(new Error(problem))
  }
  if (resolveBackend(config) === 'postgres') {
    return openPgPool(config.database.url as string)
  }
  const path = config.database.path
  if (!path) {
    // Validation lets an unasserted [database] through (local mode resolves it
    // elsewhere); opening a database is not "elsewhere", so refuse here rather
    // than hand `undefined` to a driver.
    return Promise.reject(
      new Error(
        'cannot open a database: no path configured. Pass --db <path>, set CRM_DB, ' +
          'or point [database] url at a postgres server.',
      ),
    )
  }
  return openDB(path)
}

/**
 * One pool per url, mirroring openDB's per-path memo: two pools against one
 * server are two connection budgets and two bootstrap passes for no benefit.
 */
function openPgPool(url: string): Promise<PostgresHandle> {
  const existing = pgDbs.get(url)
  if (existing) {
    return existing
  }
  const pending = openPgDb(url)
  pgDbs.set(url, pending)
  // A rejected promise left in the map poisons every later open AND reports
  // an unhandled rejection, so evict on failure.
  pending.catch(() => {
    if (pgDbs.get(url) === pending) {
      pgDbs.delete(url)
    }
  })
  return pending
}

/**
 * Release the pool for `url`. Exposed because a pool keeps the event loop
 * alive: without this, any test (or one-shot command) that touched postgres
 * would hang instead of exiting.
 */
export async function closeDatabase(url: string): Promise<void> {
  const pending = pgDbs.get(url)
  if (!pending) {
    return
  }
  pgDbs.delete(url)
  const handle = await pending.catch(() => undefined)
  if (handle) {
    await handle.pool.end()
  }
}

/** Release every pooled postgres database. */
export async function closeAllDatabases(): Promise<void> {
  for (const url of [...pgDbs.keys()]) {
    await closeDatabase(url)
  }
}
