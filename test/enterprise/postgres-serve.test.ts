/**
 * AL-1-6 (spec/alignment.md §3): `crm serve` against a central postgres
 * database, plus the two probes an orchestrator needs.
 *
 * The claim under test is that postgres is a *backend*, not a preview: the
 * same bootstrap flow, the same RPC surface, the same admin console, with a
 * readiness probe that can only fail in one direction — it never reports
 * "ready" for a database that is not answering.
 *
 * `/health` is process liveness and takes no dependencies; `/ready` runs a
 * real query through the seam. Conflating them is what turns a 30-second
 * database restart into a restarted container and a cold start storm.
 */
import { describe, expect, test } from 'bun:test'

import {
  createTestDatabase,
  dropTestDatabase,
  postgresAvailable,
} from './helpers/postgres.ts'
import {
  bootstrapOwner,
  connect,
  freshDb,
  startServer,
  type TestServer,
} from './helpers.ts'

const NO_PG = !postgresAvailable()
const ADMIN = ['--admin-port', '0']

function base(server: TestServer): string {
  if (server.adminPort === null) {
    throw new Error('server was started without --admin-port')
  }
  return `http://127.0.0.1:${server.adminPort}`
}

describe.skipIf(NO_PG)('serve on postgres (AL-1-6)', () => {
  test('bootstraps an owner over postgres and serves the full RPC surface', async () => {
    const url = await createTestDatabase()
    const server = await startServer('', { databaseUrl: url, args: ADMIN })
    try {
      expect(server.port).toBeGreaterThan(0)
      const owner = await bootstrapOwner(server, 'ada')
      const client = await connect(server.port, owner.token)
      try {
        await client.call('contact.add', {
          name: 'Grace Hopper',
          company: ['USN'],
          email: ['grace@usn.example'],
        })
        const listed = await client.call<{ rows: { name: string }[] }>(
          'contact.list',
          {},
        )
        expect(listed.rows.map((c) => c.name)).toContain('Grace Hopper')

        const search = await client.call<{ rows: unknown[] }>('search.search', {
          query: 'Hopper',
        })
        expect(search.rows.length).toBeGreaterThan(0)

        const status = await client.call<Record<string, unknown>>(
          'server.status',
          {},
        )
        expect(status.backend).toBe('postgres')
        expect(status.users).toBe(1)
        // A postgres server has no file to size — reporting 0 would be a
        // number that means nothing.
        expect(status.db_bytes).toBeNull()

        const audit = await client.call<{ rows: unknown[] }>('audit.list', {})
        expect(audit.rows.length).toBeGreaterThan(0)
      } finally {
        client.close()
      }
    } finally {
      await server.close()
      await dropTestDatabase(url)
    }
  }, 120_000)

  test('/health answers without auth; /ready reports the backend that answered', async () => {
    const url = await createTestDatabase()
    const server = await startServer('', { databaseUrl: url, args: ADMIN })
    try {
      const health = await fetch(`${base(server)}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })

      const ready = await fetch(`${base(server)}/ready`)
      expect(ready.status).toBe(200)
      expect(await ready.json()).toEqual({
        ready: true,
        backend: 'postgres',
        db: 'ok',
      })
    } finally {
      await server.close()
      await dropTestDatabase(url)
    }
  }, 120_000)

  test('/ready goes 503 when the database goes away while /health stays up', async () => {
    const url = await createTestDatabase()
    const server = await startServer('', { databaseUrl: url, args: ADMIN })
    try {
      // Bootstrap proves the probe has a live path to depend on.
      await bootstrapOwner(server, 'ada')
      const before = await fetch(`${base(server)}/ready`)
      expect(before.status).toBe(200)

      // A restart, a failover, a DBA dropping the database: the process is
      // fine, the dependency is not. Liveness must keep reporting 200 or the
      // orchestrator restarts a server that only needed to wait.
      await dropTestDatabase(url)
      const after = await fetch(`${base(server)}/ready`)
      expect(after.status).toBe(503)
      const body = (await after.json()) as Record<string, unknown>
      expect(body.ready).toBe(false)
      expect(body.backend).toBe('postgres')
      expect(typeof body.error).toBe('string')

      const health = await fetch(`${base(server)}/health`)
      expect(health.status).toBe(200)
    } finally {
      await server.close()
    }
  }, 120_000)

  test('refuses continuous replication instead of pointing litestream at postgres', async () => {
    const url = await createTestDatabase()
    let failure: Error | null = null
    try {
      await startServer('', {
        databaseUrl: url,
        configBody: '[backup]\ndestination = "file:///tmp/crm-pg-backup"\n',
      })
    } catch (e) {
      failure = e as Error
    }
    // startServer rejects when no READY line arrives: the server refused to
    // start rather than accept a backup configuration it cannot honour.
    expect(failure).not.toBeNull()
    expect(failure?.message).toContain('litestream')
    expect(failure?.message).toContain('pg_dump')
    await dropTestDatabase(url)
  }, 60_000)
})

describe('serve on sqlite still reports its backend (AL-1-6 regression)', () => {
  test('a file-backed server says sqlite and measures its own file', async () => {
    const { dbPath, cleanup } = freshDb()
    const server = await startServer(dbPath, { args: ADMIN })
    try {
      const owner = await bootstrapOwner(server, 'ada')
      const ready = await fetch(`${base(server)}/ready`)
      expect(ready.status).toBe(200)
      expect(await ready.json()).toEqual({
        ready: true,
        backend: 'sqlite',
        db: 'ok',
      })
      const health = await fetch(`${base(server)}/health`)
      expect(health.status).toBe(200)

      const client = await connect(server.port, owner.token)
      try {
        const status = await client.call<Record<string, unknown>>(
          'server.status',
          {},
        )
        expect(status.backend).toBe('sqlite')
      } finally {
        client.close()
      }
    } finally {
      await server.close()
      cleanup()
    }
  }, 60_000)
})
