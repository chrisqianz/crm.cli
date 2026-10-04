/**
 * B5: server.status + `crm status` + console dashboard.
 *
 * server.status is reader-accessible liveness/overview; it must carry no
 * config, no secrets, no host paths. The connection counter is the live
 * socket count — opening and closing clients must move it.
 */

import { describe, expect, test } from 'bun:test'
import type { Writable } from 'node:stream'

import {
  bootstrapOwner,
  connect,
  freshDb,
  REPO,
  startServer,
  type TestServer,
} from './helpers'

const SMTP_SECRET = 'smtp-dash-secret'

const CONFIG_BODY = `[mail]
host = "127.0.0.1"
port = 2525
user = "relay@corp"
from = "crm@corp.example"
`

describe('B5: server.status', () => {
  test('reader gets the full status; no secrets, no paths, no config', async () => {
    const { dbPath, cleanup } = freshDb()
    const server: TestServer = await startServer(dbPath, {
      configBody: CONFIG_BODY,
      env: { CRM_SMTP_PASSWORD: SMTP_SECRET },
      args: ['--admin-port', '0'],
    })
    try {
      const owner = await bootstrapOwner(server)
      const admin = await connect(server.port, owner.token)
      const created = await admin.call<{ initial_password: string }>(
        'admin.user.create',
        { username: 'dash.reader', role: 'reader' },
      )
      const readerClient = await connect(server.port)
      await readerClient.call('auth.login', {
        username: 'dash.reader',
        password: created.initial_password,
      })
      const status = await readerClient.call<{
        server_version: string
        now: string
        uptime_ms: number
        connections: number
        users: number
        tokens: number
        db_bytes: number
        audit_seq: number
        backup: { last_sync_at: string | null; in_sync: boolean | null }
      }>('server.status', {})
      expect(status.server_version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(typeof status.now).toBe('string')
      expect(status.uptime_ms).toBeGreaterThanOrEqual(0)
      // this reader connection + the admin's + owner's are open
      expect(status.connections).toBeGreaterThanOrEqual(2)
      expect(status.users).toBeGreaterThanOrEqual(2)
      expect(status.db_bytes).toBeGreaterThan(0)
      expect(status.audit_seq).toBeGreaterThanOrEqual(1)
      // backup is not configured in this environment → clean nulls
      expect(status.backup.last_sync_at).toBeNull()
      expect(status.backup.in_sync).toBeNull()
      // no config values, no secrets, no host paths leak
      const raw = JSON.stringify(status)
      expect(raw).not.toContain(SMTP_SECRET)
      expect(raw).not.toContain('127.0.0.1:2525')
      expect(raw).not.toContain('relay@corp')
      expect(raw).not.toContain(dbPath)
    } finally {
      await server.close()
      cleanup()
    }
  }, 60_000)

  test('the connection counter moves when clients open and close', async () => {
    const { dbPath, cleanup } = freshDb()
    const server: TestServer = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const admin = await connect(server.port, owner.token)
      const before = await admin.call<{ connections: number }>(
        'server.status',
        {},
      )
      expect(before.connections).toBeGreaterThanOrEqual(1)
      const c1 = await connect(server.port, owner.token)
      const during = await admin.call<{ connections: number }>(
        'server.status',
        {},
      )
      expect(during.connections).toBe(before.connections + 1)
      c1.close()
      // the server decrements on socket close; allow one tick
      await new Promise((r) => setTimeout(r, 100))
      const after = await admin.call<{ connections: number }>(
        'server.status',
        {},
      )
      expect(after.connections).toBe(before.connections)
    } finally {
      await server.close()
      cleanup()
    }
  }, 60_000)
})

describe('B5: crm status CLI', () => {
  test('remote mode prints the status; no server fails with the contract copy', async () => {
    const { dbPath, cleanup } = freshDb()
    const server: TestServer = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const admin = await connect(server.port, owner.token)
      const created = (await admin.call<{
        initial_password: string
      }>('admin.user.create', {
        username: 'status.cli',
        role: 'reader',
      })) as { initial_password: string }

      // log in so a session exists, then `crm status` against it
      const home = freshHome()
      const login = Bun.spawn({
        cmd: [
          'bun',
          'src/cli.ts',
          'login',
          '--server',
          `127.0.0.1:${server.port}`,
          '--insecure',
          '--username',
          'status.cli',
          '--password',
          created.initial_password,
        ],
        env: {
          ...process.env,
          HOME: home,
          CRM_CONFIG: '/dev/null',
          NO_COLOR: '1',
        },
        cwd: REPO,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      ;(login.stdin as unknown as Writable).end()
      const loginErr = await new Response(login.stderr).text()
      expect(await login.exited, loginErr).toBe(0)

      const status = Bun.spawn({
        cmd: [
          'bun',
          'src/cli.ts',
          'status',
          '--server',
          `127.0.0.1:${server.port}`,
          '--insecure',
        ],
        env: {
          ...process.env,
          HOME: home,
          CRM_CONFIG: '/dev/null',
          NO_COLOR: '1',
        },
        cwd: REPO,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = await new Response(status.stdout).text()
      expect(await status.exited).toBe(0)
      expect(out).toContain('version')
      expect(out).toContain('users')
      expect(out).toContain('backup')

      // with no server and no session there is nothing to report
      const none = Bun.spawn({
        cmd: ['bun', 'src/cli.ts', 'status'],
        env: {
          ...process.env,
          HOME: freshHome(),
          CRM_SERVER: '',
          CRM_TOKEN: '',
        },
        cwd: REPO,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const noneErr = await new Response(none.stderr).text()
      expect(await none.exited).not.toBe(0)
      expect(noneErr).toContain('not connected')
      expect(noneErr).toContain('crm login')
    } finally {
      await server.close()
      cleanup()
    }
  }, 90_000)

  test('console HTML carries the dashboard wiring', async () => {
    const { dbPath, cleanup } = freshDb()
    const server: TestServer = await startServer(dbPath, {
      args: ['--admin-port', '0'],
    })
    try {
      await bootstrapOwner(server)
      if (server.adminPort === null) {
        throw new Error(`no admin port: ${server.log()}`)
      }
      const html = await (
        await fetch(`http://127.0.0.1:${server.adminPort}/`)
      ).text()
      expect(html).toContain('tab-dash')
      expect(html).toContain('dashCards')
      expect(html).toContain('dashRefresh')
    } finally {
      await server.close()
      cleanup()
    }
  }, 30_000)
})

let homeCounter = 0
function freshHome(): string {
  homeCounter++
  const dir = `/tmp/crm-b5-home-${Date.now()}-${homeCounter}`
  Bun.spawnSync(['mkdir', '-p', dir])
  return dir
}
