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
import { mkdtempSync, readFileSync } from 'node:fs'
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

function ptyLogin(args: string[]): Pty {
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
  const proc = Bun.spawn(['bun', 'run', CRM, 'login', ...args], {
    terminal: term,
    env: {
      ...process.env,
      CRM_CONFIG: '',
      // Trust the dev cert the server minted rather than turning verification
      // off — the flag that would turn it off is a separate bug.
      NODE_EXTRA_CA_CERTS: join(homedir(), '.crm', 'certs', 'server.crt'),
      HOME: home,
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
})
