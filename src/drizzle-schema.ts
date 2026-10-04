import type { InferSelectModel } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emails: text('emails').notNull().default('[]'),
  phones: text('phones').notNull().default('[]'),
  addresses: text('addresses').notNull().default('[]'),
  companies: text('companies').notNull().default('[]'),
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
  // P3: optimistic concurrency — bump on every write; CAS compares it.
  version: integer('version').notNull().default(1),
  // P3: actor threading — which server user last touched this row (null
  // in local single-user mode).
  updated_by: text('updated_by'),
})

export const companies = sqliteTable('companies', {
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

export const deals = sqliteTable('deals', {
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

/**
 * Follow-up tasks (P9): lightweight to-dos that link to a contact and/or
 * deal so "what do I do about Acme today" is answerable from one table.
 */
export const tasks = sqliteTable('tasks', {
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

export const activities = sqliteTable('activities', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  body: text('body').notNull().default(''),
  contacts: text('contacts').notNull().default('[]'),
  company: text('company'),
  deal: text('deal'),
  custom_fields: text('custom_fields').notNull().default('{}'),
  created_at: text('created_at').notNull(),
})

// ── Enterprise (spec/enterprise.md P1) ──

export const users = sqliteTable('users', {
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

export const tokens = sqliteTable('tokens', {
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

export const auditLog = sqliteTable('audit_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
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

export type AuditRow = InferSelectModel<typeof auditLog>
export type User = InferSelectModel<typeof users>
export type ServiceToken = InferSelectModel<typeof tokens>

export type Contact = InferSelectModel<typeof contacts>
export type Company = InferSelectModel<typeof companies>
export type Deal = InferSelectModel<typeof deals>
export type Activity = InferSelectModel<typeof activities>
export type Task = InferSelectModel<typeof tasks>
