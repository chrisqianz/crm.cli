/**
 * AL-1-7: `crm migrate export` moves a SQLite CRM into the central server.
 *
 * The contract is deliberately *not* a SQLite dump. Each bucket is emitted in
 * the parameter shape of the RPC that loads it, so the consumer below passes
 * records through without renaming a field:
 *
 *   contacts   → import.contacts   (bulk; arrays stay arrays, custom flat)
 *   companies  → import.companies  (bulk)
 *   deals      → deal.add          (per record — links survive, custom via `set`)
 *   tasks      → task.add          (per record)
 *   activities → activity.log      (per record; `at` preserves the timestamp)
 *
 * Deals are not bulk-loaded because `importDeals` hardcodes `contacts: '[]'`
 * and `company: null` — routing deals through it would silently drop every
 * link in the migration. Links travel as *names*: import/add mint fresh ids,
 * and `resolve.ts` accepts a name or title for every entity, which is the
 * documented way to reference a row across an id boundary.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestContext, type TestContext } from '../helpers.ts'
import {
  createTestDatabase,
  dropTestDatabase,
  postgresAvailable,
} from './helpers/postgres.ts'
import { bootstrapOwner, connect, startServer } from './helpers.ts'

const NO_PG = !postgresAvailable()

/** Stages and activity types spelled identically on both sides of the wire. */
const SERVE_CONFIG = `
[phone]
default_country = "US"
display = "national"

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"

[activity]
types = ["note", "call", "meeting", "email"]
`

/** `RpcClient.call` hands back `unknown`; these pin the shapes this test reads. */
interface Row {
  addresses?: string[]
  body?: string
  company?: string | null
  contact?: string | null
  contacts?: string[]
  created_at?: string
  custom_fields?: Record<string, string>
  deal?: string | null
  due_at?: string
  emails?: string[]
  id: string
  linkedin?: string | null
  name?: string
  phones?: string[]
  probability?: number
  stage?: string
  tags?: string[]
  title?: string
  type?: string
  value?: number
  websites?: string[]
}

interface Rows {
  rows: Row[]
}

interface ImportResult {
  // importContacts() reports counts, not per-row messages.
  errors?: number
  imported: number
  skipped?: number
}

/** A missing row is a migration failure, not an `undefined` to poke at. */ function mustFind(
  rows: Rows,
  label: string,
  pick: (row: Row) => boolean,
): Row {
  const row = rows.rows.find(pick)
  if (!row) {
    const seen = rows.rows.map((r) => r.name ?? r.title ?? r.id).join(', ')
    throw new Error(`no ${label} row loaded (saw: ${seen})`)
  }
  return row
}

function idOf(index: Map<string, string>, name: string): string {
  const id = index.get(name)
  if (!id) {
    throw new Error(`${name} was not loaded into the central database`)
  }
  return id
}

interface Payload {
  activities: Record<string, unknown>[]
  companies: Record<string, unknown>[]
  contacts: Record<string, unknown>[]
  deals: Record<string, unknown>[]
  meta: {
    source: string
    counts: Record<string, number>
    not_preserved: string[]
    load: Record<string, string>
  }
  tasks: Record<string, unknown>[]
}

