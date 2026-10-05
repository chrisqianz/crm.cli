/**
 * The dialect seam (AL-1-2, spec/alignment.md §3).
 *
 * Every dialect-dependent decision the rest of the codebase makes — raw SQL,
 * transactions, and which table namespace a query is built against — goes
 * through `$crm`, so the service layer never branches on the backend and a
 * future dialect (AL-8) is one more pair of `raw` implementations plus a
 * schema declaration, not a rewrite.
 *
 * The query-builder surface is deliberately NOT part of this seam yet. The
 * four drizzle verbs return structurally different builders (delete has no
 * `from`/`set`/`values`, insert has no `where`), so one shared builder
 * interface cannot describe them; AL-1-5 defines those shapes against the
 * 133 real call sites it redirects, not against a guess.
 */

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

export interface CrmSeam {
  dialect: Dialect
  /** Positional-SQL + transaction handle for this dialect. */
  raw: RawDB
  /**
   * The dialect's table namespace (`schema-sqlite` / `schema-pg`, both
   * generated from the neutral contract). Service code reaches tables through
   * this instead of importing one dialect's declaration — that import is what
   * AL-1-5 removes from all 18 service files.
   */
  schema: Record<string, unknown>
}

/** The only shape AL-1-2 guarantees about a database handle. */
export interface CrmDb {
  $crm: CrmSeam
}
