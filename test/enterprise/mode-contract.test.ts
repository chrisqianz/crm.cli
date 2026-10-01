/**
 * Mode contract — the authoritative living documentation of how a `crm` data
 * command picks its target (spec/client-repl.md A1). Every test below is
 * labelled with the step of the resolution order it pins, as implemented by
 * `resolveEndpoint()` / `remoteEndpoint()` in src/remote/dispatch.ts:
 *
 *   1. CRM_SERVER + CRM_TOKEN → remote (agent/service pattern)
 *   2. --remote / config [remote] server → remote (explicit opt-in)
 *   3. explicit local intent → local. `--db` names a database by definition
 *      and beats a saved session; `--local` / `CRM_LOCAL=1` are a switch, not
 *      a target, and die with NOT_CONNECTED unless a database is nameable
 *      (`--db`, CRM_DB or a config [database] path).
 *   4. a saved session → remote (a CRM_SERVER that names another server dies);
 *      with no session, a [database] path the user declared in their own
 *      config → local.
 *   5. nothing named a target → NOT_CONNECTED. There is no implicit local
 *      mode and no database path is ever invented, so a client leaves no
 *      local data behind.
 *
 * When local mode wins while a session is active, dispatch() prints a quiet
 * note to stderr so nobody silently edits the wrong database.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NOT_CONNECTED } from '../../src/remote/dispatch'
import { bootstrapOwner, startServer, type TestServer } from './helpers'

/**
 * Prefix of the fixed local-mode note that dispatch() writes to stderr when
 * local mode wins over a session — see the `console.error` in
 * src/remote/dispatch.ts (`note: local mode — you are logged in to
 * <server> as <user>; use --remote …`). Asserted as a prefix plus the values
 * it interpolates, so the test does not restate the whole sentence.
 */
const LOCAL_NOTE = 'note: local mode — you are logged in to'

let srv: TestServer | null = null
let token = ''
let serverDir = ''

async function setUp() {
  if (srv) {
    return
  }
  serverDir = mkdtempSync(join(tmpdir(), 'crm-mode-'))
  srv = await startServer(join(serverDir, 'server.db'))
  token = (await bootstrapOwner(srv)).token
}

afterAll(async () => {
  if (srv) {
    await srv.close()
  }
})

function homeWithSession(): string {
  const home = mkdtempSync(join(tmpdir(), 'crm-mode-home-'))
  mkdirSync(join(home, '.crm'), { recursive: true })
  writeFileSync(
    join(home, '.crm', 'credentials'),
    JSON.stringify({
      server: `127.0.0.1:${srv?.port}`,
      token,
      username: 'admin',
      // a self-signed demo server: login --insecure recorded this
      insecure: true,
    }),
  )
  return home
}

/**
 * A config file that declares `[database] path` — the user-side declaration
 * that makes local mode nameable (spec/client-repl.md A1 step 4). Pass it as
 * CRM_CONFIG so it counts as explicitly selected, i.e. trusted.
 */
function writeDatabaseConfig(home: string, dbPath: string): string {
  const cfg = join(home, 'crm.toml')
  writeFileSync(cfg, `[database]\npath = "${dbPath}"\n`)
  return cfg
}

/** Spawn the CLI with an isolated HOME; return { code, out, err }. */
function run(
  home: string,
  args: string[],
  extra: Record<string, string> = {},
): { code: number; out: string; err: string } {
  // Hermeticity: a CRM_DB / CRM_LOCAL / CRM_INSECURE left in the developer's
  // or CI's environment must not silently decide the mode under test. A test
  // that wants one passes it through `extra`, which is merged last.
  const {
    CRM_DB: _inheritedDb,
    CRM_LOCAL: _inheritedLocal,
    CRM_INSECURE: _inheritedInsecure,
    ...baseEnv
  } = process.env
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: join(import.meta.dir, '..', '..'),
    env: {
      ...baseEnv,
      HOME: home,
      NO_COLOR: '1',
      CRM_CONFIG: '/dev/null',
      ...extra,
    },
  })
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
    err: proc.stderr.toString(),
  }
}

/**
 * Every `*.db` under `dir`, recursively. A zero-footprint assertion wants
 * "no database appeared anywhere", not just "not at the usual path".
 */
function dbFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...dbFilesUnder(p))
    } else if (entry.name.endsWith('.db')) {
      found.push(p)
    }
  }
  return found
}

/** Authoritative server-side contact list (agent pattern). */
function serverContacts(): string[] {
  const home = mkdtempSync(join(tmpdir(), 'crm-mode-srv-'))
  const r = run(home, ['contact', 'list', '--format', 'json'], {
    CRM_SERVER: `127.0.0.1:${srv?.port}`,
    CRM_TOKEN: token,
    CRM_INSECURE: '1',
  })
  const rows = JSON.parse(r.out) as Record<string, string>[]
  return rows.map((c) => c.name)
}

