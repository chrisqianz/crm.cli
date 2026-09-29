/**
 * P9 data model: `--mine` in remote mode. The server injects the
 * authenticated caller's username; `contact list --mine` / `deal list
 * --mine` / `task list --mine` filter to that user's own rows. A
 * caller-supplied `caller` param is ignored (the server re-injects its
 * own, last), so one user cannot impersonate another's view.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bootstrapOwner,
  connect,
  freshDb,
  REPO,
  startServer,
  type TestServer,
} from './helpers'

const CRM = join(REPO, 'src', 'cli.ts')

function remoteRun(server: TestServer, token: string, args: string[]) {
  const proc = Bun.spawnSync(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: mkdtempSync(join(tmpdir(), 'crm-own-home-')),
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

async function makeWriter(
  server: TestServer,
  ownerToken: string,
  username: string,
): Promise<string> {
  const client = await connect(server.port, ownerToken)
  try {
    await client.call('admin.user.create', { username, role: 'writer' })
    const created = await client.call<{ token: string }>('admin.token.create', {
      name: `${username}-token`,
      username,
    })
    return created.token
  } finally {
    client.close()
  }
}

describe('P9 ownership: --mine in remote mode', () => {
  test('each user sees only their own rows with --mine', async () => {
    const { dbPath, cleanup } = freshDb()
    const server = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const lin = await makeWriter(server, owner.token, 'lin')
      const zhang = await makeWriter(server, owner.token, 'zhang')

      remoteRun(server, lin, [
        'contact',
        'add',
        'Lin-Contact',
        '--owner',
        'lin',
      ])
      remoteRun(server, zhang, [
        'contact',
        'add',
        'Zhang-Contact',
        '--owner',
        'zhang',
      ])

      const linMine = remoteRun(server, lin, [
        'contact',
        'list',
        '--mine',
        '--format',
        'json',
      ])
      expect(linMine.exitCode, linMine.stderr).toBe(0)
      const linRows = JSON.parse(linMine.stdout) as Record<string, unknown>[]
      expect(linRows.map((r) => r.name)).toEqual(['Lin-Contact'])

      // without --mine, everyone sees every row (v1 read model)
      const all = remoteRun(server, lin, [
        'contact',
        'list',
        '--format',
        'json',
      ])
      const allRows = JSON.parse(all.stdout) as Record<string, unknown>[]
      expect(allRows.length).toBe(2)

      // deals too
      remoteRun(server, lin, [
        'deal',
        'add',
        'Lin-Deal',
        '--owner',
        'lin',
        '--stage',
        'qualified',
      ])
      const dealMine = remoteRun(server, lin, [
        'deal',
        'list',
        '--mine',
        '--format',
        'json',
      ])
      const dealRows = JSON.parse(dealMine.stdout) as Record<string, unknown>[]
      expect(dealRows.map((r) => r.title)).toEqual(['Lin-Deal'])
    } finally {
      await server.close()
      cleanup()
    }
  })

  test('a forged caller param is ignored (server re-injects its own)', async () => {
    const { dbPath, cleanup } = freshDb()
    const server = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const lin = await makeWriter(server, owner.token, 'lin')
      // owner plants a row owned by owner
      remoteRun(server, owner.token, [
        'contact',
        'add',
        'Owner-Contact',
        '--owner',
        'admin',
      ])

      // lin calls contact.list with a forged caller=admin; the server must
      // still filter --mine against lin (its real identity), returning none.
      const client = await connect(server.port, lin)
      try {
        const res = await client.call<{
          rows: Record<string, unknown>[]
        }>('contact.list', { mine: true, caller: 'admin' })
        expect(res.rows.length).toBe(0)
        // and an explicit forged caller cannot widen --owner either:
        const res2 = await client.call<{
          rows: Record<string, unknown>[]
        }>('contact.list', { owner: 'admin', caller: 'lin' })
        // owner filter is caller-supplied (legit), so it matches the owner's
        // row — but the forged caller must not turn --mine into owner's view.
        expect(res2.rows.map((r) => r.name)).toEqual(['Owner-Contact'])
      } finally {
        client.close()
      }
    } finally {
      await server.close()
      cleanup()
    }
  })
})
