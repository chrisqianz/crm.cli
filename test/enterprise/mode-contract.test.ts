/**
 * Mode contract: once you are logged in (a session is saved), data
 * commands target the server by default — no `--remote` needed. Local
 * mode becomes an explicit opt-out: `--local`, `CRM_LOCAL=1`, or an
 * explicit `--db <file>`. A quiet note is printed whenever local mode
 * wins while a session is active, so nobody silently edits the wrong
 * database again.
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

import { bootstrapOwner, startServer, type TestServer } from './helpers'

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

/** Spawn the CLI with an isolated HOME; return { code, out }. */
function run(
  home: string,
  args: string[],
  extra: Record<string, string> = {},
): { code: number; out: string } {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: join(import.meta.dir, '..', '..'),
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      CRM_CONFIG: '/dev/null',
      ...extra,
    },
  })
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
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

describe('mode contract: a saved session implies remote', () => {
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
    // the isolated local db stayed empty
    const local = run(home, ['contact', 'list', '--local'])
    expect(local.out).not.toContain('ModeContractA')
  })

  // interim contract — rewritten in Task 3 (spec/client-repl.md A1)
  test('--local without a db path fails and invents nothing', async () => {
    await setUp()
    const home = homeWithSession()
    const r = run(home, ['contact', 'add', 'ModeContractB', '--local'])
    expect(r.code).toBe(1)
    // short substring on purpose: the final copy is Task 3's NOT_CONNECTED
    expect(r.out).toMatch(/crm login|needs --db/)
    expect(existsSync(join(home, '.crm', 'crm.db'))).toBe(false)
    expect(dbFilesUnder(home)).toEqual([])
  })

  test('an explicit --db beats the session', async () => {
    await setUp()
    const home = homeWithSession()
    const db = join(mkdtempSync(join(tmpdir(), 'crm-mode-db-')), 'x.db')
    const r = run(home, ['contact', 'add', 'ModeContractC', '--db', db])
    expect(r.code).toBe(0)
    expect(serverContacts()).not.toContain('ModeContractC')
    expect(run(home, ['contact', 'list', '--db', db]).out).toContain(
      'ModeContractC',
    )
  })

  // interim contract — rewritten in Task 3 (spec/client-repl.md A1)
  test('CRM_LOCAL=1 without a db path fails and invents nothing', async () => {
    await setUp()
    const home = homeWithSession()
    const r = run(home, ['contact', 'add', 'ModeContractD'], { CRM_LOCAL: '1' })
    expect(r.code).toBe(1)
    // short substring on purpose: the final copy is Task 3's NOT_CONNECTED
    expect(r.out).toMatch(/crm login|needs --db/)
    expect(existsSync(join(home, '.crm', 'crm.db'))).toBe(false)
    expect(dbFilesUnder(home)).toEqual([])
  })

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
