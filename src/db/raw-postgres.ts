import type { Pool, QueryResult, QueryResultRow } from 'pg'

import type { RawArgs, RawDB, RawRows } from './seam'

/**
 * Translate libsql's `?` placeholders into the `$n` form node-postgres needs.
 *
 * Scanning rather than splitting, because a `?` inside a quoted literal is
 * data, not a placeholder — and a doubled quote is how the literal spells its
 * own quote character.
 */
export function toPositional(sql: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          i += 1
          out += sql[i]
        } else {
          quote = null
        }
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '?') {
      index += 1
      out += `$${index}`
      continue
    }
    out += ch
  }
  return out
}

/** Anything that can run one statement and hand back rows. */
interface StatementRunner {
  query(sql: string, args?: RawArgs): Promise<QueryResult<QueryResultRow>>
}

function toRows(result: QueryResult<QueryResultRow>): RawRows {
  return result.rows.map((row) => ({ ...row }))
}

function rawFor(runner: StatementRunner): RawDB {
  return {
    query: (sql, args = []) =>
      runner.query(toPositional(sql), args).then((result) => toRows(result)),
    transaction: () =>
      Promise.reject(new Error('nested transactions are not supported')),
  }
}

/**
 * Raw SQL + transactions over a node-postgres pool.
 *
 * Statements inside a transaction run on the pinned connection, never the
 * pool: a pooled statement would land on a different backend connection and
 * silently escape the transaction — the failure mode that makes this wrapper
 * worth having instead of passing `pool` through.
 */
export function postgresRaw(pool: Pool): RawDB {
  return {
    query: (sql, args = []) =>
      pool.query(toPositional(sql), args).then((result) => toRows(result)),
    async transaction<T>(fn: (raw: RawDB) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const value = await fn(rawFor(client))
          await client.query('COMMIT')
          return value
        } catch (error) {
          // The connection is poisoned until the abort is acknowledged; a
          // failing ROLLBACK is a different bug and must not mask the original.
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}
