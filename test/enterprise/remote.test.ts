/**
 * P2 — thin-client mode: every data command works against a server via
 * CRM_SERVER + CRM_TOKEN, with zero local database access.
 *
 * Exit criteria under test:
 *  - same command surface, identical behavior local vs remote
 *  - remote CLI never opens/creates a local DB (isolated HOME stays clean)
 *  - role gating: reader read-only, writer no admin, FORBIDDEN on breach
 *  - server-side hooks enforce on remote writes
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createClient } from '@libsql/client'

import {
  bootstrapOwner,
  connect,
  freshDb,
  REPO,
  startServer,
  type TestServer,
} from './helpers'

const CRM = join(REPO, 'src', 'cli.ts')

interface RunResult {
  exitCode: number
  stderr: string
  stdout: string
}

/** Run the CLI in remote mode with a fully isolated HOME. */
function remoteRun(
  server: TestServer,
  token: string,
  args: string[],
  extraEnv?: Record<string, string>,
): RunResult & { home: string } {
  const home = mkdtempSync(join(tmpdir(), 'crm-remote-home-'))
  const proc = Bun.spawnSync(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: home,
      CRM_SERVER: `127.0.0.1:${server.port}`,
      CRM_TOKEN: token,
      CRM_INSECURE: '1',
      CRM_CONFIG: '/dev/null',
      ...extraEnv,
    },
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
    home,
  }
}

/** Run the CLI in local mode against a scratch db (for parity comparisons). */
function localRun(dbPath: string, args: string[]): RunResult {
  const proc = Bun.spawnSync(['bun', 'run', CRM, '--db', dbPath, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CRM_CONFIG: '/dev/null',
    },
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  }
}

/**
 * Normalize generated ids and timestamps so local vs remote output of the
 * same logical dataset compares equal.
 */
function normalize(s: string): string {
  return (
    s
      .replace(/\b[a-z]{2}_[A-Za-z0-9]{26}\b/g, 'ID')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'TS')
      // P3: version numbers advance identically on both legs; updated_by is
      // only populated remotely (local mode has no identity) — both are
      // environment-specific, like the normalized IDs/timestamps above.
      .replace(/^version: \d+$/gm, 'version: V')
      .replace(/^updated_by: \S+$/gm, 'updated_by: U')
      // JSON form of the same fields (show --format json)
      .replace(/"updated_by": (null|"[^"]*")/g, '"updated_by": "U"')
  )
}

/** Read a column of a table straight from the server's db file. */
async function serverDbRows(
  dbPath: string,
  table: string,
  column: string,
): Promise<string[]> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const rows = await client.execute({
      sql: `SELECT ${column} FROM ${table}`,
    })
    return rows.rows.map((r) => String(r[0]))
  } finally {
    client.close()
  }
}

async function makeRoleToken(
  server: TestServer,
  ownerToken: string,
  username: string,
  role: string,
): Promise<string> {
  const client = await connect(server.port, ownerToken)
  try {
    await client.call('admin.user.create', { username, role })
    const created = await client.call<{ token: string }>('admin.token.create', {
      name: `${username}-token`,
      username,
    })
    return created.token
  } finally {
    client.close()
  }
}

async function withServer(
  fn: (server: TestServer, owner: { token: string }) => void | Promise<void>,
): Promise<void> {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    await fn(server, owner)
  } finally {
    await server.close()
    cleanup()
  }
}