/** A local-mode context seeded with every entity kind, plus the links. */
function seedLocal(): TestContext {
  const ctx = createTestContext()
  const { runOK } = ctx

  runOK(
    'company',
    'add',
    'Zephyr Analytics',
    '--website',
    'https://zephyr.example',
    '--phone',
    '+14155550100',
    '--tag',
    'analytics',
    '--set',
    'plan=enterprise',
  )
  runOK('company', 'add', 'Northwind Freight', '--tag', 'logistics')

  runOK(
    'contact',
    'add',
    'Ada Byron',
    '--email',
    'ada@zephyr.example',
    '--phone',
    '+14155550123',
    '--address',
    '12 Hopper Rd',
    '--company',
    'Zephyr Analytics',
    '--tag',
    'vip',
    '--linkedin',
    'ada-byron',
    '--set',
    'tier=titanium',
  )
  runOK(
    'contact',
    'add',
    'Grace Hopper',
    '--email',
    'grace@zephyr.example',
    '--tag',
    'engineer',
  )

  runOK(
    'deal',
    'add',
    'Q3 Expansion',
    '--value',
    '45000',
    '--stage',
    'proposal',
    '--contact',
    'Ada Byron',
    '--contact',
    'Grace Hopper',
    '--company',
    'Zephyr Analytics',
    '--expected-close',
    '2026-12-01',
    '--probability',
    '60',
    '--tag',
    'expansion',
    '--set',
    'source=inbound',
  )
  runOK(
    'deal',
    'add',
    'Freight Pilot',
    '--value',
    '12000',
    '--stage',
    'qualified',
    '--contact',
    'Grace Hopper',
    '--company',
    'Northwind Freight',
  )

  runOK(
    'task',
    'add',
    'Send revised proposal',
    '--due',
    '2026-11-05',
    '--contact',
    'Ada Byron',
    '--deal',
    'Q3 Expansion',
  )

  runOK(
    'log',
    'call',
    'Called about the expansion',
    '--contact',
    'Ada Byron',
    '--company',
    'Zephyr Analytics',
    '--deal',
    'Q3 Expansion',
    '--at',
    '2026-10-01T09:30:00.000Z',
    '--set',
    'duration=15m',
  )

  return ctx
}

function exportPayload(ctx: TestContext): Payload {
  const dir = mkdtempSync(join(tmpdir(), 'crm-migrate-'))
  const out = join(dir, 'export.json')
  const summary = ctx.runOK('migrate', 'export', '--out', out)
  expect(summary).toContain('migrate export')
  return JSON.parse(readFileSync(out, 'utf8')) as Payload
}

async function withCentralPg(
  fn: (client: Awaited<ReturnType<typeof connect>>) => Promise<void>,
): Promise<void> {
  const url = await createTestDatabase()
  let server: Awaited<ReturnType<typeof startServer>> | null = null
  try {
    server = await startServer('', {
      databaseUrl: url,
      configBody: SERVE_CONFIG,
      args: ['--admin-port', '0'],
    })
    const owner = await bootstrapOwner(server, 'ada')
    const client = await connect(server.port, owner.token)
    await fn(client)
    await client.close()
  } finally {
    await server?.close()
    await dropTestDatabase(url)
  }
}

