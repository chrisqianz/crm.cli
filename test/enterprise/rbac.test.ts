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

/**
 * P3: the RBAC matrix as a table-driven test
 * (spec/enterprise.md roles table, owner/admin/writer/reader ×
 * read/write/admin — the audit column lands with P4).
 */
const CRM = join(REPO, 'src', 'cli.ts')

interface MatrixRow {
  canAdmin: boolean
  canRead: boolean
  canWrite: boolean
  role: 'owner' | 'admin' | 'writer' | 'reader'
}

const MATRIX: MatrixRow[] = [
  { role: 'owner', canRead: true, canWrite: true, canAdmin: true },
  { role: 'admin', canRead: true, canWrite: true, canAdmin: true },
  { role: 'writer', canRead: true, canWrite: true, canAdmin: false },
  { role: 'reader', canRead: true, canWrite: false, canAdmin: false },
]

function remoteRun(server: TestServer, token: string, args: string[]) {
  const proc = Bun.spawnSync(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: mkdtempSync(join(tmpdir(), 'crm-rbac-home-')),
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

async function makeToken(
  server: TestServer,
  ownerToken: string,
  username: string,
  role: string,
): Promise<string> {
  const client = await connect(server.port, ownerToken)
  try {
    await client.call('admin.user.create', { username, role })
    const created = await client.call<{ token: string }>('admin.token.create', {
      name: `${username}-token`,
      username,
    })
    return created.token
  } finally {
    client.close()
  }
}

async function withServer<T>(
  fn: (server: TestServer, ownerToken: string) => Promise<T>,
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

describe('P3 RBAC matrix (table-driven)', () => {
  for (const row of MATRIX) {
    test(`${row.role}: read=${row.canRead} write=${row.canWrite} admin=${row.canAdmin}`, async () => {
      await withServer(async (server, ownerToken) => {
        // owner cannot be provisioned via admin.user.create (bootstrap
        // only), so the matrix row reuses the bootstrap owner's token
        const token =
          row.role === 'owner'
            ? ownerToken
            : await makeToken(server, ownerToken, `user${row.role}`, row.role)

        // seed data as owner so reads have something to return
        const seed = remoteRun(server, ownerToken, [
          'contact',
          'add',
          '--name',
          'Seed',
          '--email',
          `seed-${row.role}@rbac.test`,
        ])
        expect(seed.exitCode, seed.stderr).toBe(0)

        // READ — every role in v1 sees all readable data
        const list = remoteRun(server, token, ['contact', 'list'])
        if (row.canRead) {
          expect(list.exitCode, list.stderr).toBe(0)
          expect(list.stdout).toContain('Seed')
        } else {
          expect(list.exitCode).toBe(1)
        }

        // WRITE
        const write = remoteRun(server, token, [
          'contact',
          'add',
          '--name',
          'WriteProbe',
          '--email',
          `write-${row.role}@rbac.test`,
        ])
        if (row.canWrite) {
          expect(write.exitCode, write.stderr).toBe(0)
        } else {
          expect(write.exitCode).toBe(1)
          expect(write.stderr).toContain(
            `role "${row.role}" cannot call contact.add`,
          )
        }

        // ADMIN
        const admin = remoteRun(server, token, ['admin', 'user', 'list'])
        if (row.canAdmin) {
          expect(admin.exitCode, admin.stderr).toBe(0)
        } else {
          expect(admin.exitCode).toBe(1)
          expect(admin.stderr).toContain(
            `role "${row.role}" cannot call admin.user.list`,
          )
        }
      })
    })
  }
})
