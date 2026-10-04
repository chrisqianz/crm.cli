/**
 * B1c — must-change login flow + password_max_age_days.
 *
 * The flag rides the auth.login result; every surface (CLI, REPL, console)
 * reacts to it. Expiry is a server config knob that only bites when
 * enabled (max_age_days > 0); a legacy NULL password_changed_at counts as
 * expired only in that case.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@libsql/client'

import {
  bootstrapOwner,
  connect,
  freshDb,
  startServer,
  type TestServer,
} from './helpers'

const EXPIRY_CONFIG = '[auth]\npassword_max_age_days = 30\n'

async function loginMustChange(
  port: number,
  username: string,
  password: string,
): Promise<boolean> {
  const c = await connect(port)
  try {
    const r = await c.call<{ must_change?: boolean }>('auth.login', {
      username,
      password,
    })
    return r.must_change === true
  } finally {
    c.close()
  }
}

async function issueToken(
  port: number,
  username: string,
  password: string,
): Promise<string> {
  const c = await connect(port)
  try {
    const r = await c.call<{ token: string }>('auth.login', {
      username,
      password,
    })
    return r.token
  } finally {
    c.close()
  }
}

function setChangedAt(dbPath: string, username: string, iso: string | null) {
  const client = createClient({ url: `file:${dbPath}` })
  return client
    .execute({
      sql: 'UPDATE users SET password_changed_at = ? WHERE username = ?',
      args: [iso, username],
    })
    .finally(() => client.close())
}

test('login carries must_change: true after reset, false after change', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'sam', role: 'writer' },
    )
    expect(
      await loginMustChange(server.port, 'sam', created.initial_password),
    ).toBe(false)
    const r = await admin.call<{ temporary_password: string }>(
      'admin.user.reset-password',
      { username: 'sam' },
    )
    expect(
      await loginMustChange(server.port, 'sam', r.temporary_password),
    ).toBe(true)
    const c = await connect(
      server.port,
      await issueToken(server.port, 'sam', r.temporary_password),
    )
    await c.call('auth.change-password', {
      current: r.temporary_password,
      new: 'New-pass-1234!',
    })
    c.close()
    expect(await loginMustChange(server.port, 'sam', 'New-pass-1234!')).toBe(
      false,
    )
  } finally {
    await server.close()
    cleanup()
  }
})

test('password_max_age_days: expiry, legacy NULL, and 0 disables', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath, {
    configBody: EXPIRY_CONFIG,
  })
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'aged', role: 'writer' },
    )
    // fresh password: not expired
    expect(
      await loginMustChange(server.port, 'aged', created.initial_password),
    ).toBe(false)
    // an old password is expired
    await setChangedAt(
      dbPath,
      'aged',
      new Date(Date.now() - 31 * 86_400_000).toISOString(),
    )
    expect(
      await loginMustChange(server.port, 'aged', created.initial_password),
    ).toBe(true)
    // a recent password is not
    await setChangedAt(dbPath, 'aged', new Date().toISOString())
    expect(
      await loginMustChange(server.port, 'aged', created.initial_password),
    ).toBe(false)
  } finally {
    await server.close()
    cleanup()
  }

  // legacy NULL password_changed_at: expired once the knob is on
  const { dbPath: db2, cleanup: cleanup2 } = freshDb()
  const server2: TestServer = await startServer(db2, {
    configBody: EXPIRY_CONFIG,
  })
  try {
    const owner = await bootstrapOwner(server2)
    const admin = await connect(server2.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'legacy', role: 'writer' },
    )
    await setChangedAt(db2, 'legacy', null)
    expect(
      await loginMustChange(server2.port, 'legacy', created.initial_password),
    ).toBe(true)
  } finally {
    await server2.close()
    cleanup2()
  }

  // knob off (default 0): a NULL changed-at must NOT force a change
  const { dbPath: db3, cleanup: cleanup3 } = freshDb()
  const server3: TestServer = await startServer(db3)
  try {
    const owner = await bootstrapOwner(server3)
    const admin = await connect(server3.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'off', role: 'writer' },
    )
    await setChangedAt(db3, 'off', null)
    expect(
      await loginMustChange(server3.port, 'off', created.initial_password),
    ).toBe(false)
  } finally {
    await server3.close()
    cleanup3()
  }
}, 30_000)

test('crm login: must-change defers with guidance, session still saved', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  const home = mkdtempSync(join(tmpdir(), 'crm-b1c-home-'))
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    await admin.call('admin.user.create', {
      username: 'forced',
      role: 'writer',
    })
    const reset = await admin.call<{ temporary_password: string }>(
      'admin.user.reset-password',
      { username: 'forced' },
    )
    const p = Bun.spawn(
      [
        'bun',
        'src/cli.ts',
        'login',
        '--server',
        `127.0.0.1:${server.port}`,
        '--insecure',
        '--username',
        'forced',
        '--password',
        reset.temporary_password,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          CRM_CONFIG: '/dev/null',
          NO_COLOR: '1',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    p.stdin.end()
    const out = await new Response(p.stdout).text()
    const err = await new Response(p.stderr).text()
    const code = await p.exited
    // the login itself succeeded and the session was saved…
    expect(out).toContain('Logged in as forced')
    expect(out).toContain('Session saved')
    // …but non-TTY defers the forced change with guidance, exit 1
    expect(code).toBe(1)
    expect(err).toContain('password must be changed — run crm password change')
  } finally {
    await server.close()
    cleanup()
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

test('console /api/login carries must_change', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath, {
    args: ['--admin-port', '0'],
  })
  try {
    if (server.adminPort === null) {
      throw new Error(`server did not open an admin port:\n${server.log()}`)
    }
    const base = `http://127.0.0.1:${server.adminPort}`
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'web', role: 'reader' },
    )
    const login = (
      u: string,
      pw: string,
    ): Promise<{
      status: number
      body: { token?: string; must_change?: boolean }
    }> =>
      fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: pw }),
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as { token?: string; must_change?: boolean },
      }))
    const before = await login('web', created.initial_password)
    expect(before.status).toBe(200)
    expect(before.body.must_change).toBe(false)
    await admin.call('admin.user.reset-password', { username: 'web' })
    const reset = await admin.call<{ temporary_password: string }>(
      'admin.user.reset-password',
      { username: 'web' },
    )
    const after = await login('web', reset.temporary_password)
    expect(after.status).toBe(200)
    expect(after.body.must_change).toBe(true)
  } finally {
    await server.close()
    cleanup()
  }
})
