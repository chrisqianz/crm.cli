import type { Client, InValue, ResultSet, Transaction } from '@libsql/client'

import * as sqliteTables from './schema-sqlite'
import type { CrmSeam, RawArgs, RawDB, RawRows } from './seam'

/** libsql hands back column names + array-like rows; the seam wants objects. */
function rowsFrom(result: ResultSet): RawRows {
  const { columns } = result
  return result.rows.map((row) => {
    const record: Record<string, unknown> = {}
    for (const [index, name] of columns.entries()) {
      record[name] = row[index]
    }
    return record
  })
}

async function run(
  exec: {
    execute(stmt: { args?: InValue[]; sql: string }): Promise<ResultSet>
  },
  sql: string,
  args: RawArgs,
): Promise<RawRows> {
  // SAFETY: the seam's contract is "values the driver accepts". libsql's
  // InValue is exactly that set; unknown[] only hides it from the checker.
  const result = await exec.execute({ sql, args: args as InValue[] })
  return rowsFrom(result)
}

/**
 * A raw handle bound to an open transaction. It cannot open another one —
 * libsql rejects nested transactions, and the seam says so explicitly rather
 * than letting the driver's error surface from inside a callback.
 */
function sqliteTxRaw(tx: Transaction): RawDB {
  return {
    query: (sql, args = []) => run(tx, sql, args),
    transaction: () =>
      Promise.reject(new Error('nested transactions are not supported')),
  }
}

/**
 * Raw SQL + transactions over a libsql client.
 *
 * Values keep libsql's own representation (number, bigint, ArrayBuffer) rather
 * than being JSON-coerced, so a row read through the seam is identical to the
 * same row read through drizzle.
 */
export function sqliteRaw(client: Client): RawDB {
  return {
    query: (sql, args = []) => run(client, sql, args),
    async transaction<T>(fn: (raw: RawDB) => Promise<T>): Promise<T> {
      const tx = await client.transaction('write')
      try {
        const value = await fn(sqliteTxRaw(tx))
        await tx.commit()
        return value
      } catch (error) {
        await tx.rollback().catch(() => undefined)
        throw error
      }
    },
  }
}

/**
 * The whole sqlite seam for a client the caller already holds open (AL-1-2).
 *
 * `openDB` (`src/db.ts`) builds this for every database it opens. `backup
 * check` needs the same object for a replica it deliberately does NOT open
 * through `openDB`: that function memoizes one connection per path, and a
 * check restores a fresh temp file every run, so a long-lived `serve` would
 * leak a client per check. Sharing this constructor is what keeps the two
 * handles indistinguishable to the code that reads them — `verifyChain` runs
 * against a live database and a restored replica through the same path.
 */
export function sqliteSeam(client: Client): CrmSeam {
  return {
    dialect: 'sqlite',
    raw: sqliteRaw(client),
    schema: { ...sqliteTables },
  }
}
