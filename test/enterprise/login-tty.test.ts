/**
 * The interactive path is the human path, and nothing covered it: every other
 * test passes --password, so the prompt never ran. Under a real terminal it
 * hung — `prompt()` resumes stdin and never stops reading it, so the event
 * loop outlives the command: the CLI prints everything, saves the session,
 * and the shell never comes back.
 *
 * A pty is the only way to reach this code, since the CLI refuses to prompt
 * without one.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bootstrapOwner,
  CRM,
  freshDb,
  startServer,
  type TestServer,
} from './helpers'

/** Long enough to be a real patience test, short enough to fail the suite. */
const EXIT_GRACE_MS = 10_000

interface Pty {
  home: string
  proc: ReturnType<typeof Bun.spawn>
  screen: () => string
  send: (text: string) => void
}

function ptyLogin(
  args: string[],
  opts: { seed?: (home: string) => void; env?: Record<string, string> } = {},
): Pty {
  let screen = ''
  const decode = new TextDecoder()
  const term = new Bun.Terminal({
    cols: 80,
    rows: 24,
    data: (_t: Bun.Terminal, chunk: Uint8Array) => {
      screen += decode.decode(chunk, { stream: true })
    },
  })
  const home = mkdtempSync(join(tmpdir(), 'crm-tty-home-'))
  opts.seed?.(home)
  const proc = Bun.spawn(['bun', 'run', CRM, 'login', ...args], {
    terminal: term,
    env: {
      ...process.env,
      CRM_CONFIG: '',
      // Trust the dev cert the server minted rather than turning verification
      // off — the flag that would turn it off is a separate bug.
      NODE_EXTRA_CA_CERTS: join(homedir(), '.crm', 'certs', 'server.crt'),
      HOME: home,
      ...opts.env,
    },
  })
  return {
    home,
    proc,
    screen: () => screen,
    send: (text: string) => term.write(text),
  }
}

async function settled(what: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) {
      return true
    }
    await Bun.sleep(100)
  }
  return what()
}

/** The shell comes back, and the session landed in the pty login's HOME. */
async function expectFinished(session: Pty, username: string) {
  const cameBack = await Promise.race([
    session.proc.exited.then(() => true),
    Bun.sleep(EXIT_GRACE_MS).then(() => false),
  ])
  expect(cameBack).toBe(true)
  const saved = JSON.parse(
    readFileSync(join(session.home, '.crm', 'credentials'), 'utf-8'),
  ) as { server: string; username: string }
  expect(saved.username).toBe(username)
}

