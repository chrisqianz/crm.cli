import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RpcError } from '../../src/lib/rpc'
import {
  bootstrapOwner,
  connect,
  externalClient,
  freshDb,
  startServer,
  type TestServer,
} from './helpers'

const NEW_PASS = 'New-pass-123!'

async function usersRow(
  dbPath: string,
  username: string,
): Promise<{
  must_change_password: number
  password_changed_at: string | null
  failed_attempts: number
  locked_until: string | null
} | null> {
  const client = await externalClient(dbPath)
  return client
    .execute({
      sql: 'SELECT must_change_password, password_changed_at, failed_attempts, locked_until FROM users WHERE username = ?',
      args: [username],
    })
    .then((r) => {
      if (r.rows.length === 0) {
        return null
      }
      const x = r.rows[0]
      return {
        must_change_password: Number(x.must_change_password),
        password_changed_at: x.password_changed_at
          ? String(x.password_changed_at)
          : null,
        failed_attempts: Number(x.failed_attempts),
        locked_until: x.locked_until ? String(x.locked_until) : null,
      }
    })
    .finally(() => client.close())
}

function auditCount(dbPath: string, action: string): Promise<number> {
  return externalClient(dbPath).then((client) =>
    client
      .execute({
        sql: 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ?',
        args: [action],
      })
      .then((r) => Number(r.rows[0].n))
      .finally(() => client.close()),
  )
}

async function login(
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

test('admin reset issues a one-time password that forces a change', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'sam', role: 'writer', display_name: 'Sam' },
    )

    // create already stamped the changed-at column
    const row0 = await usersRow(dbPath, 'sam')
    expect(row0).not.toBeNull()
    expect(row0?.password_changed_at).not.toBeNull()

    const r = await admin.call<{
      username: string
      temporary_password: string
    }>('admin.user.reset-password', { username: 'sam' })
    expect(r.username).toBe('sam')
    expect(typeof r.temporary_password).toBe('string')
    expect(r.temporary_password.length).toBeGreaterThanOrEqual(12)

    // the old initial password no longer works; the temp one does
    await expect(
      login(server.port, 'sam', created.initial_password),
    ).rejects.toThrow(RpcError)
    const token = await login(server.port, 'sam', r.temporary_password)
    expect(token).toContain('crm_')

    // must-change flag set, lockout counters at rest, audit row written
    const row = await usersRow(dbPath, 'sam')
    expect(row?.must_change_password).toBe(1)
    expect(row?.password_changed_at).not.toBeNull()
    expect(await auditCount(dbPath, 'admin.user.reset-password')).toBe(1)

    // unknown user → NOT_FOUND
    await expect(
      admin.call('admin.user.reset-password', { username: 'ghost' }),
    ).rejects.toThrow(/no such user/)
  } finally {
    await server.close()
    cleanup()
  }
})

test('admin reset clears a lockout (it is the unlock path)', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    await admin.call('admin.user.create', {
      username: 'locked',
      role: 'reader',
    })
    // burn the lockout threshold (default 5) with wrong passwords
    for (let i = 0; i < 5; i++) {
      await expect(
        login(server.port, 'locked', 'wrong-password'),
      ).rejects.toThrow(RpcError)
    }
    const locked = await usersRow(dbPath, 'locked')
    expect(locked?.locked_until).not.toBeNull()

    const r = await admin.call<{ temporary_password: string }>(
      'admin.user.reset-password',
      { username: 'locked' },
    )
    // the reset doubles as the unlock: the temp password logs in
    await expect(
      login(server.port, 'locked', r.temporary_password),
    ).resolves.toMatch(/^crm_/)
    const row = await usersRow(dbPath, 'locked')
    expect(row?.locked_until).toBeNull()
    expect(row?.failed_attempts).toBe(0)
  } finally {
    await server.close()
    cleanup()
  }
})

test('reader is refused admin.user.reset-password (RBAC)', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'eve', role: 'reader' },
    )
    const eve = await connect(server.port)
    await eve.call('auth.login', {
      username: 'eve',
      password: created.initial_password,
    })
    await expect(
      eve.call('admin.user.reset-password', { username: 'eve' }),
    ).rejects.toThrow(/cannot call admin\.user\.reset-password/)
    // and nothing was audited
    expect(await auditCount(dbPath, 'admin.user.reset-password')).toBe(0)
  } finally {
    await server.close()
    cleanup()
  }
})

async function changePassword(
  port: number,
  token: string,
  current: string,
  newPass: string,
): Promise<unknown> {
  const c = await connect(port, token)
  try {
    return await c.call('auth.change-password', {
      current,
      new: newPass,
    })
  } finally {
    c.close()
  }
}

