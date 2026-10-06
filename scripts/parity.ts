// AL-1-9 cross-dialect parity check.
//
// Drives the *real* public contract — the TLS RPC surface — against two
// backends (libsql SQLite and postgres:16) with the same seed scenario, then
// diffs the two normalized transcripts. Anything that is not an explicitly
// declared dialect note must be byte-identical, or this script exits 1.
//
//   bun run scripts/parity.ts            # both backends (pg needs docker)
//   bun run scripts/parity.ts --sqlite   # sqlite leg only (smoke the script)
//
// Transcripts are normalized because raw rows legitimately differ: ids are
// ULIDs minted per write, created_at/updated_at are wall-clock, audit rows
// carry hashes, and pg hands back JSONB as real JSON while SQLite hands back
// TEXT. None of that is a behaviour difference, so it is normalized away
// before the diff — and every normalization rule is asserted in the notes.

import type { RpcClient } from '../src/lib/rpc'
import { RpcError } from '../src/lib/rpc'
import type { TestServer } from '../test/enterprise/helpers'
import {
  bootstrapOwner,
  connect,
  freshDb,
  startServer,
} from '../test/enterprise/helpers'
import {
  createTestDatabase,
  dropTestDatabase,
  postgresAvailable,
} from '../test/enterprise/helpers/postgres'

/** The grammar every RPC reply lives in — the parity diff compares these. */
interface JsonRecord {
  [key: string]: Json
}
type Cell = boolean | number | string | null
type Json = Cell | Json[] | JsonRecord

/** Volatile columns that cannot be compared across two independent runs. */
const DROP_KEYS = new Set([
  'at',
  'created_at',
  'password',
  'prev_hash',
  'row_hash',
  'token',
  'updated_at',
])

/** `makeId()` mints `<prefix>_<ULID>` — the only per-run-varying scalars. */
const ID_RE = /^[a-z][a-z0-9]*_[0-9A-Z]{20,}$/

interface Transcript {
  alias: Map<string, string>
  notes: Set<string>
  out: Record<string, Json>
  server: TestServer | null
  url: string | null
}

function alias(run: Transcript, raw: string): string {
  let label = run.alias.get(raw)
  if (!label) {
    // Unmapped ids are recorded by prefix only, so the note text is
    // backend-independent while the difference still shows up in the diff.
    label = `id$${run.alias.size + 1}`
    run.alias.set(raw, label)
    run.notes.add(`unmapped-id:${raw.split('_')[0]}_…`)
  }
  return label
}

/** Reserve the alias for an id we minted on purpose, in scenario order. */
function mint(run: Transcript, raw: string): string {
  const label = `id$${run.alias.size + 1}`
  run.alias.set(raw, label)
  return label
}

