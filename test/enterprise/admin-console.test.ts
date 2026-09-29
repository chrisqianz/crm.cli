/**
 * Web admin console (P8): the HTTP surface on a separate port. Every
 * /api/call reuses the RPC handler's RBAC + audit, so the browser is
 * "just another client". Covered: console serving, login, bearer
 * identity, admin calls over HTTP, the RBAC wall, the secret-free
 * config view, and the client download endpoints.
 */
import { describe, expect, test } from 'bun:test'

import {
  bootstrapOwner,
  freshDb,
  startServer,
  type TestServer,
} from './helpers'

const CONFIG_BODY = `[mail]
host = "127.0.0.1"
port = 2525
user = "relay@corp"
from = "crm@corp.example"
`

const SERVER_ENV = {
  CRM_SMTP_PASSWORD: 'smtp-secret-pw',
}

async function withConsole<T>(
  fn: (base: string, server: TestServer) => Promise<T>,
): Promise<T> {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath, {
    configBody: CONFIG_BODY,
    env: SERVER_ENV,
    args: ['--admin-port', '0'],
  })
  try {
    await bootstrapOwner(server)
    if (server.adminPort === null) {
      throw new Error(`server did not open an admin port:\n${server.log()}`)
    }
    return await fn(`http://127.0.0.1:${server.adminPort}`, server)
  } finally {
    await server.close()
    cleanup()
  }
}

describe('web admin console', () => {
  test('serves healthz and the console page with the RPC address', async () => {
    await withConsole(async (base, server) => {
      const hz = await fetch(`${base}/healthz`)
      expect(hz.status).toBe(200)
      expect(await hz.json()).toEqual({ ok: true, admin: true })

      const page = await fetch(`${base}/`)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      const html = await page.text()
      expect(html).toContain('crm.cli')
      expect(html).toContain(String(server.port))
      expect(html).toContain('/api/call')
    })
  }, 30_000)

  test('login: wrong password 401, owner gets a working bearer token', async () => {
    await withConsole(async (base) => {
      const bad = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'nope' }),
      })
      expect(bad.status).toBe(401)

      const good = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Owner-pass-123' }),
      })
      expect(good.status).toBe(200)
      const body = (await good.json()) as {
        role?: string
        token: string
        user?: { role?: string; username?: string }
      }
      expect(typeof body.token).toBe('string')
      expect(body.token.length).toBeGreaterThan(20)
      expect(body.user?.username).toBe('admin')
      expect(body.user?.role).toBe('owner')

      const me = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${body.token}` },
      })
      expect(me.status).toBe(200)
      const meBody = (await me.json()) as {
        id?: string
        role?: string
        username?: string
      }
      expect(meBody.username).toBe('admin')
      expect(meBody.role).toBe('owner')
      expect(typeof meBody.id).toBe('string')

      const noTok = await fetch(`${base}/api/me`)
      expect(noTok.status).toBe(401)
    })
  }, 30_000)

  test('admin calls over HTTP: create user + token, list users', async () => {
    await withConsole(async (base) => {
      const login = (await (
        await fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: 'Owner-pass-123',
          }),
        })
      ).json()) as { token: string }
      const auth = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.token}`,
      }
      const call = (method: string, params?: Record<string, unknown>) =>
        fetch(`${base}/api/call`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ method, params: params ?? {} }),
        }).then(async (r) => ({ status: r.status, body: await r.json() }))

      const created = await call('admin.user.create', {
        username: 'console.jane',
        role: 'writer',
      })
      expect(created.status).toBe(200)
      const user = (
        created.body as {
          result: {
            initial_password: string
            user: { username: string; role: string }
          }
        }
      ).result
      expect(user.user.username).toBe('console.jane')
      expect(user.user.role).toBe('writer')
      expect(typeof user.initial_password).toBe('string')

      const tokens = await call('admin.token.create', {
        name: 'console-token',
        username: 'console.jane',
      })
      expect(tokens.status).toBe(200)
      expect(
        ((tokens.body as { result: { token: string } }).result.token ?? '')
          .length,
      ).toBeGreaterThan(20)

      const list = await call('admin.user.list')
      expect(list.status).toBe(200)
      const users = (
        list.body as { result: { users: Array<{ username: string }> } }
      ).result.users
      expect(users.some((u) => u.username === 'console.jane')).toBe(true)
    })
  }, 30_000)

  test('RBAC over HTTP: reader reads audit but is refused admin + config', async () => {
    await withConsole(async (base) => {
      // owner provisions a reader with a known password
      const owner = (await (
        await fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: 'Owner-pass-123',
          }),
        })
      ).json()) as { token: string }
      const created = await fetch(`${base}/api/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({
          method: 'admin.user.create',
          params: { username: 'console.readonly', role: 'reader' },
        }),
      })
      const pw = (
        (await created.json()) as { result: { initial_password: string } }
      ).result.initial_password

      const readerLogin = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'console.readonly',
          password: pw,
        }),
      })
      expect(readerLogin.status).toBe(200)
      const readerToken = ((await readerLogin.json()) as { token: string })
        .token

      const call = (method: string) =>
        fetch(`${base}/api/call`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${readerToken}`,
          },
          body: JSON.stringify({ method, params: {} }),
        }).then(async (r) => ({ status: r.status, body: await r.json() }))

      const audit = await call('audit.list')
      expect(audit.status).toBe(200)

      const admin = await call('admin.user.list')
      expect(admin.status).toBe(403)
      expect((admin.body as { error: { code: string } }).error.code).toBe(
        'FORBIDDEN',
      )

      const cfg = await fetch(`${base}/api/config`, {
        headers: { Authorization: `Bearer ${readerToken}` },
      })
      expect(cfg.status).toBe(403)
    })
  }, 30_000)

  test('config view: secrets flagged, never returned', async () => {
    await withConsole(async (base) => {
      const login = (await (
        await fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: 'Owner-pass-123',
          }),
        })
      ).json()) as { token: string }
      const cfg = await fetch(`${base}/api/config`, {
        headers: { Authorization: `Bearer ${login.token}` },
      })
      expect(cfg.status).toBe(200)
      const body = (await cfg.json()) as Record<string, any>
      expect(body.ldap.enabled).toBe(false)
      expect(body.mail.configured).toBe(true)
      expect(body.mail.password_set).toBe(true)
      const raw = JSON.stringify(body)
      expect(raw).not.toContain('smtp-secret-pw')
    })
  }, 30_000)

  test('client downloads embed the RPC address, not the admin port', async () => {
    await withConsole(async (base, server) => {
      const toml = await (await fetch(`${base}/download/crm.toml`)).text()
      expect(toml).toContain('[remote]')
      expect(toml).toContain(`server = "127.0.0.1:${server.port}"`)
      expect(toml).toContain('insecure = true')

      const script = await (await fetch(`${base}/download/install.sh`)).text()
      expect(script).toContain(`127.0.0.1:${server.port}`)
      expect(script).toContain('#!/usr/bin/env bash')
    })
  }, 30_000)
})
