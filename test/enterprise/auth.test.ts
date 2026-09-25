import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { createClient } from '@libsql/client'

import {
  bootstrapOwner,
  connect,
  freshDb,
  type Owner,
  startServer,
  type TestServer,
} from './helpers.ts'

/**
 * P1 authentication contract:
 * - bootstrap (one-time, empty users table only)
 * - local-account login (argon2id at rest, lockout, audit rows)
 * - token auth (hash at rest, revocation, expiry, FORBIDDEN for non-admins)
 */
let server: TestServer | null = null
let owner: Owner | null = null
let dbPath = ''

function auditRows(
  action?: string,
): Promise<Array<{ action: string; actor_name: string; source: string }>> {
  const client = createClient({ url: `file:${dbPath}` })
  const rows = action
    ? `SELECT action, actor_name, source FROM audit_log WHERE action = '${action}'`
    : 'SELECT action, actor_name, source FROM audit_log'
  return client
    .execute(rows)
    .then((r) =>
      r.rows.map((x) => ({
        action: String(x.action),
        actor_name: String(x.actor_name),
        source: String(x.source),
      })),
    )
    .finally(() => client.close())
}

function userRow(username: string): Promise<{
  failed_attempts: number
  locked_until: string | null
  disabled_at: string | null
} | null> {
  const client = createClient({ url: `file:${dbPath}` })
  return client
    .execute(
      `SELECT failed_attempts, locked_until, disabled_at FROM users WHERE username = '${username}'`,
    )
    .then((r) => {
      if (r.rows.length === 0) {
        return null
      }
      const x = r.rows[0]
      return {
        failed_attempts: Number(x.failed_attempts),
        locked_until: x.locked_until ? String(x.locked_until) : null,
        disabled_at: x.disabled_at ? String(x.disabled_at) : null,
      }
    })
    .finally(() => client.close())
}

/** login and expect an AUTH-class failure; returns the error */
async function expectLoginFail(
  port: number,
  username: string,
  password: string,
): Promise<Error & { code?: string }> {
  const client = await connect(port)
  try {
    await client.call('auth.login', { username, password })
    throw new Error(`expected login failure for ${username}, but it succeeded`)
  } catch (e) {
    const err = e as Error & { code?: string }
    if (err.message.includes('expected login failure')) {
      throw err
    }
    return err
  } finally {
    client.close()
  }
}

/** Await a call expected to fail; returns the thrown error, or null if it succeeded. */
async function errorOf<T>(
  p: Promise<T>,
): Promise<(Error & { code?: string }) | null> {
  try {
    await p
    return null
  } catch (e) {
    return e as Error & { code?: string }
  }
}

