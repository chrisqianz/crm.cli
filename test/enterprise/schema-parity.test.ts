import { describe, expect, test } from 'bun:test'

import type { TableSpec } from '../../src/db/schema'
import * as contract from '../../src/db/schema'
import * as pgSchema from '../../src/db/schema-pg'
import * as sqliteSchema from '../../src/db/schema-sqlite'

/**
 * AL-1 schema parity (spec/alignment.md §3).
 *
 * The physical database is declared once per dialect (schema-sqlite.ts /
 * schema-pg.ts) because drizzle's builder types are dialect-bound. This
 * test is the lock that keeps the two physical schemas from drifting:
 * it walks both drizzle schemas via their column metadata and asserts
 * they match the dialect-neutral contract in src/db/schema.ts — same
 * tables, same columns, same nullability, defaults, PK and unique
 * markers, same schema version. Docker-free, runs on the normal matrix.
 */

interface DrizzleColumn {
  dataType: string
  default: unknown
  hasDefault: boolean
  isUnique: boolean
  name: string
  notNull: boolean
  primary: boolean
}

/** drizzle tables carry extra non-column keys (e.g. pg `enableRLS`) — skip. */
function columnEntries(table: unknown): Record<string, DrizzleColumn> {
  const t = table as Record<string, unknown>
  const out: Record<string, DrizzleColumn> = {}
  for (const [key, val] of Object.entries(t)) {
    const col = val as DrizzleColumn | undefined
    if (col && typeof col === 'object' && typeof col.dataType === 'string') {
      out[key] = col
    }
  }
  return out
}

/** dataType (string|number|boolean) → contract kind. */
function toKind(dataType: string): string {
  if (dataType === 'string') {
    return 'text'
  }
  if (dataType === 'number') {
    return 'integer'
  }
  if (dataType === 'boolean') {
    return 'boolean'
  }
  return dataType
}

/** TABLES is keyed by logical table key; string-index access for the test. */
type ContractTables = Record<string, TableSpec>

interface Normalized {
  defaults: Record<string, string | null>
  kind: Record<string, string>
  names: string[]
  notNull: Record<string, boolean>
  primary: string[]
  unique: string[]
}

function normalize(table: unknown): Normalized {
  const names = Object.keys(columnEntries(table))
  const kind: Record<string, string> = {}
  const notNull: Record<string, boolean> = {}
  const defaults: Record<string, string | null> = {}
  const primary: string[] = []
  const unique: string[] = []
  for (const [name, col] of Object.entries(columnEntries(table))) {
    kind[name] = toKind(col.dataType)
    notNull[name] = col.notNull
    // Serial/identity columns (audit_log.seq) report hasDefault=true with
    // default undefined — normalize that to "no literal default".
    defaults[name] =
      col.hasDefault && col.default !== undefined ? String(col.default) : null
    if (col.primary) {
      primary.push(name)
    }
    if (col.isUnique) {
      unique.push(name)
    }
  }
  return { defaults, kind, names, notNull, primary, unique }
}

function expectMatchesContract(tableKey: string, actual: Normalized): void {
  const spec = Object.values(contract.TABLES).find((t) => t.name === tableKey)
  if (!spec) {
    throw new Error(`contract table ${tableKey} not found in the contract`)
  }
  const specCols = spec.columns

  expect([...actual.names].sort(), `${tableKey}: column set`).toEqual(
    specCols.map((c) => c.name).sort(),
  )
  for (const c of specCols) {
    expect(actual.kind[c.name], `${tableKey}.${c.name} kind`).toBe(c.kind)
    expect(actual.notNull[c.name], `${tableKey}.${c.name} notNull`).toBe(
      c.notNull,
    )
    expect(actual.defaults[c.name], `${tableKey}.${c.name} default`).toBe(
      c.default,
    )
    expect(
      actual.primary.includes(c.name),
      `${tableKey}.${c.name} primary`,
    ).toBe(c.primary)
    expect(actual.unique.includes(c.name), `${tableKey}.${c.name} unique`).toBe(
      c.unique,
    )
  }
}

const sqliteTables = sqliteSchema.tables as unknown as Record<string, unknown>
const pgTables = pgSchema.tables as unknown as Record<string, unknown>

const tableKeys = Object.keys(contract.TABLES).sort()
const sqliteNames = Object.keys(sqliteTables).sort()
const pgNames = Object.keys(pgTables).sort()

describe('schema parity', () => {
  test('schema versions agree', () => {
    expect(sqliteSchema.schemaVersion).toBe(contract.schemaVersion)
    expect(pgSchema.schemaVersion).toBe(contract.schemaVersion)
  })

  test('both dialects declare the contract tables', () => {
    // contract table keys (contacts/companies/.../auditLog) → physical names
    const contractPhysical = tableKeys.map(
      (k) => (contract.TABLES as unknown as ContractTables)[k].name,
    )
    expect(sqliteNames).toEqual(contractPhysical)
    expect(pgNames).toEqual(contractPhysical)
  })

  test('sqlite dialect matches the contract', () => {
    const tables = contract.TABLES as unknown as ContractTables
    for (const key of tableKeys) {
      const physical = tables[key].name
      expectMatchesContract(physical, normalize(sqliteTables[physical]))
    }
  })

  test('postgres dialect matches the contract', () => {
    const tables = contract.TABLES as unknown as ContractTables
    for (const key of tableKeys) {
      const physical = tables[key].name
      expectMatchesContract(physical, normalize(pgTables[physical]))
    }
  })

  test('sqlite and postgres normalize identically', () => {
    const tables = contract.TABLES as unknown as ContractTables
    for (const key of tableKeys) {
      const physical = tables[key].name
      expect(
        normalize(pgTables[physical]),
        `${physical}: pg equals sqlite`,
      ).toEqual(normalize(sqliteTables[physical]))
    }
  })
})
