/**
 * The dialect seam (AL-1-2, spec/alignment.md §3).
 *
 * Every dialect-dependent decision the rest of the codebase makes — raw SQL,
 * transactions, and which table namespace a query is built against — goes
 * through `$crm`, so the service layer never branches on the backend and a
 * future dialect (AL-8) is one more pair of `raw` implementations plus a
 * schema declaration, not a rewrite.
 *
 * The query-builder surface IS part of the seam (AL-1-5): `CrmDb` carries the
 * four verbs the codebase actually uses, resolved against the dialect's own
 * table namespace via `$crm.schema`. The shape is derived from the REAL sqlite
 * handle rather than hand-written, because the four drizzle verbs return
 * structurally different builders (delete has no `from`/`set`/`values`, insert
 * has no `where`) — only the builders themselves describe that correctly.
 */

import type { drizzle } from 'drizzle-orm/libsql'

import type * as sqliteTables from './schema-sqlite'

export type Dialect = 'postgres' | 'sqlite'

/**
 * Positional statement arguments. `?` is the placeholder on BOTH dialects:
 * libsql takes it natively, and the postgres wrapper rewrites each `?` to the
 * `$n` node-postgres requires. Named parameters are NOT portable — node-postgres
 * 8.23 rejects them (`Query values must be an array`), verified against the
 * test container.
 */
export type RawArgs = unknown[]

/** Rows as plain objects keyed by column name. */
export type RawRows = Record<string, unknown>[]

/** Raw SQL + transactions, the only place either dialect's driver is visible. */
export interface RawDB {
  query(sql: string, args?: RawArgs): Promise<RawRows>
  /**
   * Runs `fn` inside one transaction and returns its result. Nested calls
   * throw on both dialects, so callers keep the single-transaction rule the
   * audit chain already follows (`commit` on return, rollback otherwise).
   */
  transaction<T>(fn: (raw: RawDB) => Promise<T>): Promise<T>
}

/**
 * The table namespace a seam may hand out.
 *
 * Typed as the SQLITE declaration because drizzle binds column types to the
 * dialect module. `schema-pg` declares the same columns as the same
 * `text()`/`integer()` scalars (see `src/db/schema-pg.ts`), so the row shapes
 * both drivers return are identical and this one type describes both; the only
 * cast that makes that statement true lives in `open.ts`.
 */
export type CrmTables = typeof sqliteTables

/** The sqlite handle drizzle actually builds in `openDB`. */
type SqliteHandle = ReturnType<typeof drizzle<typeof sqliteTables>>

/**
 * The query-builder surface the service layer is allowed to use: exactly the
 * four verbs observed across `src/` (40 select / 15 insert / 9 delete /
 * 1 update call sites). Nothing else is exposed on purpose — `db.run`,
 * `db.all`, `db.get` and sqlite-only helpers such as `onConflictDoUpdate` are
 * absent, so a dialect-specific escape hatch is a compile error rather than a
 * postgres-only runtime crash. Widen THIS if a call site ever needs a fifth
 * verb, and verify it against both backends.
 */
export type CrmQueryBuilder = Pick<
  SqliteHandle,
  'delete' | 'insert' | 'select' | 'update'
>

export interface CrmSeam {
  dialect: Dialect
  /** Positional-SQL + transaction handle for this dialect. */
  raw: RawDB
  /**
   * The dialect's table namespace (`schema-sqlite` / `schema-pg`, both
   * generated from the neutral contract). Service code reaches tables through
   * this instead of importing one dialect's declaration — that import is what
   * AL-1-5 removes from every service file.
   */
  schema: CrmTables
}

/**
 * A database handle as the service layer sees it: four query verbs plus the
 * seam. Both backends satisfy it (postgres through one cast in `open.ts`).
 */
export type CrmDb = CrmQueryBuilder & { $crm: CrmSeam }

/**
 * The narrowest handle a reader can require: raw SQL, nothing else. Used by
 * code that verifies or inspects a database it did not open — e.g. the backup
 * check, which reads a freshly restored replica through the same chain-
 * verification path a live database uses, and has no reason to hold a builder.
 */
export interface CrmRawDb {
  $crm: Pick<CrmSeam, 'raw'>
}