// Seed the same logical dataset in a given environment (local db or server).
// Returns the deal ids in insertion order.
function seed(
  server: TestServer | null,
  ownerToken: string,
  dbPath: string | null,
): string[] {
  const run = server
    ? (args: string[]) => remoteRun(server, ownerToken, args)
    : (args: string[]) => localRun(dbPath as string, args)

  const r1 = run([
    'contact',
    'add',
    '--name',
    'Ada Lovelace',
    '--email',
    'ada@analytical.engine',
    '--phone',
    '+12125551001',
    '--company',
    'Analytical Engines',
    '--tag',
    'vip',
    '--set',
    'title=Engineer',
  ])
  expect(r1.exitCode, r1.stderr).toBe(0)
  const r2 = run([
    'contact',
    'add',
    '--name',
    'Alan Turing',
    '--email',
    'alan@turing.math',
    '--phone',
    '+442079460000',
  ])
  expect(r2.exitCode, r2.stderr).toBe(0)
  const r3 = run([
    'company',
    'add',
    '--name',
    'Turing Works',
    '--website',
    'https://turing.works',
    '--tag',
    'startup',
  ])
  expect(r3.exitCode, r3.stderr).toBe(0)
  const r4 = run([
    'deal',
    'add',
    '--title',
    'Consulting engagement',
    '--value',
    '25000',
    '--contact',
    'Ada Lovelace',
    '--company',
    'Turing Works',
    '--stage',
    'qualified',
  ])
  expect(r4.exitCode, r4.stderr).toBe(0)
  const r5 = run([
    'deal',
    'add',
    '--title',
    'Pilot program',
    '--value',
    '5000',
    '--contact',
    'alan@turing.math',
  ])
  expect(r5.exitCode, r5.stderr).toBe(0)
  const r6 = run([
    'log',
    'call',
    'Intro call with Ada',
    '--contact',
    'Ada Lovelace',
  ])
  expect(r6.exitCode, r6.stderr).toBe(0)
  const r7 = run(['log', 'meeting', 'Kickoff', '--deal', r5.stdout.trim()])
  expect(r7.exitCode, r7.stderr).toBe(0)
  const r8 = run(['tag', r5.stdout.trim(), 'press'])
  expect(r8.exitCode, r8.stderr).toBe(0)
  return [r4.stdout.trim(), r5.stdout.trim()]
}

