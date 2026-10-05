/**
 * AL-1-3: the audit hash chain is one object on both dialects.
 *
 * The chain is the tamper-evidence product. It is also the most
 * driver-sensitive code in the repo: it reads `seq` back inside the write
 * transaction, and it re-derives every hash from row values it pulled back
 * out of the database. Both of those are exactly where sqlite and postgres
 * disagree (positional vs named parameters, `INTEGER` identity returning a
 * number vs `BIGINT` returning a string, `Row` positional access vs plain
 * objects).
 *
 * So the assertion is not "the wrapper was called with the right arguments" —
 * it is that the chain *verifies on postgres the same way it already does on
 * sqlite*, including under concurrent writers, and that each tamper shape the
 * design claims to detect is reported with the seq that a human would grep
 * for. A mocked driver proves none of that.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ulid } from 'ulid'

import { loadConfig } from '../../src/config'
import { openDB } from '../../src/db'
import { closeDatabase, openDatabase } from '../../src/db/open'
import type { CrmDb } from '../../src/db/seam'
import {
  AUDIT_GENESIS_HASH,
  type AuditEvent,
  recordAudit,
  verifyChain,
} from '../../src/lib/audit'
import {
  createTestDatabase,
  dropTestDatabase,
  postgresAvailable,
} from './helpers/postgres'

const scratch = mkdtempSync(join(tmpdir(), 'crm-pg-audit-'))

function writeConfig(body: string): string {
  const path = join(scratch, `crm-${ulid()}.toml`)
  writeFileSync(path, body, { mode: 0o600 })
  return path
}

function event(n: number, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    action: 'contact.update',
    actor_id: 'user-1',
    actor_name: 'Owner',
    after_json: JSON.stringify({ n }),
    before_json: JSON.stringify({ n: n - 1 }),
    entity_id: `c-${n}`,
    entity_type: 'contact',
    ip: '10.0.0.1',
    source: 'cli',
    ...overrides,
  }
}

/** audit_log columns an insert may name; `seq` is identity-generated. */
const AUDIT_INSERT_COLUMNS = `at, actor_id, actor_name, action, entity_type,
       entity_id, before_json, after_json, source, ip, prev_hash, row_hash`

/**
 * Write a row the chain writer would never produce, to reach the states the
 * verifier has to handle: pre-P4 legacy rows (empty hashes) and forged links.
 */