describe('crm migrate export (shape contract)', () => {
  test('every bucket is emitted with the fields its loader consumes', () => {
    const ctx = seedLocal()
    const payload = exportPayload(ctx)

    expect(Object.keys(payload).sort()).toEqual(
      ['activities', 'companies', 'contacts', 'deals', 'meta', 'tasks'].sort(),
    )
    expect(payload.meta.counts).toEqual({
      companies: 2,
      contacts: 2,
      deals: 2,
      tasks: 1,
      activities: 1,
    })
    expect(payload.meta.load).toEqual({
      companies: 'import.companies',
      contacts: 'import.contacts',
      deals: 'deal.add',
      tasks: 'task.add',
      activities: 'activity.log',
    })
    expect(payload.meta.source).toContain('sqlite')

    const ada = payload.contacts.find((r) => r.name === 'Ada Byron')
    expect(ada).toBeTruthy()
    // The failure mode this pins: handing the importer the SQLite TEXT column
    // instead of the parsed array, which lands as a custom field whose value
    // is the string '["ada@zephyr.example"]'.
    expect(ada?.emails).toEqual(['ada@zephyr.example'])
    expect(ada?.phones).toEqual(['+14155550123'])
    expect(ada?.addresses).toEqual(['12 Hopper Rd'])
    expect(ada?.tags).toEqual(['vip'])
    expect(ada?.linkedin).toBe('ada-byron')
    // Custom fields go flat: a nested `custom_fields` key is an unknown
    // column to the importer, which would nest it inside itself.
    expect(ada?.tier).toBe('titanium')
    expect(ada?.custom_fields).toBeUndefined()
    // Row ids are noise on a server that mints its own.
    expect(ada?.id).toBeUndefined()

    const zephyr = payload.companies.find((r) => r.name === 'Zephyr Analytics')
    // Websites are stored normalized (scheme stripped) by companyAdd, so the
    // export carries what the database holds — not what somebody typed.
    expect(zephyr?.websites).toEqual(['zephyr.example'])
    expect(zephyr?.phones).toEqual(['+14155550100'])
    expect(zephyr?.tags).toEqual(['analytics'])
    expect(zephyr?.plan).toBe('enterprise')
    expect(zephyr?.custom_fields).toBeUndefined()

    // Links are names, never the source database's ids. The keys are exactly
    // what dealAdd() reads — singular `contact`/`tag`, camelCase `expectedClose`
    // — because the load test below feeds these records to deal.add unchanged.
    const deal = payload.deals.find((r) => r.title === 'Q3 Expansion')
    expect(deal?.company).toBe('Zephyr Analytics')
    expect(deal?.contact).toEqual(['Ada Byron', 'Grace Hopper'])
    expect(deal?.stage).toBe('proposal')
    expect(deal?.value).toBe('45000')
    expect(deal?.probability).toBe('60')
    expect(deal?.expectedClose).toBe('2026-12-01')
    expect(deal?.tag).toEqual(['expansion'])
    expect(deal?.set).toEqual(['source=inbound'])
    expect(deal?.id).toBeUndefined()

    const task = payload.tasks[0]
    expect(task?.title).toBe('Send revised proposal')
    expect(task?.contact).toBe('Ada Byron')
    expect(task?.deal).toBe('Q3 Expansion')
    expect(String(task?.due).startsWith('2026-11-05')).toBe(true)

    const activity = payload.activities[0]
    expect(activity?.type).toBe('call')
    expect(activity?.body).toBe('Called about the expansion')
    expect(activity?.contact).toEqual(['Ada Byron'])
    expect(activity?.company).toBe('Zephyr Analytics')
    expect(activity?.deal).toBe('Q3 Expansion')
    // `activity.log` takes `at`, so the timestamp is not "whenever it loaded".
    expect(activity?.at).toBe('2026-10-01T09:30:00.000Z')
    expect(activity?.set).toEqual(['duration=15m'])
  })

  test('the human summary states the counts and what the import cannot carry', () => {
    const ctx = seedLocal()
    const result = ctx.run('migrate', 'export')
    expect(result.exitCode).toBe(0)

    for (const bucket of [
      'companies',
      'contacts',
      'deals',
      'tasks',
      'activities',
    ]) {
      expect(result.stderr).toContain(bucket)
    }
    // The honest part: created_at and task status do not survive the load, and
    // the operator hears that before the migration, not after.
    expect(result.stderr).toMatch(/created_at/)
    expect(result.stderr).toMatch(/status/)

    // stdout stays machine-clean so `crm migrate export > file.json` works.
    const payload = JSON.parse(result.stdout) as Payload
    expect(payload.meta.counts.activities).toBe(1)
  })

  test('a central (PostgreSQL) database is refused rather than dumped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-migrate-pg-cfg-'))
    const configPath = join(dir, 'crm.toml')
    writeFileSync(
      configPath,
      `${SERVE_CONFIG}\n[database]\nbackend = "postgres"\nurl = "postgres://crm:crm@127.0.0.1:54321/crm_test"\n`,
    )
    const ctx = createTestContext()
    const result = ctx.runWithEnv(
      { CRM_CONFIG: configPath },
      'migrate',
      'export',
    )

    // Opening a postgres URL as a SQLite file would create an empty database
    // and report a flawless migration of nothing at all.
    expect(result.exitCode).not.toBe(0)
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/postgres/i)
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/sqlite/i)
  })

  test('--out writes the payload to a file, stdout keeps the summary', () => {
    const ctx = seedLocal()
    const dir = mkdtempSync(join(tmpdir(), 'crm-migrate-out-'))
    const out = join(dir, 'nested', 'export.json')

    const result = ctx.runOK('migrate', 'export', '--out', out)
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
    expect(payload.meta.counts.contacts).toBe(2)
    expect(result).toContain('export.json')
  })
})