describe('mode contract: how a data command resolves its target', () => {
  // Step 4, first clause: a saved session is the default answer.
  test('no flags at all: the write lands on the server, not the local db', async () => {
    await setUp()
    const home = homeWithSession()
    const r = run(home, [
      'contact',
      'add',
      'ModeContractA',
      '--email',
      'mc@a.com',
    ])
    expect(r.code).toBe(0)
    expect(serverContacts()).toContain('ModeContractA')
    // Nothing local was written: under this contract there is no local db to
    // compare against — `contact list --local` cannot even be asked, because
    // --local without a nameable database fails (step 3). Zero footprint is
    // the stronger, honest form of "the local db stayed empty".
    expect(dbFilesUnder(home)).toEqual([])
  })

  // Step 3, second clause: --local is an opt-out switch, not a target. With
  // nothing naming a database it fails, and invents nothing.
  test('--local without a db path fails with NOT_CONNECTED', async () => {
    await setUp()
    const home = homeWithSession()
    const r = run(home, ['contact', 'add', 'ModeContractB', '--local'])
    expect(r.code).toBe(1)
    expect(r.out).toContain(NOT_CONNECTED)
    expect(existsSync(join(home, '.crm', 'crm.db'))).toBe(false)
    expect(dbFilesUnder(home)).toEqual([])
  })

  // Same clause via the env switch: CRM_LOCAL=1 alone cannot conjure local
  // mode either.
  test('CRM_LOCAL=1 without a db path fails with NOT_CONNECTED', async () => {
    await setUp()
    const home = homeWithSession()
    const r = run(home, ['contact', 'add', 'ModeContractD'], { CRM_LOCAL: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain(NOT_CONNECTED)
    expect(existsSync(join(home, '.crm', 'crm.db'))).toBe(false)
    expect(dbFilesUnder(home)).toEqual([])
  })

  // Step 3, first clause: a named database beats the session — and the user
  // is told, because the session is still live.
  test('--local plus an explicit --db beats the session and says so', async () => {
    await setUp()
    const home = homeWithSession()
    const db = join(mkdtempSync(join(tmpdir(), 'crm-mode-db-')), 'local.db')
    const r = run(home, [
      'contact',
      'add',
      'ModeContractC',
      '--local',
      '--db',
      db,
    ])
    expect(r.code).toBe(0)
    expect(r.err).toContain(LOCAL_NOTE)
    expect(r.err).toContain(`127.0.0.1:${srv?.port} as admin`)
    expect(serverContacts()).not.toContain('ModeContractC')
    expect(run(home, ['contact', 'list', '--db', db]).out).toContain(
      'ModeContractC',
    )
  })

  // Same clause without the switch: --db alone is an explicit local target.
  test('a bare --db beats the session and says so', async () => {
    await setUp()
    const home = homeWithSession()
    const db = join(mkdtempSync(join(tmpdir(), 'crm-mode-db-')), 'x.db')
    const r = run(home, ['contact', 'add', 'ModeContractG', '--db', db])
    expect(r.code).toBe(0)
    expect(r.err).toContain(LOCAL_NOTE)
    expect(r.err).toContain(`127.0.0.1:${srv?.port} as admin`)
    expect(serverContacts()).not.toContain('ModeContractG')
    expect(run(home, ['contact', 'list', '--db', db]).out).toContain(
      'ModeContractG',
    )
  })

  // Step 4: a declared [database] path is local mode only while nothing
  // higher in the order claims the command — a session outranks it.
  test('a config [database] path does not outrank a saved session', async () => {
    await setUp()
    const home = homeWithSession()
    const db = join(home, 'declared.db')
    const cfg = writeDatabaseConfig(home, db)
    const r = run(
      home,
      ['contact', 'add', 'ModeContractE', '--email', 'mc@e.com'],
      { CRM_CONFIG: cfg },
    )
    expect(r.code).toBe(0)
    expect(serverContacts()).toContain('ModeContractE')
    // Local mode never won, so no local database was opened at all: the
    // declared file is absent, not merely missing the row.
    expect(r.err).not.toContain(LOCAL_NOTE)
    expect(existsSync(db)).toBe(false)
    expect(dbFilesUnder(home)).toEqual([])
  })

  // Control for the case above: the same config really does name a usable
  // local target once the session stops winning, so "session wins" is not a
  // test that passes because the [database] path was never parsed.
  test('with no session, a config [database] path is the local target', async () => {
    await setUp()
    const home = mkdtempSync(join(tmpdir(), 'crm-mode-home-'))
    const db = join(home, 'declared.db')
    const cfg = writeDatabaseConfig(home, db)
    const r = run(
      home,
      ['contact', 'add', 'ModeContractH', '--email', 'mc@h.com'],
      { CRM_CONFIG: cfg },
    )
    expect(r.code).toBe(0)
    // Nothing was logged in, so there is nothing to warn about.
    expect(r.err).not.toContain(LOCAL_NOTE)
    expect(serverContacts()).not.toContain('ModeContractH')
    expect(existsSync(db)).toBe(true)
    expect(run(home, ['contact', 'list', '--db', db]).out).toContain(
      'ModeContractH',
    )
  })

  // Step 4 guard: the session may be used, not substituted.
  test('CRM_SERVER pointing at another server is refused, not mixed', async () => {
    await setUp()
    const home = homeWithSession()
    const r = run(home, ['contact', 'add', 'X'], {
      CRM_SERVER: '127.0.0.1:9', // a different (unreachable) server
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('does not match')
  })
})
