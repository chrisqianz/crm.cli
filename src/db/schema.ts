/**
 * Shared physical-schema contract (AL-1, spec/alignment.md §3).
 *
 * The same logical database is declared per dialect —
 * `src/db/schema-sqlite.ts` (drizzle `sqliteTable`) and
 * `src/db/schema-pg.ts` (drizzle `pgTable`) — because drizzle's
 * builder types are dialect-bound (a generic table-builder does not
 * preserve concrete column types; a union of the two db instance
 * types does not type-check either — both verified by spike).
 *
 * This module is the single source of truth for WHAT the database
 * looks like: table names, column names, nullability, defaults,
 * primary keys, and unique markers. Both dialect modules carry
 * `schemaVersion`; `test/enterprise/schema-parity.test.ts` locks the
 * two declarations to this contract so the physical schemas cannot
 * drift apart (the CI parity gate, docker-free).
 *
 * Type note: JSON array columns are TEXT on BOTH dialects in AL-1 —
 * the service layer round-trips them as strings
 * (`JSON.stringify` write / `safeJSON` read). JSONB readback returns
 * parsed objects and would break that path; JSONB arrives with the
 * AL-6 relational migration that needs it.
 */
export const schemaVersion = 1
/** One physical column, dialect-neutral. */
export interface ColumnSpec {
  default: string | null
  kind: 'text' | 'integer' | 'boolean' | 'timestamp'
  name: string
  notNull: boolean
  primary: boolean
  serial: boolean
  unique: boolean
}
/** One physical table, dialect-neutral. */
export interface TableSpec {
  columns: ColumnSpec[]
  name: string
  /**
   * Column names with a unique constraint (covers both the
   * `UNIQUE` column marker and a single-column UNIQUE INDEX; partial
   * / expression indexes are dialect DDL detail, not parity surface).
   */
  uniqueColumns: string[]
}
const c = (
  name: string,
  kind: ColumnSpec['kind'],
  notNull: boolean,
  opts: {
    default?: string | null
    primary?: boolean
    unique?: boolean
    serial?: boolean
  } = {},
): ColumnSpec => ({
  name,
  kind,
  notNull,
  default: opts.default ?? null,
  primary: opts.primary ?? false,
  unique: opts.unique ?? false,
  serial: opts.serial ?? false,
})
export const TABLES = {
  contacts: {
    name: 'contacts',
    // The social handles carry UNIQUE PARTIAL INDEXES (WHERE col IS NOT NULL)
    // on both dialects — that is a DDL detail (AL-1-2 pg DDL / SCHEMA_SQL),
    // not a column-level parity surface, so uniqueColumns stays empty here.
    uniqueColumns: [],
    columns: [
      c('id', 'text', true, { primary: true }),
      c('name', 'text', true),
      c('emails', 'text', true, { default: '[]' }),
      c('phones', 'text', true, { default: '[]' }),
      c('addresses', 'text', true, { default: '[]' }),
      c('companies', 'text', true, { default: '[]' }),
      c('linkedin', 'text', false),
      c('x', 'text', false),
      c('bluesky', 'text', false),
      c('telegram', 'text', false),
      c('tags', 'text', true, { default: '[]' }),
      c('owner', 'text', false),
      c('custom_fields', 'text', true, { default: '{}' }),
      c('created_at', 'text', true),
      c('updated_at', 'text', true),
      c('version', 'integer', true, { default: '1' }),
      c('updated_by', 'text', false),
    ],
  },
  companies: {
    name: 'companies',
    uniqueColumns: [],
    columns: [
      c('id', 'text', true, { primary: true }),
      c('name', 'text', true),
      c('websites', 'text', true, { default: '[]' }),
      c('phones', 'text', true, { default: '[]' }),
      c('tags', 'text', true, { default: '[]' }),
      c('custom_fields', 'text', true, { default: '{}' }),
      c('created_at', 'text', true),
      c('updated_at', 'text', true),
      c('version', 'integer', true, { default: '1' }),
      c('updated_by', 'text', false),
    ],
  },
  deals: {
    name: 'deals',
    uniqueColumns: [],
    columns: [
      c('id', 'text', true, { primary: true }),
      c('title', 'text', true),
      c('value', 'integer', false),
      c('stage', 'text', true),
      c('contacts', 'text', true, { default: '[]' }),
      c('company', 'text', false),
      c('expected_close', 'text', false),
      c('probability', 'integer', false),
      c('tags', 'text', true, { default: '[]' }),
      c('owner', 'text', false),
      c('custom_fields', 'text', true, { default: '{}' }),
      c('created_at', 'text', true),
      c('updated_at', 'text', true),
      c('version', 'integer', true, { default: '1' }),
      c('updated_by', 'text', false),
    ],
  },
  tasks: {
    name: 'tasks',
    uniqueColumns: [],
    columns: [
      c('id', 'text', true, { primary: true }),
      c('title', 'text', true),
      c('due_at', 'text', false),
      c('status', 'text', true, { default: 'open' }),
      c('owner', 'text', false),
      c('contact', 'text', false),
      c('deal', 'text', false),
      c('created_at', 'text', true),
      c('updated_at', 'text', true),
      c('version', 'integer', true, { default: '1' }),
      c('updated_by', 'text', false),
    ],
  },
  activities: {
    name: 'activities',
    uniqueColumns: [],
    columns: [
      c('id', 'text', true, { primary: true }),
      c('type', 'text', true),
      c('body', 'text', true, { default: '' }),
      c('contacts', 'text', true, { default: '[]' }),
      c('company', 'text', false),
      c('deal', 'text', false),
      c('custom_fields', 'text', true, { default: '{}' }),
      c('created_at', 'text', true),
    ],
  },
  users: {
    name: 'users',
    uniqueColumns: ['username'],
    columns: [
      c('id', 'text', true, { primary: true }),
      c('username', 'text', true, { unique: true }),
      c('display_name', 'text', false),
      c('email', 'text', false),
      c('auth_source', 'text', true, { default: 'local' }),
      c('password_hash', 'text', false),
      c('ldap_dn', 'text', false),
      c('role', 'text', true, { default: 'reader' }),
      c('failed_attempts', 'integer', true, { default: '0' }),
      c('locked_until', 'text', false),
      c('created_at', 'text', true),
      c('disabled_at', 'text', false),
      // INTEGER on both dialects on purpose: the service layer does
      // integer 0/1 round-trips on this flag, so a pg BOOLEAN would
      // change the wire/JSON shape (true vs 1) and break the
      // byte-identical regression. (Baseline prefers BOOLEAN; AL-1 keeps
      // INTEGER to make the driver switch a pure transport change.)
      c('must_change_password', 'integer', true, { default: '0' }),
      c('password_changed_at', 'text', false),
    ],
  },
  tokens: {
    name: 'tokens',
    uniqueColumns: ['token_hash'],
    columns: [
      c('id', 'text', true, { primary: true }),
      c('user_id', 'text', true),
      c('name', 'text', true),
      c('token_hash', 'text', true, { unique: true }),
      c('scopes', 'text', true, { default: '[]' }),
      c('created_at', 'text', true),
      c('expires_at', 'text', false),
      c('last_used_at', 'text', false),
    ],
  },
  auditLog: {
    name: 'audit_log',
    uniqueColumns: [],
    columns: [
      c('seq', 'integer', true, { primary: true, serial: true }),
      c('at', 'text', true),
      c('actor_id', 'text', true),
      c('actor_name', 'text', true),
      c('action', 'text', true),
      c('entity_type', 'text', false),
      c('entity_id', 'text', false),
      c('before_json', 'text', false),
      c('after_json', 'text', false),
      c('source', 'text', true),
      c('ip', 'text', false),
      c('prev_hash', 'text', true, { default: '' }),
      c('row_hash', 'text', true, { default: '' }),
    ],
  },
}