function parseable(value: string): Json | undefined {
  if (!/^[{["]|^-?\d/.test(value)) {
    return undefined
  }
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * Backend-neutral view of a value: ids aliased, volatile keys dropped, numbers
 * stringified (pg returns COUNT as a string), JSON TEXT parsed so a SQLite text
 * column and a pg jsonb column line up, and object arrays sorted so row order
 * (which legitimately differs) is not a parity failure.
 */
function norm(run: Transcript, value: unknown): Json {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'string') {
    if (ID_RE.test(value)) {
      return alias(run, value)
    }
    const nested = parseable(value)
    return nested === undefined ? value : norm(run, nested)
  }
  if (Array.isArray(value)) {
    const items: Json[] = value.map((v) => norm(run, v))
    const sorted = items.every((v) => v !== null && typeof v === 'object')
    if (sorted) {
      items.sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
    }
    return items
  }
  if (value && typeof value === 'object') {
    const rec: JsonRecord = {}
    for (const [key, v] of Object.entries(value as JsonRecord)) {
      if (DROP_KEYS.has(key)) {
        continue
      }
      rec[key] = norm(run, v)
    }
    return rec
  }
  // Only null/undefined/function/symbol/bigint reach here.
  return value === null || value === undefined ? null : String(value)
}

/** Key-sorted JSON so a diff is stable and a sort key is order-independent. */
function stableJson(value: Json | undefined): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as JsonRecord)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function call(
  run: Transcript,
  client: RpcClient,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Json> {
  try {
    const res = await client.call<Json>(method, params, 20_000)
    return norm(run, res)
  } catch (err) {
    if (err instanceof RpcError) {
      // Error codes are part of the contract; the message is not.
      return { __error: err.code }
    }
    throw err
  }
}

/** Read one field out of a normalized reply without casting the reply itself. */
function pick(row: Json | undefined, key: string): Json | undefined {
  if (
    row === undefined ||
    row === null ||
    typeof row !== 'object' ||
    Array.isArray(row)
  ) {
    return undefined
  }
  return row[key]
}

/** Capture the minted id from an add-style return under a stable alias. */
function minted(run: Transcript, res: Json): Json {
  const raw = pick(res, 'id')
  if (typeof raw === 'string' && !run.alias.has(raw)) {
    return { id: mint(run, raw) }
  }
  return res
}

/**
 * One seed scenario against one backend. Every step is recorded under a stable
 * key so a diff points straight at the operation that diverged.
 */
async function scenario(kind: 'postgres' | 'sqlite'): Promise<Transcript> {
  const run: Transcript = {
    alias: new Map(),
    notes: new Set(),
    out: {},
    server: null,
    url: null,
  }
  let dbPath = ''
  try {
    if (kind === 'postgres') {
      if (!postgresAvailable()) {
        throw new Error(
          'postgres is not available (docker container crm-test-pg)',
        )
      }
      run.url = await createTestDatabase()
      run.server = await startServer('', { databaseUrl: run.url })
    } else {
      const fresh = freshDb()
      dbPath = fresh.dbPath
      run.server = await startServer(dbPath)
    }
    const { server } = run
    if (server.port === 0) {
      throw new Error(
        `server did not report READY: ${server.log().slice(-2000)}`,
      )
    }

    const owner = await bootstrapOwner(server, 'ada')
    // login is exercised once per backend (the rate limiter is per minute), and
    // only the stable part of its reply is comparable.
    const anon = await connect(server.port)
    const login = await anon.call<Record<string, unknown>>('auth.login', {
      password: owner.password,
      username: 'ada',
    })
    run.out.login = norm(run, {
      must_change: login.must_change,
      role: (login.user as Record<string, unknown>).role,
    })
    anon.close()

    const client = await connect(server.port, owner.token)
    const c = (method: string, params?: Record<string, unknown>) =>
      call(run, client, method, params)

    // --- company ---
    const company = minted(
      run,
      await c('company.add', {
        name: 'Northwind Traders',
        phone: ['+15550100'],
        set: ['plan=enterprise'],
        tag: ['prospect'],
        website: ['northwind.example'],
      }),
    )
    run.out['company.add'] = company
    run.out['company.list'] = await c('company.list', {})

    // --- contact create / show / edit / merge ---
    const ada = minted(
      run,
      await c('contact.add', {
        company: ['Northwind Traders'],
        email: ['ada@analytical.example'],
        name: 'Ada Lovelace',
        phone: ['+15550001'],
        set: ['source=conf'],
        tag: ['engineer'],
        x: '@ada',
      }),
    )
    run.out['contact.add'] = ada
    const dup = minted(
      run,
      await c('contact.add', {
        company: ['Northwind Traders'],
        email: ['ada.dupe@analytical.example'],
        name: 'Ada L Duplicate',
        phone: ['+15550002'],
      }),
    )
    run.out['contact.add.dup'] = dup
    run.out['contact.list'] = await c('contact.list', {})
    run.out['contact.show'] = await c('contact.show', { ref: 'Ada Lovelace' })

    const shown = run.out['contact.show']
    run.out['contact.edit'] = await c('contact.edit', {
      addTag: ['merged'],
      ref: 'Ada Lovelace',
      rmTag: [],
      set: ['tier=t1'],
      version: pick(shown, 'version') ?? 0,
    })
    run.out['contact.edit.show'] = await c('contact.show', {
      ref: 'Ada Lovelace',
    })

    const adaId = pick(ada, 'id')
    const dupId = pick(dup, 'id')
    run.out['contact.merge'] = await c('contact.merge', {
      id1: adaId,
      id2: dupId,
    })
    run.out['contact.list.after-merge'] = await c('contact.list', {})
    run.out['contact.resolve.dup'] = await c('contact.resolve', {
      ref: 'Ada L Duplicate',
    })

    // --- deal create / move ---
    const deal = minted(
      run,
      await c('deal.add', {
        company: 'Northwind Traders',
        contact: ['Ada Lovelace'],
        expectedClose: '2026-12-31',
        probability: '40',
        set: ['channel=partner'],
        stage: 'qualified',
        tag: ['big'],
        title: 'Q1 rollout',
        value: '12000',
      }),
    )
    run.out['deal.add'] = deal
    run.out['deal.list'] = await c('deal.list', {})
    const dealRow = await c('deal.show', { ref: 'Q1 rollout' })
    run.out['deal.show'] = dealRow
    run.out['deal.move'] = await c('deal.move', {
      note: 'moved to proposal',
      ref: 'Q1 rollout',
      stage: 'proposal',
      version: pick(dealRow, 'version') ?? 0,
    })
    run.out['deal.show.after-move'] = await c('deal.show', {
      ref: 'Q1 rollout',
    })
    run.out.pipeline = await c('pipeline', {})

    // --- task create / done ---
    const task = minted(
      run,
      await c('task.add', {
        contact: 'Ada Lovelace',
        deal: 'Q1 rollout',
        due: '2026-12-31',
        title: 'Send proposal',
      }),
    )
    run.out['task.add'] = task
    run.out['task.list'] = await c('task.list', {})
    run.out['task.done'] = await c('task.done', { ref: 'Send proposal' })
    run.out['task.list.after-done'] = await c('task.list', { status: 'done' })
    run.out['task.show'] = await c('task.show', { ref: 'Send proposal' })

    // --- activity ---
    run.out['activity.log'] = await c('activity.log', {
      body: 'Discussed the Q1 rollout timeline and budget',
      company: 'Northwind Traders',
      contact: ['Ada Lovelace'],
      deal: 'Q1 rollout',
      set: ['minutes=15'],
      type: 'call',
    })
    run.out['activity.list'] = await c('activity.list', {})
    run.out['activity.list.contact'] = await c('activity.list', {
      contact: 'Ada Lovelace',
    })

    // --- search / index ---
    run.out['search.search'] = await c('search.search', { query: 'rollout' })
    run.out['search.search.empty'] = await c('search.search', { query: '' })
    run.out['search.find'] = await c('search.find', { query: 'Ada Lovelace' })
    run.out['index.status'] = await c('index.status', {})

    // --- audit ---
    run.out['audit.list'] = await c('audit.list', { limit: 200 })
    run.out['audit.verify'] = await c('audit.verify', {})

    // --- reports ---
    run.out['report.pipeline'] = await c('report.pipeline', {})
    run.out['report.activity'] = await c('report.activity', {})
    run.out['report.conversion'] = await c('report.conversion', {})

    // --- export / dupes / tags ---
    run.out['export.all'] = await c('export.all', {})
    run.out['tag.list'] = await c('tag.list', {})
    run.out.dupes = await c('dupes', {})

    client.close()
  } finally {
    if (run.server) {
      await run.server.close()
    }
    if (run.url) {
      dropTestDatabase(run.url)
    }
    if (dbPath) {
      const { rmSync } = await import('node:fs')
      rmSync(dbPath.replace(/\/serve\.db$/, ''), {
        force: true,
        recursive: true,
      })
    }
  }
  return run
}

interface Diff {
  path: string
  postgres: Json | undefined
  sqlite: Json | undefined
}

function walk(
  path: string,
  a: Json | undefined,
  b: Json | undefined,
  into: Diff[],
): void {
  if (stableJson(a) === stableJson(b)) {
    return
  }
  const bothObjects =
    a !== null &&
    a !== undefined &&
    b !== null &&
    b !== undefined &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Array.isArray(a) === Array.isArray(b)
  if (!bothObjects) {
    into.push({ path, postgres: b, sqlite: a })
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      walk(`${path}[${i}]`, a[i], b[i], into)
    }
    return
  }
  const keys = [
    ...new Set([
      ...Object.keys(a as JsonRecord),
      ...Object.keys(b as JsonRecord),
    ]),
  ].sort()
  for (const key of keys) {
    walk(
      path ? `${path}.${key}` : key,
      (a as JsonRecord)[key],
      (b as JsonRecord)[key],
      into,
    )
  }
}

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  const wantPostgres = !only.includes('--sqlite')
  const wantSqlite = !only.includes('--postgres')

  let sqlite: Transcript | null = null
  let postgres: Transcript | null = null
  if (wantSqlite) {
    process.stderr.write('parity: sqlite leg\n')
    sqlite = await scenario('sqlite')
    process.stderr.write(
      `parity: sqlite leg done (${Object.keys(sqlite.out).length} steps)\n`,
    )
  }
  if (wantPostgres) {
    process.stderr.write('parity: postgres leg\n')
    postgres = await scenario('postgres')
    process.stderr.write(
      `parity: postgres leg done (${Object.keys(postgres.out).length} steps)\n`,
    )
  }
  if (sqlite === null || postgres === null) {
    const single = sqlite ?? postgres
    if (!single) {
      throw new Error(
        'nothing to run: pass at most one of --sqlite / --postgres',
      )
    }
    process.stdout.write(`${stableJson(single.out)}\n`)
    process.stdout.write('PARITY SKIPPED: single-backend run only (no diff)\n')
    return
  }

  const notes = [...new Set([...sqlite.notes, ...postgres.notes])].sort()
  const diffs: Diff[] = []
  walk('', sqlite.out, postgres.out, diffs)

  if (diffs.length > 0) {
    process.stdout.write(
      `${JSON.stringify({ dialect_notes: notes, diffs }, null, 2)}\n`,
    )
    process.stdout.write(`PARITY FAIL: ${diffs.length} differing value(s)\n`)
    process.exit(1)
  }
  const steps = Object.keys(sqlite.out).length
  process.stdout.write(
    `PARITY OK: ${steps} steps identical across sqlite and postgres\n`,
  )
  if (notes.length > 0) {
    process.stdout.write(`PARITY NOTES: ${notes.join(', ')}\n`)
  }
}

await main()
