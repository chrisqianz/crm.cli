import { integer, pgTable, text } from 'drizzle-orm/pg-core'

import * as contract from './schema'

/**
 * Schema version, single source in ./schema (same constant the sqlite
 * dialect re-exports).
 */
export const schemaVersion = contract.schemaVersion

/**
 * AL-1 PostgreSQL dialect of the physical schema
 * (spec/alignment.md §3).
 *
 * Declared separately from `schema-sqlite.ts` because drizzle's
 * builder types are dialect-bound — a generic table builder does not
 * preserve concrete column types, and a
 * `LibsqlDB | NodePgDatabase` union does not type-check either
 * (both spike-verified). `test/enterprise/schema-parity.test.ts`
 * locks the two declarations to the contract in `./schema` so the
 * physical schemas cannot drift.
 *
 * Type notes:
 * - JSON array columns are TEXT here too — the service layer
 *   round-trips them as strings; JSONB arrives with AL-6.
 * - `must_change_password` stays INTEGER on purpose: the service
 *   layer does 0/1 integer round-trips, a pg BOOLEAN would change
 *   the wire/JSON shape (true vs 1) and break the byte-identical
 *   regression.
 */

export const contacts = pgTable('contacts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emails: text('emails').notNull().default('[]'),
  phones: text('phones').notNull().default('[]'),
  addresses: text('addresses').notNull().default('[]'),
  companies: text('companies').notNull().default('[]'),
  // Social handles are unique via PARTIAL indexes (WHERE col IS NOT
  // NULL) — created by the pg DDL in AL-1-2, mirroring SCHEMA_SQL.
  linkedin: text('linkedin'),
  x: text('x'),
  bluesky: text('bluesky'),
  telegram: text('telegram'),
  tags: text('tags').notNull().default('[]'),
  /** Assigned owner (a username). Null = unassigned. */
  owner: text('owner'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
  version: integer('version').notNull().default(1),
  updated_by: text('updated_by'),
})

export const companies = pgTable('companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  websites: text('websites').notNull().default('[]'),
  phones: text('phones').notNull().default('[]'),
  tags: text('tags').notNull().default('[]'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
  version: integer('version').notNull().default(1),
  updated_by: text('updated_by'),
})

export const deals = pgTable('deals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  value: integer('value'),
  stage: text('stage').notNull(),
  contacts: text('contacts').notNull().default('[]'),
  company: text('company'),
  expected_close: text('expected_close'),
  probability: integer('probability'),
  tags: text('tags').notNull().default('[]'),
  /** Assigned owner (a username). Null = unassigned. */
  owner: text('owner'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
  version: integer('version').notNull().default(1),
  updated_by: text('updated_by'),
})

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  /** ISO timestamp or null (no deadline). */
  due_at: text('due_at'),
  /** open | done */
  status: text('status').notNull().default('open'),
  /** Assigned owner (a username). Null = unassigned. */
  owner: text('owner'),
  contact: text('contact'),
  deal: text('deal'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
  version: integer('version').notNull().default(1),
  updated_by: text('updated_by'),
})

export const activities = pgTable('activities', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  body: text('body').notNull().default(''),
  contacts: text('contacts').notNull().default('[]'),
  company: text('company'),
  deal: text('deal'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
})

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  display_name: text('display_name'),
  email: text('email'),
  auth_source: text('auth_source').notNull().default('local'),
  password_hash: text('password_hash'),
  ldap_dn: text('ldap_dn'),
  role: text('role').notNull().default('reader'),
  failed_attempts: integer('failed_attempts').notNull().default(0),
  locked_until: text('locked_until'),
  created_at: text('created_at').notNull(),
  disabled_at: text('disabled_at'),
  must_change_password: integer('must_change_password').notNull().default(0),
  password_changed_at: text('password_changed_at'),
})

export const tokens = pgTable('tokens', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull().unique(),
  scopes: text('scopes').notNull().default('[]'),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at'),
  last_used_at: text('last_used_at'),
})

export const auditLog = pgTable('audit_log', {
  seq: integer('seq').primaryKey().generatedAlwaysAsIdentity(),
  at: text('at').notNull(),
  actor_id: text('actor_id').notNull(),
  actor_name: text('actor_name').notNull(),
  action: text('action').notNull(),
  entity_type: text('entity_type'),
  entity_id: text('entity_id'),
  before_json: text('before_json'),
  after_json: text('after_json'),
  source: text('source').notNull(),
  ip: text('ip'),
  prev_hash: text('prev_hash').notNull().default(''),
  row_hash: text('row_hash').notNull().default(''),
})

/** All tables keyed by PHYSICAL table name (mirrors schema-sqlite.ts). */
export const tables = {
  contacts,
  companies,
  deals,
  tasks,
  activities,
  users,
  tokens,
  audit_log: auditLog,
}