describe('crm login at a real terminal', () => {
  const db = freshDb()
  let server: TestServer | null = null

  afterAll(async () => {
    await server?.close()
    db.cleanup()
  })

  test('hands the terminal back once the password is in', async () => {
    server = await startServer(db.dbPath)
    const owner = await bootstrapOwner(server)
    const session = ptyLogin([
      '--server',
      `127.0.0.1:${server.port}`,
      '--username',
      owner.username,
    ])
    try {
      expect(
        await settled(() => /password/i.test(session.screen()), 10_000),
      ).toBe(true)
      session.send(`${owner.password}\n`)
      await expectFinished(session, owner.username)
    } finally {
      try {
        session.proc.kill(9)
      } catch {
        // already gone
      }
    }
  }, 90_000)

  test('a second prompt still reads, and still returns', async () => {
    if (!server) {
      server = await startServer(db.dbPath)
      await bootstrapOwner(server)
    }
    const owner = { password: 'Owner-pass-123', username: 'admin' }
    const session = ptyLogin(['--server', `127.0.0.1:${server.port}`])
    try {
      expect(
        await settled(() => /username/i.test(session.screen()), 10_000),
      ).toBe(true)
      session.send(`${owner.username}\n`)
      // Line mode has to echo what arrives (raw mode switched terminal echo
      // off) and must not repeat the chunk once per byte.
      expect(
        await settled(
          () => session.screen().includes(`Username: ${owner.username}`),
          5000,
        ),
      ).toBe(true)
      // The password prompt only appears if stdin was re-armed after the
      // first prompt paused it — which is what the fix changed.
      expect(
        await settled(() => /password/i.test(session.screen()), 10_000),
      ).toBe(true)
      session.send(`${owner.password}\n`)
      await expectFinished(session, owner.username)
    } finally {
      try {
        session.proc.kill(9)
      } catch {
        // already gone
      }
    }
  }, 90_000)

  test('a saved session names its user before the password prompt', async () => {
    // Live-testing regression: with a saved session, login silently reused
    // its username and jumped straight to the password prompt — the human
    // had no idea which account they were about to authenticate, and no
    // way to log in as someone else without --username.
    if (!server) {
      server = await startServer(db.dbPath)
      await bootstrapOwner(server)
    }
    const srv = server
    const session = ptyLogin(['--server', `127.0.0.1:${srv.port}`], {
      seed: (home) => {
        mkdirSync(join(home, '.crm'))
        writeFileSync(
          join(home, '.crm', 'credentials'),
          JSON.stringify({
            server: `127.0.0.1:${srv.port}`,
            username: 'admin',
            token: 'stale-token',
          }),
        )
      },
    })
    try {
      // the saved username must be VISIBLE as the default, not invisible
      expect(
        await settled(
          () => session.screen().includes('Username (admin)'),
          10_000,
        ),
      ).toBe(true)
      // bare Enter keeps the saved user and proceeds to the password
      session.send('\n')
      expect(
        await settled(() => /password/i.test(session.screen()), 10_000),
      ).toBe(true)
      session.send('Owner-pass-123\n')
      await expectFinished(session, 'admin')
      // the saved session must be a FRESH one: a new token (not the
      // seeded stale one) and no connection failure on the screen
      const saved = JSON.parse(
        readFileSync(join(session.home, '.crm', 'credentials'), 'utf8'),
      ) as { token: string }
      expect(saved.token).not.toBe('stale-token')
      expect(session.screen()).not.toMatch(/cannot connect|self.?signed/i)
    } finally {
      try {
        session.proc.kill(9)
      } catch {
        // already gone
      }
    }
  }, 90_000)

  test('login inherits insecure from the saved session', async () => {
    // Live-testing regression: the saved session carries insecure=true
    // (self-signed server), but login did not read it — a plain
    // 'crm login' died with 'self signed certificate' even though the
    // previous login (and whoami) had established the trust context.
    // No --insecure flag and no trusted CA env: the saved session must
    // carry the trust, exactly like a real user shell.
    if (!server) {
      server = await startServer(db.dbPath)
      await bootstrapOwner(server)
    }
    const srv = server
    const session = ptyLogin(['--server', `127.0.0.1:${srv.port}`], {
      env: { NODE_EXTRA_CA_CERTS: '' },
      seed: (home) => {
        mkdirSync(join(home, '.crm'))
        writeFileSync(
          join(home, '.crm', 'credentials'),
          JSON.stringify({
            server: `127.0.0.1:${srv.port}`,
            username: 'admin',
            token: 'stale-token',
            insecure: true,
          }),
        )
      },
    })
    try {
      // no --insecure flag: the saved session must carry the trust
      expect(
        await settled(
          () => session.screen().includes('Username (admin)'),
          10_000,
        ),
      ).toBe(true)
      session.send('\n')
      expect(
        await settled(() => /password/i.test(session.screen()), 10_000),
      ).toBe(true)
      session.send('Owner-pass-123\n')
      await expectFinished(session, 'admin')
      // proof of a real round-trip against an UNTRUSTED self-signed cert:
      // the token was replaced, and no trust failure was printed
      const saved = JSON.parse(
        readFileSync(join(session.home, '.crm', 'credentials'), 'utf8'),
      ) as { token: string }
      expect(saved.token).not.toBe('stale-token')
      expect(session.screen()).not.toMatch(/cannot connect|self.?signed/i)
    } finally {
      try {
        session.proc.kill(9)
      } catch {
        // already gone
      }
    }
  }, 90_000)

  test('a first-time trust failure tells the user how to proceed', async () => {
    // Live-testing regression: 'crm login' died on a self-signed server
    // with a bare 'self signed certificate' — no hint that --insecure or
    // trusting the CA cert is the way forward.
    if (!server) {
      server = await startServer(db.dbPath)
      await bootstrapOwner(server)
    }
    const srv = server
    const home = mkdtempSync(join(tmpdir(), 'crm-tty-home-'))
    const proc = Bun.spawn(
      [
        'bun',
        'run',
        CRM,
        'login',
        '--server',
        `127.0.0.1:${srv.port}`,
        '--username',
        'admin',
        '--password',
        'Owner-pass-123',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          CRM_CONFIG: '',
          NODE_EXTRA_CA_CERTS: '',
          HOME: home,
        },
      },
    )
    const code = await proc.exited
    const out = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(out).toMatch(/self.?signed|certificate/i)
    expect(out).toMatch(/--insecure/i)
  }, 90_000)
})