describe('crm auth (P1)', () => {
  let port: number

  async function setUp() {
    if (server) {
      return
    }
    const fresh = freshDb()
    dbPath = fresh.dbPath
    server = await startServer(dbPath)
    port = server.port
    owner = await bootstrapOwner(server)
  }

  test('bootstrap creates owner; second bootstrap is rejected', async () => {
    await setUp()
    const s = server!
    // second bootstrap attempt with a fresh connection
    const client = await connect(port)
    const code = s.log().match(/BOOTSTRAP-CODE=(\S+)/)![1]
    await expect(
      client.call('auth.bootstrap', {
        code,
        username: 'intruder',
        password: 'whatever-123',
      }),
    ).rejects.toThrow()
    client.close()
  })

  test('auth.login with wrong password fails with AUTH error and records lockout counter + audit row', async () => {
    await setUp()
    const err = await expectLoginFail(port, 'admin', 'wrong-password-1')
    expect(err.code === 'AUTH' || /auth/i.test(err.message)).toBe(true)

    const row = await userRow('admin')
    expect(row!.failed_attempts).toBe(1)

    const audits = await auditRows('auth.login-failed')
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits[0].actor_name).toBe('admin')
    expect(audits[0].source).toBe('rpc')
  })

  test('lockout engages after threshold failures and blocks the correct password', async () => {
    await setUp()
    // use a fresh disposable user so the owner's lockout state never leaks
    const admin = await connect(port, owner!.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      {
        username: 'locky',
        role: 'reader',
      },
    )
    admin.close()

    // 5 failures (threshold default)
    for (let i = 0; i < 5; i++) {
      await expectLoginFail(port, 'locky', `bad-${i}`)
    }
    const locked = await userRow('locky')
    expect(locked!.locked_until).not.toBeNull()

    // now even the CORRECT password is refused (locked)
    const err = await expectLoginFail(port, 'locky', created.initial_password)
    expect(err.code).toBe('AUTH')
    expect(/locked/i.test(err.message)).toBe(true)
  })

  test('bad token is rejected with AUTH', async () => {
    await setUp()
    const client = await connect(port)
    await expect(
      client.call('auth.token', { token: 'crm_deadbeef0000' }),
    ).rejects.toThrow(/AUTH|invalid/i)
    client.close()
  })

  test('raw token is never stored in the database file', async () => {
    await setUp()
    const admin = await connect(port, owner!.token)
    const { token } = await admin.call<{ token: string }>(
      'admin.token.create',
      {
        name: 'bot-audit',
      },
    )
    admin.close()
    expect(token.startsWith('crm_')).toBe(true)

    const bytes = readFileSync(dbPath, 'utf-8')
    expect(bytes.includes(token)).toBe(false)
  })

  test('non-admin cannot call admin methods (FORBIDDEN)', async () => {
    await setUp()
    const admin = await connect(port, owner!.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      {
        username: 'writer-only',
        role: 'writer',
      },
    )
    admin.close()

    const writer = await connect(port)
    await writer.call('auth.login', {
      username: 'writer-only',
      password: created.initial_password,
    })
    const forbiddenErr = await errorOf(writer.call('admin.user.list', {}))
    expect(forbiddenErr?.code).toBe('FORBIDDEN')
    const forbiddenErr2 = await errorOf(
      writer.call('admin.token.create', { name: 'nope' }),
    )
    expect(forbiddenErr2?.code).toBe('FORBIDDEN')
    writer.close()
  })

  test('service tokens: create, authenticate, revoke', async () => {
    await setUp()
    const admin = await connect(port, owner!.token)
    const { token } = await admin.call<{ token: string }>(
      'admin.token.create',
      {
        name: 'bot-prod',
      },
    )
    const listed = await admin.call<{ tokens: Array<{ name: string }> }>(
      'admin.token.list',
      {},
    )
    expect(listed.tokens.some((t) => t.name === 'bot-prod')).toBe(true)

    // the service token authenticates
    const bot = await connect(port, token)
    bot.close()

    // revoke it
    const tokens = await admin.call<{
      tokens: Array<{ id: string; name: string }>
    }>('admin.token.list', {})
    const botRow = tokens.tokens.find((t) => t.name === 'bot-prod')!
    await admin.call('admin.token.revoke', { id: botRow.id })
    admin.close()

    const bot2 = await connect(port)
    const revokedErr = await errorOf(bot2.call('auth.token', { token }))
    expect(revokedErr?.code).toBe('AUTH')
    bot2.close()
  })

  test('expired token is rejected', async () => {
    await setUp()
    const admin = await connect(port, owner!.token)
    const { token } = await admin.call<{ token: string }>(
      'admin.token.create',
      {
        name: 'short-lived',
        expires_in_seconds: 1,
      },
    )
    admin.close()

    // works immediately
    const ok = await connect(port, token)
    ok.close()

    await new Promise((r) => setTimeout(r, 1500))
    const late = await connect(port)
    await expect(late.call('auth.token', { token })).rejects.toThrow(
      /AUTH|expir/i,
    )
    late.close()
  })

  test('disabled user cannot login even with correct password', async () => {
    await setUp()
    const admin = await connect(port, owner!.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      {
        username: 'doe',
        role: 'reader',
      },
    )
    await admin.call('admin.user.disable', { username: 'doe' })
    admin.close()

    await expectLoginFail(port, 'doe', created.initial_password)

    const row = await userRow('doe')
    expect(row!.disabled_at).not.toBeNull()

    // re-enable restores login
    const admin2 = await connect(port, owner!.token)
    await admin2.call('admin.user.enable', { username: 'doe' })
    const reenabled = await connect(port)
    await reenabled.call('auth.login', {
      username: 'doe',
      password: created.initial_password,
    })
    reenabled.close()
    admin2.close()
  })

  test('admin actions are audited', async () => {
    await setUp()
    const admin = await connect(port, owner!.token)
    await admin.call('admin.user.create', {
      username: 'audited',
      role: 'reader',
    })
    admin.close()

    const audits = await auditRows('admin.user.create')
    expect(audits.length).toBeGreaterThanOrEqual(1)
  })

  afterAll(async () => {
    if (server) {
      await server.close()
      server = null
      owner = null
    }
  })
})