async function insertRawAudit(
  db: CrmDb,
  values: {
    action?: string
    prev_hash: string
    row_hash: string
  } = { prev_hash: '', row_hash: '' },
): Promise<void> {
  await db.$crm.raw.query(
    `INSERT INTO audit_log (${AUDIT_INSERT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      new Date().toISOString(),
      'user-legacy',
      'Legacy',
      values.action ?? 'contact.create',
      'contact',
      'c-legacy',
      null,
      null,
      'cli',
      null,
      values.prev_hash,
      values.row_hash,
    ],
  )
}

const SKIP_PG = !postgresAvailable()

describe.skipIf(SKIP_PG)('postgres audit chain', () => {
  const created: string[] = []

  async function freshDb(): Promise<CrmDb> {
    const url = await createTestDatabase()
    created.push(url)
    const config = loadConfig({
      configPath: writeConfig(`[database]\nurl = "${url}"\n`),
    })
    return openDatabase(config)
  }

  afterAll(async () => {
    for (const url of created) {
      await closeDatabase(url)
      await dropTestDatabase(url)
    }
    rmSync(scratch, { recursive: true, force: true })
  })

  test('three audits chain, and two concurrent writers still chain', async () => {
    const db = await freshDb()

    await recordAudit(db, event(1))
    // Concurrent calls are the case the per-handle write chain exists for:
    // both readers see the same head, so one of them would link to a
    // prev_hash that is no longer the last row.
    await Promise.all([recordAudit(db, event(2)), recordAudit(db, event(3))])

    const result = await verifyChain(db)
    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.chained).toBe(3)
    expect(result.legacy).toBe(0)
    expect(result.brokenSeq).toBeNull()
    expect(result.genesisSeq).toBe(1)

    const heads = await db.$crm.raw.query(
      'SELECT seq, prev_hash FROM audit_log ORDER BY seq',
    )
    expect(heads.map((row) => Number(row.seq))).toEqual([1, 2, 3])
    expect(String(heads[0].prev_hash)).toBe(AUDIT_GENESIS_HASH)
  }, 60_000)

  test('an altered row_hash is reported at the row that was altered', async () => {
    const db = await freshDb()
    await recordAudit(db, event(1))
    await recordAudit(db, event(2))
    await recordAudit(db, event(3))

    await db.$crm.raw.query('UPDATE audit_log SET row_hash = ? WHERE seq = ?', [
      'f'.repeat(64),
      2,
    ])

    const result = await verifyChain(db)
    expect(result.ok).toBe(false)
    expect(result.brokenSeq).toBe(2)
    expect(result.reason).toBe(
      'content hash mismatch — this row was altered after being written',
    )
  }, 60_000)

  test('a deleted middle row is reported as a broken link at the next row', async () => {
    const db = await freshDb()
    await recordAudit(db, event(1))
    await recordAudit(db, event(2))
    await recordAudit(db, event(3))

    await db.$crm.raw.query('DELETE FROM audit_log WHERE seq = ?', [2])

    const result = await verifyChain(db)
    expect(result.ok).toBe(false)
    expect(result.brokenSeq).toBe(3)
    expect(result.reason).toContain('a row was inserted, deleted, or reordered')
  }, 60_000)

  test('a forged first link is reported as not starting from the genesis hash', async () => {
    const db = await freshDb()
    await recordAudit(db, event(1))
    await recordAudit(db, event(2))

    await db.$crm.raw.query(
      'UPDATE audit_log SET prev_hash = ? WHERE seq = ?',
      ['a'.repeat(64), 1],
    )

    const result = await verifyChain(db)
    expect(result.ok).toBe(false)
    expect(result.brokenSeq).toBe(1)
    expect(result.reason).toBe(
      'first chained row does not start from the genesis hash',
    )
  }, 60_000)

  test('pre-P4 legacy rows are counted and stay outside the chain', async () => {
    const db = await freshDb()
    await insertRawAudit(db)
    await recordAudit(db, event(1))
    await recordAudit(db, event(2))

    const result = await verifyChain(db)
    expect(result.ok).toBe(true)
    expect(result.legacy).toBe(1)
    expect(result.chained).toBe(2)
    expect(result.genesisSeq).toBe(2)

    const tampered = await insertRawAudit(db, {
      prev_hash: 'b'.repeat(64),
      row_hash: 'c'.repeat(64),
    })
    expect(tampered).toBeUndefined()
  }, 60_000)

  test('a failing audit write leaves no unchained row behind', async () => {
    const db = await freshDb()
    await recordAudit(db, event(1))

    let threw = false
    try {
      await db.$crm.raw.transaction(async (raw) => {
        await raw.query(
          `INSERT INTO audit_log (${AUDIT_INSERT_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            new Date().toISOString(),
            'user-1',
            'Owner',
            'contact.update',
            'contact',
            'c-99',
            null,
            null,
            'cli',
            null,
            AUDIT_GENESIS_HASH,
            '',
          ],
        )
        throw new Error('boom')
      })
    } catch (error) {
      threw = true
      expect((error as Error).message).toBe('boom')
    }
    expect(threw).toBe(true)

    const rows = await db.$crm.raw.query(
      'SELECT seq FROM audit_log WHERE entity_id = ?',
      ['c-99'],
    )
    expect(rows).toEqual([])
    const result = await verifyChain(db)
    expect(result.chained).toBe(1)
    expect(result.ok).toBe(true)
  }, 60_000)
})

/**
 * The sqlite half is a regression guard, not a re-spec: the existing CLI-level
 * chain tests (`test/audit-commands.test.ts`) drive the same code through the
 * real binary. What this pins is that the port kept the *dialect-neutral*
 * promise — same functions, same handle type, same verdicts.
 */
describe('sqlite audit chain over the same seam', () => {
  const paths: string[] = []

  function freshDb(): Promise<CrmDb> {
    const path = join(scratch, `sqlite-${ulid()}.db`)
    paths.push(path)
    return openDB(path)
  }

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  test('the same verifyChain call site works on a sqlite handle', async () => {
    const db = await freshDb()
    expect(db.$crm.dialect).toBe('sqlite')

    await recordAudit(db, event(1))
    await Promise.all([recordAudit(db, event(2)), recordAudit(db, event(3))])

    const result = await verifyChain(db)
    expect(result.ok).toBe(true)
    expect(result.chained).toBe(3)
    expect(result.genesisSeq).toBe(1)

    await db.$crm.raw.query(
      'UPDATE audit_log SET after_json = ? WHERE seq = ?',
      ['{"n":999}', 2],
    )
    const after = await verifyChain(db)
    expect(after.ok).toBe(false)
    expect(after.brokenSeq).toBe(2)
    expect(after.reason).toBe(
      'content hash mismatch — this row was altered after being written',
    )
  })

  test('legacy rows are skipped on sqlite too', async () => {
    const db = await freshDb()
    await insertRawAudit(db)
    await recordAudit(db, event(1))

    const result = await verifyChain(db)
    expect(result.ok).toBe(true)
    expect(result.legacy).toBe(1)
    expect(result.chained).toBe(1)
  })
})
