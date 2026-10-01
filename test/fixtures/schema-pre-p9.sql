-- Pre-P9 schema (verbatim SCHEMA_SQL from src/db.ts at the pre-P9 commit 3b7b3f6).
-- Used by test/schema-migration.test.ts to simulate a database created by
-- the previous release being opened by the current code.
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
  ip TEXT,
  prev_hash TEXT NOT NULL DEFAULT '',
  row_hash TEXT NOT NULL DEFAULT ''
);
