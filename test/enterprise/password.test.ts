import { expect, test } from 'bun:test'

import { createClient } from '@libsql/client'

import { RpcError } from '../../src/lib/rpc'
import {
  bootstrapOwner,
  connect,
  freshDb,
  startServer,
  type TestServer,
} from './helpers'

function usersRow(
  dbPath: string,
  username: string,
): Promise<{
  must_change_password: number
  password_changed_at: string | null
  failed_attempts: number
  locked_until: string | null
} | null> {
  const client = createClient({ url: `file:${dbPath}` })
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
  const client = createClient({ url: `file:${dbPath}` })
  return client
    .execute({
      sql: 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ?',
      args: [action],
    })
    .then((r) => Number(r.rows[0].n))
    .finally(() => client.close())
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
