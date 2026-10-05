import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './db/schema-sqlite'
import {
  buildCompanySearch,
  buildContactSearch,
  buildDealSearch,
} from './lib/helpers'

export type DB = ReturnType<typeof drizzle<typeof schema>>

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emails TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  addresses TEXT NOT NULL DEFAULT '[]',
  companies TEXT NOT NULL DEFAULT '[]',
  linkedin TEXT,
  x TEXT,
  bluesky TEXT,
  telegram TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  owner TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_linkedin ON contacts(linkedin) WHERE linkedin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_x ON contacts(x) WHERE x IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_bluesky ON contacts(bluesky) WHERE bluesky IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_telegram ON contacts(telegram) WHERE telegram IS NOT NULL;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  websites TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  value INTEGER,
  stage TEXT NOT NULL,
  contacts TEXT NOT NULL DEFAULT '[]',
  company TEXT REFERENCES companies(id) ON DELETE SET NULL,
  expected_close TEXT,
  probability INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  owner TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  owner TEXT,
  contact TEXT,
  deal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  contacts TEXT NOT NULL DEFAULT '[]',
  company TEXT,
  deal TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  entity_type, entity_id, content
);

-- Enterprise (spec/enterprise.md P1): identity, tokens, audit.
-- users is the authority for role and token. password_hash is argon2id.
-- tokens stores a SHA-256 hash only (raw token is shown exactly once).
-- audit_log is append-only and carries the hash chain (prev_hash/row_hash)
-- so any tamper is detectable offline (crm audit verify).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  auth_source TEXT NOT NULL DEFAULT 'local',
  password_hash TEXT,
  ldap_dn TEXT,
  role TEXT NOT NULL DEFAULT 'reader',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  source TEXT NOT NULL,
  ip TEXT,
  prev_hash TEXT NOT NULL DEFAULT '',
  row_hash TEXT NOT NULL DEFAULT ''
);
`

/**
 * One handle per resolved path, process-wide.
 *
 * A REPL is one process running many commands, and each command asks for the
 * database by name. Handing out a fresh libSQL client per request would leak
 * a client per line and re-run the whole schema bootstrap per line — the same
 * one-process-many-parses hazard class as commander's shared collecting
 * flags. Memoizing the *promise* also collapses concurrent first opens (the
 * daemon's parallel handlers) into one bootstrap. A failed open is evicted so
 * a retry sees a fresh attempt; one-shot mode opens exactly one db per
 * process and is untouched.
 */
const openDbs = new Map<string, Promise<DB>>()

export function openDB(dbPath: string): Promise<DB> {
  const key = resolve(dbPath)
  let opened = openDbs.get(key)
  if (!opened) {
    opened = openDbFresh(key)
    opened.catch(() => openDbs.delete(key))
    openDbs.set(key, opened)
  }
  return opened
}

async function openDbFresh(dbPath: string): Promise<DB> {
  mkdirSync(dirname(dbPath), { recursive: true })
  const client = createClient({ url: `file:${dbPath}` })

  // Set the busy timeout before the first statement: schema bootstrap DDL
  // (CREATE TABLE etc.) is itself a write and must not fail with
  // SQLITE_BUSY when parallel first-time users race on a fresh database.
  await busyExec(client, 'PRAGMA busy_timeout=30000')

  const db = drizzle(client, { schema })

  // Initialize schema: execute each statement separately since libSQL
  // doesn't support multi-statement exec natively
  const statements = SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const stmt of statements) {
    await busyExec(client, stmt)
  }

  await busyExec(client, 'PRAGMA journal_mode=WAL')
  await busyExec(client, 'PRAGMA foreign_keys=ON')

  await migrateSchema(client)
  await ensureUsernameIndex(client)

  return db
}

/**
 * Execute a statement with manual SQLITE_BUSY retry. The busy_timeout
 * pragma covers ordinary DML, but bootstrap/migration DDL can hit a
 * transient exclusive lock held by a parallel process's schema pass;
 * retrying with backoff keeps the single-writer guarantee without
 * surfacing a spurious lock error to the user.
 */
async function busyExec(
  client: ReturnType<typeof createClient>,
  sql: string,
  attempts = 20,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await client.execute(sql)
      return
    } catch (err) {
      const busy =
        err instanceof Error &&
        /SQLITE_BUSY|database is locked/i.test(err.message)
      if (!busy || i >= attempts - 1) {
        throw err
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50 * 2 ** i, 2000)),
      )
    }
  }
}

/**
 * Migrations for databases created before a column existed. Each ALTER
 * runs at most once; the column check makes the whole pass idempotent
 * and cheap.
 */
async function migrateSchema(
  client: ReturnType<typeof createClient>,
): Promise<void> {
  // Fast path: skip the exclusive-lock ALTER pass only when the schema
  // ALREADY has every current column (a fresh database — SCHEMA_SQL above
  // created them). Emptiness is not evidence of schema shape: a pre-change
  // database whose tables happen to be empty still needs the ALTERs (an
  // empty old db skipping here once crashed the first write on the missing
  // `owner` column). The probes are read-only `LIMIT 0` selects — parsing
  // resolves the column names, execution touches no rows. The ALTER pass
  // is idempotent, so any failed probe simply lets it run.
  const probes: readonly string[] = [
    'SELECT owner, addresses, version, updated_by FROM contacts LIMIT 0',
    'SELECT owner, version, updated_by FROM deals LIMIT 0',
    'SELECT version, updated_by FROM companies LIMIT 0',
    'SELECT prev_hash, row_hash FROM audit_log LIMIT 0',
    'SELECT must_change_password, password_changed_at FROM users LIMIT 0',
  ]
  let current = true
  for (const probe of probes) {
    try {
      await client.execute(probe)
    } catch {
      current = false
      break
    }
  }
  if (current) {
    return
  }
  const migrations: readonly [string, string, string][] = [
    // P3: optimistic locking + actor threading
    ['contacts', 'version', 'version INTEGER NOT NULL DEFAULT 1'],
    ['contacts', 'updated_by', 'updated_by TEXT'],
    ['companies', 'version', 'version INTEGER NOT NULL DEFAULT 1'],
    ['companies', 'updated_by', 'updated_by TEXT'],
    ['deals', 'version', 'version INTEGER NOT NULL DEFAULT 1'],
    ['deals', 'updated_by', 'updated_by TEXT'],
    // P4: audit hash chain
    ['audit_log', 'prev_hash', "prev_hash TEXT NOT NULL DEFAULT ''"],
    ['audit_log', 'row_hash', "row_hash TEXT NOT NULL DEFAULT ''"],
    // CLI ergonomics: first-class addresses on contacts
    ['contacts', 'addresses', "addresses TEXT NOT NULL DEFAULT '[]'"],
    // P9 data model: ownership + follow-up tasks
    ['contacts', 'owner', 'owner TEXT'],
    ['deals', 'owner', 'owner TEXT'],
    // B1: password management (must-change flag + changed-at stamp)
    [
      'users',
      'must_change_password',
      'must_change_password INTEGER NOT NULL DEFAULT 0',
    ],
    ['users', 'password_changed_at', 'password_changed_at TEXT'],
  ]
  const seen = new Set<string>()
  for (const [table] of migrations) {
    if (seen.has(table)) {
      continue
    }
    seen.add(table)
    for (const [, definition] of migrations.filter(([t]) => t === table)) {
      try {
        await busyExec(client, `ALTER TABLE ${table} ADD COLUMN ${definition}`)
      } catch (err) {
        // "duplicate column name" = already migrated — expected. Anything
        // else (including SQLITE_BUSY under contention) must propagate.
        if (
          !(err instanceof Error && /duplicate column name/i.test(err.message))
        ) {
          throw err
        }
      }
    }
  }
}

export async function upsertSearchIndex(
  db: DB,
  entityType: string,
  entityId: string,
  content: string,
): Promise<void> {
  await db.run(sql`DELETE FROM search_index WHERE entity_id = ${entityId}`)
  await db.run(
    sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${entityType}, ${entityId}, ${content})`,
  )
}

