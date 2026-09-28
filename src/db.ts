import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './drizzle-schema'
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
  companies TEXT NOT NULL DEFAULT '[]',
  linkedin TEXT,
  x TEXT,
  bluesky TEXT,
  telegram TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
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
  custom_fields TEXT NOT NULL DEFAULT '{}',
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
-- audit_log is append-only in v1 (hash chain lands in P4).
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
  disabled_at TEXT
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
  ip TEXT
);
`

export async function openDB(dbPath: string): Promise<DB> {
  mkdirSync(dirname(dbPath), { recursive: true })
  const client = createClient({ url: `file:${dbPath}` })
  const db = drizzle(client, { schema })

  // Initialize schema: execute each statement separately since libSQL
  // doesn't support multi-statement exec natively
  const statements = SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const stmt of statements) {
    await client.execute(stmt)
  }

  await client.execute('PRAGMA journal_mode=WAL')
  await client.execute('PRAGMA foreign_keys=ON')
  // P3 write-retry/backoff: SQLite retries internally with backoff up to
  // this window. 5s was not enough for 40 parallel writers under machine
  // load (the db-busy-timeout flake); 30s keeps the single-writer
  // guarantee while letting the queue drain. Normal use never approaches
  // the cap.
  await client.execute('PRAGMA busy_timeout=30000')

  await migrateVersionColumns(client)

  return db
}

/**
 * P3 migration for databases created before the version/updated_by
 * columns existed. Each ALTER runs at most once; the column check makes
 * the whole pass idempotent and cheap (3 tables × 2 columns).
 */
async function migrateVersionColumns(
  client: ReturnType<typeof createClient>,
): Promise<void> {
  const tables = ['contacts', 'companies', 'deals'] as const
  for (const table of tables) {
    const cols = await client
      .execute(`PRAGMA table_info(${table})`)
      .then((r) => r.rows.map((row) => String(row[1])))
    for (const [column, definition] of [
      ['version', 'version INTEGER NOT NULL DEFAULT 1'],
      ['updated_by', 'updated_by TEXT'],
    ] as const) {
      if (!cols.includes(column)) {
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
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