describe.skipIf(NO_PG)('crm migrate export → central PostgreSQL', () => {
  test('the buckets load through import.* with arrays and custom fields intact', async () => {
    const payload = exportPayload(seedLocal())

    await withCentralPg(async (client) => {
      const companies = (await client.call('import.companies', {
        records: payload.companies,
      })) as ImportResult
      expect(companies.imported).toBe(2)

      const contacts = (await client.call('import.contacts', {
        records: payload.contacts,
      })) as ImportResult
      expect(contacts.imported).toBe(2)
      expect(contacts.skipped).toBe(0)
      // ImportResult.errors is a count, not a list of messages.
      expect(contacts.errors).toBe(0)

      const listed = (await client.call('contact.list', {})) as Rows
      const ada = mustFind(listed, 'Ada Byron', (r) => r.name === 'Ada Byron')
      expect(ada.emails).toEqual(['ada@zephyr.example'])
      expect(ada.phones).toEqual(['+14155550123'])
      expect(ada.addresses).toEqual(['12 Hopper Rd'])
      expect(ada.tags).toEqual(['vip'])
      expect(ada.linkedin).toBe('ada-byron')
      expect(ada.custom_fields).toEqual({ tier: 'titanium' })

      const companiesList = (await client.call('company.list', {})) as Rows
      const zephyr = mustFind(
        companiesList,
        'Zephyr Analytics',
        (r) => r.name === 'Zephyr Analytics',
      )
      expect(zephyr.websites).toEqual(['zephyr.example'])
      expect(zephyr.phones).toEqual(['+14155550100'])
      expect(zephyr.tags).toEqual(['analytics'])
      expect(zephyr.custom_fields).toEqual({ plan: 'enterprise' })
    })
  }, 30_000)

  test('deals, tasks and activities rebuild their links against new ids', async () => {
    const payload = exportPayload(seedLocal())

    await withCentralPg(async (client) => {
      await client.call('import.companies', { records: payload.companies })
      await client.call('import.contacts', { records: payload.contacts })
      for (const record of payload.deals) {
        await client.call('deal.add', record)
      }
      for (const record of payload.tasks) {
        await client.call('task.add', record)
      }
      for (const record of payload.activities) {
        await client.call('activity.log', record)
      }

      const companiesList = (await client.call('company.list', {})) as Rows
      const byCompany = new Map(
        companiesList.rows.map((r) => [r.name ?? '', r.id]),
      )
      const contactsList = (await client.call('contact.list', {})) as Rows
      const byContact = new Map(
        contactsList.rows.map((r) => [r.name ?? '', r.id]),
      )

      const deals = (await client.call('deal.list', {})) as Rows
      expect(deals.rows.length).toBe(2)
      const expansion = mustFind(
        deals,
        'Q3 Expansion',
        (r) => r.title === 'Q3 Expansion',
      )
      expect(expansion.stage).toBe('proposal')
      expect(expansion.value).toBe(45_000)
      expect(expansion.probability).toBe(60)
      expect(expansion.tags).toEqual(['expansion'])
      expect(expansion.custom_fields).toEqual({ source: 'inbound' })
      // The whole point: a name resolved to the id the server just minted.
      expect(expansion.company).toBe(idOf(byCompany, 'Zephyr Analytics'))
      expect(new Set(expansion.contacts)).toEqual(
        new Set([
          idOf(byContact, 'Ada Byron'),
          idOf(byContact, 'Grace Hopper'),
        ]),
      )

      const tasks = (await client.call('task.list', {})) as Rows
      expect(tasks.rows.length).toBe(1)
      const task = mustFind(tasks, 'task', () => true)
      expect(task.title).toBe('Send revised proposal')
      expect(task.contact).toBe(idOf(byContact, 'Ada Byron'))
      expect(task.deal).toBe(expansion.id)
      expect(String(task.due_at).startsWith('2026-11-05')).toBe(true)

      const activities = (await client.call('activity.list', {})) as Rows
      expect(activities.rows.length).toBe(1)
      const activity = mustFind(activities, 'activity', () => true)
      expect(activity.type).toBe('call')
      expect(activity.body).toBe('Called about the expansion')
      expect(activity.custom_fields).toEqual({ duration: '15m' })
      expect(activity.company).toBe(idOf(byCompany, 'Zephyr Analytics'))
      expect(activity.deal).toBe(expansion.id)
      expect(activity.contacts).toEqual([idOf(byContact, 'Ada Byron')])
      expect(activity.created_at).toBe('2026-10-01T09:30:00.000Z')
    })
  }, 30_000)
})