/**
 * Usernames are looked up case-insensitively, because the directory that
 * JIT-provisions them matches case-insensitively (LDAP `caseIgnoreMatch`)
 * while SQLite's `UNIQUE` does not. Uniqueness has to be enforced on the
 * lowercase name too, or `alice` and `ALICE` are two accounts and
 * disabling one leaves the other usable.
 *
 * Best-effort by necessity: a database that already holds both spellings
 * cannot accept the index, and refusing to open the database would lock
 * every user out over a row an admin can delete. The conflict is reported
 * instead — and the case-insensitive lookup prefers the disabled row, so
 * the leftover duplicate cannot become the row that authenticates.
 */
async function ensureUsernameIndex(
  client: ReturnType<typeof createClient>,
): Promise<void> {
  try {
    await busyExec(
      client,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(username COLLATE NOCASE)',
    )
  } catch (err) {
    if (
      err instanceof Error &&
      /UNIQUE constraint failed|already contains data/i.test(err.message)
    ) {
      console.warn(
        'Warning: users hold usernames differing only by case, so case-insensitive uniqueness is not enforced. Fix with e.g. `SELECT username FROM users GROUP BY lower(username) HAVING count(*) > 1` — until then a differently-cased duplicate can log in.',
      )
      return
    }
    throw err
  }
}

export async function removeSearchIndex(
  db: DB,
  entityId: string,
): Promise<void> {
  await db.run(sql`DELETE FROM search_index WHERE entity_id = ${entityId}`)
}

export async function rebuildSearchIndex(db: DB): Promise<void> {
  await db.run(sql`DELETE FROM search_index`)

  const allContacts = await db.select().from(schema.contacts)
  for (const c of allContacts) {
    const content = await buildContactSearch(db, c)
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'contact'}, ${c.id}, ${content})`,
    )
  }

  const allCompanies = await db.select().from(schema.companies)
  for (const co of allCompanies) {
    const content = buildCompanySearch(co)
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'company'}, ${co.id}, ${content})`,
    )
  }

  const allDeals = await db.select().from(schema.deals)
  for (const d of allDeals) {
    const content = buildDealSearch(d)
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'deal'}, ${d.id}, ${content})`,
    )
  }

  const allActivities = await db.select().from(schema.activities)
  for (const a of allActivities) {
    const content = [a.type, a.body, a.custom_fields].filter(Boolean).join(' ')
    await db.run(
      sql`INSERT INTO search_index (entity_type, entity_id, content) VALUES (${'activity'}, ${a.id}, ${content})`,
    )
  }
}
