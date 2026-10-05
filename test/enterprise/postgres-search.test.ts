/**
 * AL-1-4: the search path has to answer identically on both backends.
 *
 * SQLite keeps fts5; Postgres gets a generated tsvector column behind the same
 * `$crm.raw` seam the audit chain uses. The contract under test is not "both
 * engines exist" — it is "the same content, queried the same way, returns the
 * same rows, including when the full-text engine cannot answer at all and the
 * LIKE / ILIKE fallback takes over".
 *
 * Result ORDER is deliberately not asserted: fts5 ranks by bm25, Postgres by
 * ts_rank, and the fallbacks do not rank. Only the row SETS are portable, so
 * only the sets are pinned.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ulid } from 'ulid'

import type { CRMConfig } from '../../src/config'
import { loadConfig } from '../../src/config'
import {
  openDB,
  rebuildSearchIndex,
  removeSearchIndex,
  upsertSearchIndex,
} from '../../src/db'
import { closeDatabase, openDatabase } from '../../src/db/open'
import type { CrmDb } from '../../src/db/seam'
import { findSemantic, indexStatus, searchFts } from '../../src/service/search'
import {
  createTestDatabase,
  dropTestDatabase,
  postgresAvailable,
} from './helpers/postgres'

const scratch = mkdtempSync(join(tmpdir(), 'crm-pg-search-'))

function writeConfig(body: string): string {
  const path = join(scratch, `crm-${ulid()}.toml`)
  writeFileSync(path, body, { mode: 0o600 })
  return path
}

/** Fixed so the two databases hold byte-identical content. */
const NOW = '2026-10-06T00:00:00.000Z'

const COMPANY = 'company-zephyr'
const CONTACT = 'contact-avery'
const DEAL = 'deal-ledger'
const ACTIVITY = 'activity-recap'

interface Fixture {
  config: CRMConfig
  db: CrmDb
}

/**
 * Seeded through the seam, then indexed by production code, so a dialect that
 * builds different index content from the same rows fails the parity table
 * rather than passing on a hand-written index.
 *
 * Content each entity ends up with (per buildCompanySearch / buildDealSearch /
 * buildContactSearch / the activity branch of rebuildSearchIndex):
 *   company   "Zephyr & Analytics [] [] {} []"
 *   contact   "Avery Noonan [] [] [] {} []"
 *   deal      "Ledger audit renewal proposal {} []"
 *   activity  "note Wholesale ledger recap for the Northwind account {}"
 */
async function seed(db: CrmDb): Promise<void> {
  await db.$crm.raw.query(
    'INSERT INTO companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [COMPANY, 'Zephyr & Analytics', NOW, NOW],
  )
  await db.$crm.raw.query(
    'INSERT INTO contacts (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [CONTACT, 'Avery Noonan', NOW, NOW],
  )
  await db.$crm.raw.query(
    'INSERT INTO deals (id, title, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [DEAL, 'Ledger audit renewal', 'proposal', NOW, NOW],
  )
  await db.$crm.raw.query(
    'INSERT INTO activities (id, type, body, created_at) VALUES (?, ?, ?, ?)',
    [ACTIVITY, 'note', 'Wholesale ledger recap for the Northwind account', NOW],
  )
  await rebuildSearchIndex(db)
}

async function openFixture(backend: 'postgres' | 'sqlite'): Promise<Fixture> {
  if (backend === 'sqlite') {
    const config = loadConfig({ configPath: writeConfig('') })
    const db = await openDB(join(scratch, `crm-${ulid()}.sqlite`))
    await seed(db)
    return { config, db }
  }
  const url = await createTestDatabase()
  pgUrls.push(url)
  const config = loadConfig({
    configPath: writeConfig(`[database]\nurl = "${url}"\n`),
  })
  const db = await openDatabase(config)
  await seed(db)
  return { config, db }
}

const pgUrls: string[] = []

interface Pair {
  pg: Fixture
  sqlite: Fixture
}

let pairPromise: Promise<Pair> | null = null

/** One pair for the whole file — a rejected open must not be cached. */
function pair(): Promise<Pair> {
  if (!pairPromise) {
    pairPromise = (async () => ({
      pg: await openFixture('postgres'),
      sqlite: await openFixture('sqlite'),
    }))().catch((error: unknown) => {
      pairPromise = null
      throw error
    })
  }
  return pairPromise
}

afterAll(async () => {
  for (const url of pgUrls) {
    await closeDatabase(url).catch(() => undefined)
    await dropTestDatabase(url).catch(() => undefined)
  }
  rmSync(scratch, { force: true, recursive: true })
})

async function ids(
  fixture: Fixture,
  params: Record<string, unknown>,
): Promise<string[]> {
  const { rows } = await searchFts(fixture.db, fixture.config, params)
  return rows.map((row) => String(row.id)).sort()
}

async function findIds(
  fixture: Fixture,
  params: Record<string, unknown>,
): Promise<string[]> {
  const { rows } = await findSemantic(fixture.db, fixture.config, params)
  return rows.map((row) => String(row.id)).sort()
}