describe('P2 remote: CRUD parity', () => {
  test('identical behavior local vs remote for the core data surface', async () => {
    const { dbPath, cleanup } = freshDb()
    const server = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const localDb = join(dirname(dbPath), 'local-parity.db')

      const remoteDeals = await seed(server, owner.token, null)
      expect(remoteDeals).toHaveLength(2)
      expect(remoteDeals[0]).toMatch(/^dl_[A-Za-z0-9]{26}$/)
      await seed(null, owner.token, localDb)

      const pairs: [string[], string[]][] = [
        [
          ['contact', 'list', '--format', 'json'],
          ['contact', 'list', '--format', 'json'],
        ],
        [
          ['contact', 'list', '--tag', 'vip', '--format', 'json'],
          ['contact', 'list', '--tag', 'vip', '--format', 'json'],
        ],
        [
          ['contact', 'show', 'ada@analytical.engine', '--format', 'json'],
          ['contact', 'show', 'ada@analytical.engine', '--format', 'json'],
        ],
        [
          ['company', 'list', '--format', 'json'],
          ['company', 'list', '--format', 'json'],
        ],
        [
          ['company', 'show', 'Turing Works', '--format', 'json'],
          ['company', 'show', 'Turing Works', '--format', 'json'],
        ],
        [
          ['deal', 'list', '--format', 'json'],
          ['deal', 'list', '--format', 'json'],
        ],
        [
          ['deal', 'show', 'Consulting engagement', '--format', 'json'],
          ['deal', 'show', 'Consulting engagement', '--format', 'json'],
        ],
        [
          ['activity', 'list', '--format', 'json'],
          ['activity', 'list', '--format', 'json'],
        ],
        [
          ['pipeline', '--format', 'json'],
          ['pipeline', '--format', 'json'],
        ],
        [
          ['find', 'analytical', '--format', 'json'],
          ['find', 'analytical', '--format', 'json'],
        ],
        [
          ['search', 'Turing Works', '--format', 'json'],
          ['search', 'Turing Works', '--format', 'json'],
        ],
        [
          ['report', 'pipeline', '--format', 'json'],
          ['report', 'pipeline', '--format', 'json'],
        ],
        [
          ['report', 'activity', '--by', 'type', '--format', 'json'],
          ['report', 'activity', '--by', 'type', '--format', 'json'],
        ],
        [
          [
            'dupes',
            '--type',
            'contact',
            '--threshold',
            '0.1',
            '--format',
            'json',
          ],
          [
            'dupes',
            '--type',
            'contact',
            '--threshold',
            '0.1',
            '--format',
            'json',
          ],
        ],
        [
          ['export', 'all', '--format', 'json'],
          ['export', 'all', '--format', 'json'],
        ],
        [
          ['tag', 'list', '--format', 'json'],
          ['tag', 'list', '--format', 'json'],
        ],
      ]
      for (const [rArgs, lArgs] of pairs) {
        const r = remoteRun(server, owner.token, rArgs)
        const l = localRun(localDb, lArgs)
        expect(
          normalize(r.stdout),
          `remote: crm ${rArgs.join(' ')}\n${r.stderr}\nlocal: crm ${lArgs.join(' ')}\n${l.stderr}`,
        ).toBe(normalize(l.stdout))
      }

      // index status: same counts (indexed == table sizes after seeding)
      const idxR = remoteRun(server, owner.token, ['index', 'status'])
      const idxL = localRun(localDb, ['index', 'status'])
      expect(normalize(idxR.stdout)).toBe(normalize(idxL.stdout))
    } finally {
      await server.close()
      cleanup()
    }
  }, 120_000)

  test('remote writes land in the server db and nowhere else', async () => {
    await withServer(async (server, owner) => {
      const r = remoteRun(server, owner.token, [
        'contact',
        'add',
        '--name',
        'Grace Hopper',
        '--email',
        'grace@navy.mil',
      ])
      expect(r.exitCode, r.stderr).toBe(0)
      const id = r.stdout.trim()
      expect(id).toMatch(/^ct_[A-Za-z0-9]{26}$/)

      // Present in the server's database…
      const names = await serverDbRows(server.dbPath, 'contacts', 'name')
      expect(names).toContain('Grace Hopper')

      // …and the isolated HOME has no .crm directory (zero local db access).
      expect(existsSync(join(r.home, '.crm'))).toBe(false)
    })
  })

  test('duplicate email is rejected with identical error locally and remotely', async () => {
    await withServer((server, owner) => {
      remoteRun(server, owner.token, [
        'contact',
        'add',
        '--name',
        'A',
        '--email',
        'a@x.com',
      ])
      const dupRemote = remoteRun(server, owner.token, [
        'contact',
        'add',
        '--name',
        'B',
        '--email',
        'a@x.com',
      ])
      // duplicate email is a CONFLICT → exit 3 on both sides (P3 exit-code
      // model: 0 ok, 1 error, 3 conflict)
      expect(dupRemote.exitCode).toBe(3)
      expect(dupRemote.stderr).toContain('duplicate email "a@x.com"')

      const { dbPath } = freshDb()
      localRun(dbPath, ['contact', 'add', '--name', 'A', '--email', 'a@x.com'])
      const dupLocal = localRun(dbPath, [
        'contact',
        'add',
        '--name',
        'B',
        '--email',
        'a@x.com',
      ])
      expect(dupLocal.exitCode).toBe(3)
      expect(dupLocal.stderr).toContain('duplicate email "a@x.com"')
    })
  })

  test('deal move works remotely and records a stage-change activity', async () => {
    await withServer((server, owner) => {
      const r = remoteRun(server, owner.token, [
        'deal',
        'add',
        '--title',
        'Enterprise rollout',
        '--value',
        '100000',
      ])
      expect(r.exitCode, r.stderr).toBe(0)
      const deal = r.stdout.trim()
      const m = remoteRun(server, owner.token, [
        'deal',
        'move',
        deal,
        '--stage',
        'negotiation',
        '--note',
        'legal review',
      ])
      expect(m.exitCode, m.stderr).toBe(0)
      expect(m.stdout.trim()).toBe(deal)

      const shown = remoteRun(server, owner.token, [
        'deal',
        'show',
        deal,
        '--format',
        'json',
      ])
      const dealObj = JSON.parse(shown.stdout)
      expect(dealObj.stage).toBe('negotiation')

      const acts = remoteRun(server, owner.token, [
        'activity',
        'list',
        '--type',
        'stage-change',
        '--format',
        'json',
      ])
      const actObj = JSON.parse(acts.stdout) as Array<{ body: string }>
      expect(actObj.length).toBe(1)
      expect(actObj[0].body).toBe('from lead to negotiation | legal review')
    })
  })

  test('edit and merge work remotely', async () => {
    await withServer((server, owner) => {
      const r1 = remoteRun(server, owner.token, [
        'contact',
        'add',
        '--name',
        'Marie Curie',
        '--email',
        'marie@radium.institute',
      ])
      const r2 = remoteRun(server, owner.token, [
        'contact',
        'add',
        '--name',
        'Marie Curi',
        '--email',
        'marie@radium2.institute',
        '--phone',
        '+33145550000',
      ])
      expect(r1.exitCode, r1.stderr).toBe(0)
      expect(r2.exitCode, r2.stderr).toBe(0)

      const e = remoteRun(server, owner.token, [
        'contact',
        'edit',
        'marie@radium.institute',
        '--add-tag',
        'physicist',
        '--set',
        'field=radioactivity',
      ])
      expect(e.exitCode, e.stderr).toBe(0)

      const mg = remoteRun(server, owner.token, [
        'contact',
        'merge',
        r1.stdout.trim(),
        r2.stdout.trim(),
      ])
      expect(mg.exitCode, mg.stderr).toBe(0)
      expect(mg.stdout.trim()).toBe(r1.stdout.trim())

      const shown = remoteRun(server, owner.token, [
        'contact',
        'show',
        r1.stdout.trim(),
        '--format',
        'json',
      ])
      const c = JSON.parse(shown.stdout)
      expect(c.emails).toEqual(
        expect.arrayContaining(['marie@radium2.institute']),
      )
      expect(c.tags).toEqual(expect.arrayContaining(['physicist']))
    })
  })

  test('rm requires --force remotely and cascades', async () => {
    await withServer(async (server, owner) => {
      const r = remoteRun(server, owner.token, [
        'contact',
        'add',
        '--name',
        'ToDelete',
        '--email',
        'delete@x.com',
      ])
      const id = r.stdout.trim()
      const noForce = remoteRun(server, owner.token, ['contact', 'rm', id])
      expect(noForce.exitCode).toBe(1)
      expect(noForce.stderr).toContain('without --force')
      // still there
      expect(
        (await serverDbRows(server.dbPath, 'contacts', 'id')).includes(id),
      ).toBe(true)

      const forced = remoteRun(server, owner.token, [
        'contact',
        'rm',
        id,
        '--force',
      ])
      expect(forced.exitCode, forced.stderr).toBe(0)
      expect(
        (await serverDbRows(server.dbPath, 'contacts', 'id')).includes(id),
      ).toBe(false)
    })
  })

  test('import contacts via csv over remote', async () => {
    await withServer(async (server, owner) => {
      const csvFile = join(
        mkdtempSync(join(tmpdir(), 'crm-import-')),
        'people.csv',
      )
      writeFileSync(
        csvFile,
        'name,email,company,tags\nImport One,i1@imp.io,ImpCo,imp\nImport Two,i2@imp.io,,imp\n',
      )
      const dry = remoteRun(server, owner.token, [
        'import',
        'contacts',
        csvFile,
        '--dry-run',
      ])
      expect(dry.exitCode, dry.stderr).toBe(0)
      expect(dry.stdout).toContain('[dry-run] Import One')
      expect(dry.stdout).toContain('Imported: 2, skipped: 0, errors: 0')

      const real = remoteRun(server, owner.token, [
        'import',
        'contacts',
        csvFile,
      ])
      expect(real.exitCode, real.stderr).toBe(0)
      expect(real.stdout).toContain('Imported: 2, skipped: 0, errors: 0')
      const names = await serverDbRows(server.dbPath, 'contacts', 'name')
      expect(names).toEqual(
        expect.arrayContaining(['Import One', 'Import Two']),
      )

      // duplicate import is skipped, not errored
      const again = remoteRun(server, owner.token, [
        'import',
        'contacts',
        csvFile,
      ])
      expect(again.stdout).toContain('Imported: 0, skipped: 2, errors: 0')
    })
  })

  test('remote client uses zero local db access (no .crm anywhere)', async () => {
    await withServer((server, owner) => {
      const results: string[] = []
      for (const args of [
        ['contact', 'list'],
        ['company', 'list'],
        ['deal', 'list'],
        ['pipeline'],
        ['find', 'nope'],
        ['report', 'won'],
        ['export', 'contacts', '--format', 'json'],
        ['dupes'],
        ['index', 'status'],
        ['tag', 'list'],
        ['activity', 'list'],
      ]) {
        const r = remoteRun(server, owner.token, args)
        expect(r.exitCode, `${args.join(' ')}: ${r.stderr}`).toBe(0)
        results.push(r.home)
      }
      for (const home of results) {
        // macOS may create system dirs (Library) in a fresh HOME; the
        // meaningful guarantee is that the CLI never creates .crm (its db
        // and credentials live there).
        expect(
          existsSync(join(home, '.crm')),
          `HOME ${home} must not gain a .crm dir`,
        ).toBe(false)
      }
    })
  })
})