test('change-password: self-service swaps the secret and clears must-change', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    await admin.call('admin.user.create', {
      username: 'sam',
      role: 'writer',
    })
    // put sam in the must-change state first, then let him out
    const r = await admin.call<{ temporary_password: string }>(
      'admin.user.reset-password',
      { username: 'sam' },
    )
    const token = await login(server.port, 'sam', r.temporary_password)
    expect((await usersRow(dbPath, 'sam'))?.must_change_password).toBe(1)

    await expect(
      changePassword(server.port, token, r.temporary_password, NEW_PASS),
    ).resolves.toBeTruthy()

    // old secret dead, new secret live, flag cleared, audit row written
    await expect(
      login(server.port, 'sam', r.temporary_password),
    ).rejects.toThrow(RpcError)
    await expect(login(server.port, 'sam', NEW_PASS)).resolves.toMatch(/^crm_/)
    const row = await usersRow(dbPath, 'sam')
    expect(row?.must_change_password).toBe(0)
    expect(await auditCount(dbPath, 'auth.change-password')).toBe(1)
  } finally {
    await server.close()
    cleanup()
  }
})

test('change-password: wrong current is audited, but is not a login attempt', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'sam', role: 'writer' },
    )
    const token = await login(server.port, 'sam', created.initial_password)
    await expect(
      changePassword(server.port, token, 'nope-nope', NEW_PASS),
    ).rejects.toThrow(/current password incorrect/)
    // a wrong CURRENT is not a login attempt: lockout counters untouched
    const row = await usersRow(dbPath, 'sam')
    expect(row?.failed_attempts).toBe(0)
    expect(row?.locked_until).toBeNull()
    // but it is remembered
    expect(await auditCount(dbPath, 'auth.change-password-failed')).toBe(1)
  } finally {
    await server.close()
    cleanup()
  }
})

test('change-password: policy rejections (too short, same as current)', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'sam', role: 'writer' },
    )
    const token = await login(server.port, 'sam', created.initial_password)
    await expect(
      changePassword(server.port, token, created.initial_password, 'short'),
    ).rejects.toThrow(/at least 12/)
    await expect(
      changePassword(
        server.port,
        token,
        created.initial_password,
        created.initial_password,
      ),
    ).rejects.toThrow(/differ/)
    // no successful change happened
    await expect(
      login(server.port, 'sam', created.initial_password),
    ).resolves.toMatch(/^crm_/)
    expect(await auditCount(dbPath, 'auth.change-password')).toBe(0)
  } finally {
    await server.close()
    cleanup()
  }
})

test('change-password: directory-managed users are refused', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'diruser', role: 'reader' },
    )
    // simulate an LDAP-provisioned row (no directory needed for the guard)
    const db = await externalClient(dbPath)
    await db.execute({
      sql: 'UPDATE users SET auth_source = ?, ldap_dn = ? WHERE username = ?',
      args: ['ldap', 'cn=diruser,ou=people', 'diruser'],
    })
    db.close()
    const token = await login(server.port, 'diruser', created.initial_password)
    await expect(
      changePassword(server.port, token, created.initial_password, NEW_PASS),
    ).rejects.toThrow(/directory is the password authority/)
    expect(await auditCount(dbPath, 'auth.change-password')).toBe(0)
  } finally {
    await server.close()
    cleanup()
  }
})

test('crm password change: remote via piped secrets; local mode fails clean', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  const home = mkdtempSync(join(tmpdir(), 'crm-pw-home-'))
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'pip', role: 'writer' },
    )
    const token = await login(server.port, 'pip', created.initial_password)
    const p = Bun.spawn(
      ['bun', 'src/cli.ts', 'password', 'change', '--insecure'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          CRM_SERVER: `127.0.0.1:${server.port}`,
          CRM_TOKEN: token,
          CRM_CONFIG: '/dev/null',
          NO_COLOR: '1',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    p.stdin.write(`${created.initial_password}\nNew-pass-1234!\n`)
    p.stdin.end()
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    expect(code).toBe(0)
    expect(out).toContain('Password changed for pip.')
    await expect(login(server.port, 'pip', 'New-pass-1234!')).resolves.toMatch(
      /^crm_/,
    )

    // a token but no server → clean refusal, exit 1
    const p2 = Bun.spawn(['bun', 'src/cli.ts', 'password', 'change'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        CRM_TOKEN: 'crm_fake-token',
        CRM_CONFIG: '/dev/null',
        NO_COLOR: '1',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    p2.stdin.end()
    const code2 = await p2.exited
    const err2 = await new Response(p2.stderr).text()
    expect(code2).toBe(1)
    expect(err2).toContain('Password management is a server feature')
  } finally {
    await server.close()
    cleanup()
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
