import { describe, expect, test } from 'bun:test'

import { bootstrapOwner, connect, freshDb, startServer } from './helpers'

/**
 * Login rate limiting. Directory-backed logins never touch the CRM
 * lockout counters (the directory owns that policy), so without a
 * request-level limit a server in front of LDAP would forward every
 * brute-force attempt to the corporate directory.
 */

interface LoginResult {
  code?: string
  message: string
  token?: string
}

async function login(
  port: number,
  username: string,
  password: string,
): Promise<LoginResult> {
  const c = await connect(port)
  try {
    const res = await c.call<{ token: string }>('auth.login', {
      username,
      password,
    })
    return { message: 'ok', token: res.token }
  } catch (e) {
    return {
      code: (e as { code?: string }).code,
      message: (e as Error).message,
    }
  } finally {
    c.close()
  }
}

function serverConfig(dbPath: string, authLines: string): string {
  return `[database]
path = "${dbPath}"

[auth]
${authLines}
`
}

describe('login rate limiting', () => {
  test('per-username attempts are capped', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const server = await startServer(dbPath, {
        configBody: serverConfig(
          dbPath,
          `login_rate_per_minute = 100
login_user_rate_per_minute = 3`,
        ),
      })
      try {
        await bootstrapOwner(server)
        const results: LoginResult[] = []
        for (let i = 0; i < 4; i++) {
          results.push(await login(server.port, 'root', 'wrong-password-1'))
        }
        expect(results.slice(0, 3).map((r) => r.message)).toEqual([
          'invalid credentials',
          'invalid credentials',
          'invalid credentials',
        ])
        expect(results[3].message).toMatch(/too many login attempts/)
        expect(results[3].code).toBe('AUTH')
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 30_000)

  test('one client IP is capped across usernames', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const server = await startServer(dbPath, {
        configBody: serverConfig(
          dbPath,
          `login_rate_per_minute = 4
login_user_rate_per_minute = 100`,
        ),
      })
      try {
        await bootstrapOwner(server)
        const names = ['a-one', 'b-two', 'c-three', 'd-four', 'e-five']
        const messages: string[] = []
        for (const name of names) {
          messages.push(
            (await login(server.port, name, 'whatever-12345')).message,
          )
        }
        expect(messages.slice(0, 4)).toEqual([
          'invalid credentials',
          'invalid credentials',
          'invalid credentials',
          'invalid credentials',
        ])
        expect(messages[4]).toMatch(/too many login attempts/)
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 30_000)

  test('rate limiting can be switched off with 0', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const server = await startServer(dbPath, {
        configBody: serverConfig(
          dbPath,
          `login_rate_per_minute = 0
login_user_rate_per_minute = 0
lockout_threshold = 99`,
        ),
      })
      try {
        await bootstrapOwner(server)
        for (let i = 0; i < 12; i++) {
          const r = await login(server.port, 'root', 'wrong-password-1')
          expect(r.message).toBe('invalid credentials')
        }
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 30_000)

  test('throttling one username neither locks it nor blocks issued tokens', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const server = await startServer(dbPath, {
        configBody: serverConfig(
          dbPath,
          `login_rate_per_minute = 100
login_user_rate_per_minute = 2`,
        ),
      })
      try {
        const owner = await bootstrapOwner(server, 'root')
        // A window admits login_user_rate_per_minute attempts; the next
        // one inside that window is the one refused.
        await login(server.port, 'root', 'nope-nope-nope')
        await login(server.port, 'root', 'nope-nope-nope')
        expect(
          (await login(server.port, 'root', 'nope-nope-nope')).message,
        ).toMatch(/too many login attempts/)
        // the two mechanisms are independent: rate limiting must not touch
        // lockout state or invalidate an already-issued token
        const other = await login(server.port, 'root', 'Owner-pass-123')
        expect(other.message).toMatch(/too many login attempts/)
        const good = await connect(server.port)
        await good.call('auth.token', { token: owner.token })
        const list = await good.call<{ users: { username: string }[] }>(
          'admin.user.list',
          {},
        )
        good.close()
        expect(list.users.map((u) => u.username)).toContain('root')
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 30_000)
})