describe('P2 remote: RBAC', () => {
  test('reader can read but not write; writer cannot admin', async () => {
    await withServer(async (server, owner) => {
      const writerToken = await makeRoleToken(
        server,
        owner.token,
        'writer1',
        'writer',
      )
      const readerToken = await makeRoleToken(
        server,
        owner.token,
        'reader1',
        'reader',
      )

      // reader: read works
      const list = remoteRun(server, readerToken, ['contact', 'list'])
      expect(list.exitCode, list.stderr).toBe(0)
      // reader: write forbidden
      const add = remoteRun(server, readerToken, [
        'contact',
        'add',
        '--name',
        'Nope',
      ])
      expect(add.exitCode).toBe(1)
      expect(add.stderr).toContain('role "reader" cannot call contact.add')

      // writer: write works
      const wAdd = remoteRun(server, writerToken, [
        'contact',
        'add',
        '--name',
        'Writer Contact',
        '--email',
        'w@x.com',
      ])
      expect(wAdd.exitCode, wAdd.stderr).toBe(0)
      // writer: admin forbidden
      const admin = remoteRun(server, writerToken, ['admin', 'user', 'list'])
      expect(admin.exitCode).toBe(1)
      expect(admin.stderr).toContain(
        'role "writer" cannot call admin.user.list',
      )
      // writer: owner-only admin forbidden too
      const whoami = remoteRun(server, writerToken, ['whoami'])
      expect(whoami.exitCode, whoami.stderr).toBe(0)
    })
  })
})

describe('P2 remote: server-side hooks', () => {
  test('pre-contact-add hook on the server rejects remote adds', async () => {
    const { dbPath, cleanup } = freshDb()
    const dir = join(dbPath, '..')
    writeFileSync(
      join(dir, 'hook-reject.sh'),
      '#!/bin/sh\necho "blocked by policy" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const hookConfig = join(dir, 'server-config.toml')
    writeFileSync(
      hookConfig,
      `[phone]
default_country = "US"

[serve]
cert = ""

[hooks]
enabled = true
pre-contact-add = "${join(dir, 'hook-reject.sh')}"
`,
    )
    const server = await startServer(dbPath, { configPath: hookConfig })
    try {
      const owner = await bootstrapOwner(server)
      const r = remoteRun(server, owner.token, [
        'contact',
        'add',
        '--name',
        'Hooked',
      ])
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('pre-contact-add hook rejected creation')
    } finally {
      await server.close()
      cleanup()
    }
  })
})