describe.skipIf(!postgresAvailable())('search parity across backends', () => {
  // A query fts5 rejects outright, so sqlite answers from the LIKE fallback
  // while Postgres answers from tsquery. The row set is what has to agree.
  const FORCED_FALLBACK = 'Zephyr & Analytics'

  const cases: { expect: string[]; query: string; why: string }[] = [
    {
      expect: [DEAL],
      query: 'ledger proposal',
      why: 'both terms live in the deal but neither adjacent nor same-case, so only a real full-text engine can answer it',
    },
    {
      expect: [],
      query: 'audit recap',
      why: 'one term matches the deal and the other the activity — matching is conjunctive, so a near miss must return nothing',
    },
    {
      expect: [COMPANY],
      query: FORCED_FALLBACK,
      why: 'fts5 raises a syntax error on "&", Postgres reads it as punctuation: the fallback still has to return the same row',
    },
    {
      expect: [ACTIVITY, COMPANY, CONTACT, DEAL],
      query: '',
      why: 'an empty query lists everything on sqlite today by falling out of a failed match; Postgres never raises, so it needs the same answer for a different reason',
    },
  ]

  for (const c of cases) {
    test(`${c.query === '' ? '(empty query)' : c.query} returns the same rows on both backends`, async () => {
      const { pg, sqlite } = await pair()
      const onSqlite = await ids(sqlite, { query: c.query })
      const onPostgres = await ids(pg, { query: c.query })

      expect({ query: c.query, onSqlite, onPostgres }).toEqual({
        query: c.query,
        onPostgres: c.expect,
        onSqlite: c.expect,
      })
    }, 60_000)
  }

  test('the type filter narrows identically on both backends', async () => {
    const { pg, sqlite } = await pair()
    // 'ledger' is a single term that appears in the deal title and in the
    // activity body, so the contact and company filters have to come back
    // empty on both backends.
    const expectedByType: Record<string, string[]> = {
      deal: [DEAL],
      activity: [ACTIVITY],
    }
    for (const type of ['contact', 'company', 'deal', 'activity']) {
      const expected = expectedByType[type] ?? []
      expect({
        type,
        onSqlite: await ids(sqlite, { query: 'ledger', type }),
      }).toEqual({
        onSqlite: expected,
        type,
      })
      expect({
        type,
        onPostgres: await ids(pg, { query: 'ledger', type }),
      }).toEqual({
        onPostgres: expected,
        type,
      })
    }
  })

  test('semantic find agrees, and still never returns activities', async () => {
    const { pg, sqlite } = await pair()
    // 'ledger' scores on the deal and on the activity; activities are skipped.
    expect(await findIds(sqlite, { query: 'ledger' })).toEqual([DEAL])
    expect(await findIds(pg, { query: 'ledger' })).toEqual([DEAL])
    expect(await findIds(sqlite, { query: 'northwind account' })).toEqual([])
    expect(await findIds(pg, { query: 'northwind account' })).toEqual([])
  })

  test('index status reports the same counts on both backends', async () => {
    const { pg, sqlite } = await pair()
    const onSqlite = await indexStatus(sqlite.db, sqlite.config)
    const onPostgres = await indexStatus(pg.db, pg.config)

    expect(onSqlite.lines).toEqual([
      'contacts: 1 (indexed: 1)',
      'companies: 1 (indexed: 1)',
      'deals: 1 (indexed: 1)',
    ])
    expect(onPostgres).toEqual(onSqlite)
  })

  test('index maintenance calls agree on both backends', async () => {
    const { pg, sqlite } = await pair()

    await removeSearchIndex(sqlite.db, DEAL)
    await removeSearchIndex(pg.db, DEAL)
    expect(await ids(sqlite, { query: 'ledger proposal' })).toEqual([])
    expect(await ids(pg, { query: 'ledger proposal' })).toEqual([])

    await upsertSearchIndex(
      sqlite.db,
      'deal',
      DEAL,
      'ledger proposal seeded directly',
    )
    await upsertSearchIndex(
      pg.db,
      'deal',
      DEAL,
      'ledger proposal seeded directly',
    )
    expect(await ids(sqlite, { query: 'ledger proposal' })).toEqual([DEAL])
    expect(await ids(pg, { query: 'ledger proposal' })).toEqual([DEAL])

    await rebuildSearchIndex(sqlite.db)
    await rebuildSearchIndex(pg.db)
    expect(await ids(sqlite, { query: 'ledger proposal' })).toEqual([DEAL])
    expect(await ids(pg, { query: 'ledger proposal' })).toEqual([DEAL])
  })

  // Pinned divergence, not a bug to fix in this task. "Analytics & Zephyr" is
  // the reverse of the indexed text: fts5 rejects the "&" outright, so sqlite
  // lands on the substring fallback, which cannot reorder terms. Postgres reads
  // the "&" as punctuation and matches a word set, which can. A future change
  // that makes the fallback word-order agnostic has to update this on purpose.
  test('known divergence: the fallback cannot reorder terms', async () => {
    const { pg, sqlite } = await pair()
    expect(await ids(sqlite, { query: 'Analytics & Zephyr' })).toEqual([])
    expect(await ids(pg, { query: 'Analytics & Zephyr' })).toEqual([COMPANY])
  })
})
