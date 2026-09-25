import { describe, expect, test } from 'bun:test'
import tls from 'node:tls'

import {
  bootstrapOwner,
  connect,
  freshDb,
  startServer,
  type TestServer,
} from './helpers.ts'

function healthz(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = tls.connect(
      {
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
        servername: 'localhost',
      },
      () => {
        req.write(
          'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
        )
      },
    )
    let data = ''
    req.on('data', (c: Buffer) => (data += c.toString()))
    req.on('end', () => {
      const body = data.slice(data.indexOf('\r\n\r\n') + 4)
      try {
        resolve(JSON.parse(body) as Record<string, unknown>)
      } catch {
        reject(new Error(`healthz body not JSON: ${body}\n(full: ${data})`))
      }
    })
    req.on('error', reject)
  })
}

describe('crm serve (P1)', () => {
  test('boots on --port 0, prints READY <port>, healthz answers ok', async () => {
    const { dbPath, cleanup } = freshDb()
    let server: TestServer | null = null
    try {
      server = await startServer(dbPath)
      expect(server.port).toBeGreaterThan(0)
      const health = await healthz(server.port)
      expect(health.ok).toBe(true)
    } finally {
      await server?.close()
      cleanup()
    }
  }, 30_000)

  test('survives restart with existing DB (users + passwords persist)', async () => {
    const { dbPath, cleanup } = freshDb()

    // First boot: bootstrap owner, provision a writer
    const s1 = await startServer(dbPath)
    const owner = await bootstrapOwner(s1)
    const admin = await connect(s1.port, owner.token)
    const created = await admin.call<{
      user: { username: string; role: string }
      initial_password: string
    }>('admin.user.create', {
      username: 'jane',
      display_name: 'Jane Doe',
      role: 'writer',
    })
    expect(created.user.username).toBe('jane')
    expect(created.user.role).toBe('writer')
    expect(created.initial_password.length).toBeGreaterThanOrEqual(12)
    // jane can log in before the restart
    const jane1 = await connect(s1.port)
    await jane1.call('auth.login', {
      username: 'jane',
      password: created.initial_password,
    })
    jane1.close()
    admin.close()
    await s1.close()

    // Second boot on the same DB: no bootstrap code, identities survive
    const s2 = await startServer(dbPath)
    try {
      expect(s2.log()).not.toContain('BOOTSTRAP-CODE=')

      const admin2 = await connect(s2.port)
      await admin2.call('auth.login', {
        username: 'admin',
        password: owner.password,
      })
      const list = await admin2.call<{ users: Array<{ username: string }> }>(
        'admin.user.list',
        {},
      )
      const usernames = list.users.map((u) => u.username).sort()
      expect(usernames).toEqual(['admin', 'jane'])
      admin2.close()

      // jane's one-time initial password still works after restart
      const jane2 = await connect(s2.port)
      await jane2.call('auth.login', {
        username: 'jane',
        password: created.initial_password,
      })
      jane2.close()
    } finally {
      await s2.close()
      cleanup()
    }
  }, 30_000)
})
