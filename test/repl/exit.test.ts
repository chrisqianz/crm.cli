/**
 * Piped REPL sessions must exit on their own when the loop ends
 * (spec/client-repl.md R5): a supervisor that keeps the stdin pipe open
 * must not keep the process alive. What actually held these processes
 * was the transport: concurrent dispatches raced the one-shot connect
 * (the fire-and-forget warm vs. the first command) and orphaned a TLS
 * socket that nothing ever closed; the REPL also kept its connection
 * alive with no exit-time close, and logout left the live client and
 * the ref planes behind. With dispatch's single-flight connect guard
 * and the REPL's keep-alive/close-on-exit, every shape below exits.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RpcClient } from '../../src/lib/rpc'
import {
  bootstrapOwner,
  freshDb,
  startServer,
  type TestServer,
} from '../enterprise/helpers'

const REPO = join(import.meta.dir, '..', '..')
const CLI = join(REPO, 'src', 'cli.ts')
const SUPERVISOR = join(import.meta.dir, 'fixtures', 'repl-supervisor.ts')

/** Spawn `crm` under test/repl/fixtures/repl-supervisor.ts, whose stdin
 * pipe stays OPEN after the input is written. Exit 8 (or the marker line
 * `SUPERVISOR_HELD_STILL_RUNNING`) means the REPL never exited. The
 * caller owns `env.HOME` (an isolated dir) and cleans it up: the
 * login/logout lines write ~/.crm/credentials, and the real user's home
 * must never see a test server address. */
function spawnRepl(
  input: string,
  env: Record<string, string>,
  hold: number,
  argv: string[] = [],
) {
  const payload = Buffer.from(
    JSON.stringify({ cli: CLI, repo: REPO, input, hold, argv, env }),
  ).toString('base64')
  // `bun` on PATH — process.execPath inside `bun test` is a runner shim
  // that cannot launch a .ts entry directly.
  return Bun.spawn(['bun', SUPERVISOR, payload], {
    stdout: 'pipe',
    stderr: 'ignore',
    // clean-room env: the test process's CRM_* vars must not reach the REPL
    env: {
      HOME: process.env.HOME ?? '/tmp',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NO_COLOR: '1',
    },
  })
}

/** Wait for the child, then read everything it printed. */
async function settle(
  p: Bun.Subprocess,
  watchdogMs: number,
): Promise<{ outcome: number | 'alive'; stdout: string }> {
  const outcome = await Promise.race([
    p.exited.then((code) => code),
    Bun.sleep(watchdogMs).then(() => 'alive' as const),
  ])
  const stream = p.stdout
  if (typeof stream !== 'object' || stream === null) {
    p.kill()
    return { outcome, stdout: '' }
  }
  const stdout = await new Response(stream).text()
  p.kill()
  return { outcome, stdout }
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'crm-repl-home-'))
}

test('q exits the process even while the pipe stays open', async () => {
  const home = freshHome()
  try {
    const p = spawnRepl(
      'q\n',
      { HOME: home, CRM_REPL_FORCE: '1', CRM_CONFIG: '/dev/null' },
      6,
    )
    const { outcome, stdout } = await settle(p, 15_000)
    expect(stdout).toContain('crm>') // the REPL really started
    expect(outcome).toBe(0) // 8 = supervisor watchdog: the child never exited
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a remote session exits too — warm sockets must not hold it open', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  const home = freshHome()
  try {
    const owner = await bootstrapOwner(server)
    const p = spawnRepl(
      'q\n',
      {
        HOME: home,
        CRM_REPL_FORCE: '1',
        CRM_CONFIG: '/dev/null',
        CRM_SERVER: `127.0.0.1:${server.port}`,
        CRM_INSECURE: '1',
        CRM_TOKEN: owner.token,
      },
      6,
    )
    const { outcome, stdout } = await settle(p, 15_000)
    expect(stdout).toContain('crm>')
    // The two warms run concurrently on one guarded connect; whatever
    // their interleaving, the session must hold at most one connection
    // and close it on exit — no orphaned socket to spin the loop.
    expect(outcome).toBe(0)
  } finally {
    await server.close()
    cleanup()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a session that warmed and used the connection still exits', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  const home = freshHome()
  try {
    const owner = await bootstrapOwner(server)
    const p = spawnRepl(
      'contact add "Exit Smoke"\nq\n',
      {
        HOME: home,
        CRM_REPL_FORCE: '1',
        CRM_CONFIG: '/dev/null',
        CRM_SERVER: `127.0.0.1:${server.port}`,
        CRM_INSECURE: '1',
        CRM_TOKEN: owner.token,
      },
      6,
    )
    const { outcome, stdout } = await settle(p, 15_000)
    expect(stdout).toContain('ct_') // the add really went through
    expect(outcome).toBe(0)
  } finally {
    await server.close()
    cleanup()
    rmSync(home, { recursive: true, force: true })
  }
})

test('logout tears down the live session — the next login owns the connection', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  const home = freshHome()
  try {
    const owner = await bootstrapOwner(server)
    // A second, unprivileged account: if the pre-logout connection
    // survives, its owner identity silently rides along into the
    // reader's session, and this write would succeed.
    const admin = await RpcClient.connect(server.port, '127.0.0.1', {
      insecure: true,
    })
    await admin.call('auth.token', { token: owner.token })
    const created = await admin.call<{
      user: { username: string }
      initial_password: string
    }>('admin.user.create', { username: 'viewer', role: 'reader' })
    const viewerPassword = created.initial_password
    admin.close()
    // No CRM_TOKEN on purpose: the only credential at any point is the
    // session the login wizard saves.
    const p = spawnRepl(
      `${[
        'login',
        owner.username,
        owner.password,
        'contact add "Owner Row"',
        'logout',
        'login',
        created.user.username,
        viewerPassword,
        'contact add "Viewer Row"',
        'q',
      ].join('\n')}\n`,
      {
        HOME: home,
        CRM_REPL_FORCE: '1',
        CRM_CONFIG: '/dev/null',
        CRM_SERVER: `127.0.0.1:${server.port}`,
        CRM_INSECURE: '1',
      },
      8,
      // `--insecure` at the door: the login command connects through the
      // live gInsecure flag, which the CRM_INSECURE env does not set.
      ['--insecure'],
    )
    const { outcome, stdout } = await settle(p, 15_000)
    expect(stdout).toContain(`Logged in as ${created.user.username}`)
    // The owner's write passed (an id was printed); the reader's write
    // must be refused by role — proof it ran on the fresh connection,
    // not the stale owner socket.
    expect(stdout).toContain('ct_')
    expect(stdout).toContain('role "reader" cannot call contact.add')
    expect(outcome).toBe(0)
  } finally {
    await server.close()
    cleanup()
    rmSync(home, { recursive: true, force: true })
  }
})
