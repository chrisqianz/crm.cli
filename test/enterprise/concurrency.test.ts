import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@libsql/client'

import {
  bootstrapOwner,
  freshDb,
  REPO,
  startServer,
  type TestServer,
} from './helpers'

/**
 * P3: optimistic concurrency across real network clients
 * (spec/enterprise.md: "two concurrent writers → one wins, other gets exit
 * 3 with current state; retry-with-new-version succeeds").
 */
const CRM = join(REPO, 'src', 'cli.ts')

interface RemoteRun {
  exitCode: number
  stderr: string
  stdout: string
}

function remoteRun(
  server: TestServer,
  token: string,
  args: string[],
): RemoteRun {
  const proc = Bun.spawnSync(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: mkdtempSync(join(tmpdir(), 'crm-p3-home-')),
      CRM_SERVER: `127.0.0.1:${server.port}`,
      CRM_TOKEN: token,
      CRM_INSECURE: '1',
      CRM_CONFIG: '/dev/null',
    },
  })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

/** Concurrent remote run (async spawn + stream capture). */
function remoteRunAsync(
  server: TestServer,
  token: string,
  args: string[],
): Promise<RemoteRun> {
  const proc = Bun.spawn(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: mkdtempSync(join(tmpdir(), 'crm-p3-home-')),
      CRM_SERVER: `127.0.0.1:${server.port}`,
      CRM_TOKEN: token,
      CRM_INSECURE: '1',
      CRM_CONFIG: '/dev/null',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        buf += dec.decode(value, { stream: true })
      }
    }
    return buf
  }
  return Promise.all([proc.exited, read(proc.stdout), read(proc.stderr)]).then(
    ([, out, err]) => ({
      exitCode: proc.exitCode ?? -1,
      stdout: out,
      stderr: err,
    }),
  )
}

function showJson(
  server: TestServer,
  token: string,
  args: string[],
): Record<string, unknown> {
  const r = remoteRun(server, token, [...args, '--format', 'json'])
  expect(r.exitCode, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as Record<string, unknown>
}

async function withServer<T>(
  fn: (server: TestServer, token: string) => T | Promise<T>,
): Promise<T> {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    return await fn(server, owner.token)
  } finally {
    await server.close()
    cleanup()
  }
}

describe('P3 CAS: concurrent remote writers', () => {
  test('two concurrent edits at the same version: exactly one wins, loser exits 3', async () => {
    await withServer(async (server, token) => {
      const add = remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'Race',
        '--email',
        'race@p3.test',
      ])
      expect(add.exitCode, add.stderr).toBe(0)
      const id = add.stdout.trim()

      // Two clients read version 1, then both write at version 1 — in parallel.
      const [a, b] = await Promise.all([
        remoteRunAsync(server, token, [
          'contact',
          'edit',
          id,
          '--name',
          'Winner-A',
          '--version',
          '1',
        ]),
        remoteRunAsync(server, token, [
          'contact',
          'edit',
          id,
          '--name',
          'Winner-B',
          '--version',
          '1',
        ]),
      ])
      const results = [a, b]
      const codes = results.map((r) => r.exitCode).sort()
      expect(codes).toEqual([0, 3])
      const loser = results.find((r) => r.exitCode === 3)
      expect(loser?.stderr).toMatch(/conflict/i)
      expect(loser?.stderr).toContain('version: 2')

      // Exactly one name won
      const client = createClient({ url: `file:${server.dbPath}` })
      const rows = await client.execute(
        'SELECT name FROM contacts WHERE id = ?',
        [id],
      )
      const winnerName = String(rows.rows[0].name)
      await client.close()
      expect(['Winner-A', 'Winner-B']).toContain(winnerName)
    })
  })

  test('loser retries with the new version and succeeds', async () => {
    await withServer((server, token) => {
      const add = remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'Retry',
        '--email',
        'retry@p3.test',
      ])
      const id = add.stdout.trim()
      // Bump to v2 out of band
      const bump = remoteRun(server, token, [
        'contact',
        'edit',
        id,
        '--name',
        'Bumped',
      ])
      expect(bump.exitCode, bump.stderr).toBe(0)

      const stale = remoteRun(server, token, [
        'contact',
        'edit',
        id,
        '--name',
        'Stale',
        '--version',
        '1',
      ])
      expect(stale.exitCode).toBe(3)

      const retry = remoteRun(server, token, [
        'contact',
        'edit',
        id,
        '--name',
        'Re-read-and-retry',
        '--version',
        '2',
      ])
      expect(retry.exitCode, retry.stderr).toBe(0)
      const detail = showJson(server, token, ['contact', 'show', id])
      expect(detail.name).toBe('Re-read-and-retry')
      expect(detail.version).toBe(3)
    })
  })

  test('deal move with a stale version exits 3 remotely', async () => {
    await withServer((server, token) => {
      const add = remoteRun(server, token, [
        'deal',
        'add',
        '--title',
        'CasDeal',
        '--company',
        'CasCo',
        '--stage',
        'qualified',
      ])
      expect(add.exitCode, add.stderr).toBe(0)
      const id = add.stdout.trim()
      remoteRun(server, token, ['deal', 'move', id, '--stage', 'proposal']) // → v2
      const r = remoteRun(server, token, [
        'deal',
        'move',
        id,
        '--stage',
        'negotiation',
        '--version',
        '1',
      ])
      expect(r.exitCode).toBe(3)
      expect(r.stderr).toMatch(/conflict/i)
      const detail = showJson(server, token, ['deal', 'show', id])
      expect(detail.stage).toBe('proposal')
    })
  })
})

describe('P3 actor threading: remote writes are attributed', () => {
  test('entity rows carry the acting user in updated_by', async () => {
    await withServer((server, token) => {
      const add = remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'Attributed',
        '--email',
        'at@p3.test',
      ])
      const id = add.stdout.trim()
      const detail = showJson(server, token, ['contact', 'show', id])
      expect(detail.updated_by).toBe('admin')
      expect(detail.version).toBe(1)

      remoteRun(server, token, ['contact', 'edit', id, '--name', 'Attributed2'])
      const after = showJson(server, token, ['contact', 'show', id])
      expect(after.updated_by).toBe('admin')
      expect(after.version).toBe(2)
    })
  })

  test('company and deal rows are attributed too', async () => {
    await withServer((server, token) => {
      const co = remoteRun(server, token, [
        'company',
        'add',
        '--name',
        'ActorCo',
      ]).stdout.trim()
      const coDetail = showJson(server, token, ['company', 'show', co])
      expect(coDetail.updated_by).toBe('admin')

      const deal = remoteRun(server, token, [
        'deal',
        'add',
        '--title',
        'ActorDeal',
        '--company',
        'ActorCo',
        '--stage',
        'lead',
      ]).stdout.trim()
      const dealDetail = showJson(server, token, ['deal', 'show', deal])
      expect(dealDetail.updated_by).toBe('admin')
    })
  })
})
