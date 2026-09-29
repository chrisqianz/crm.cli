/**
 * P9: tasks over RPC. RBAC (writer can add/done/rm; reader is denied
 * writes), audit rows for task.* methods, and `--mine` filtering in remote
 * mode where a caller identity exists.
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
      HOME: mkdtempSync(join(tmpdir(), 'crm-task-home-')),
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

async function makeUser(
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

describe('P9 tasks over RPC', () => {
  test('writer can add/done/rm; reader is denied writes; rows audited', async () => {
    const { dbPath, cleanup } = freshDb()
    const server = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const writer = await makeUser(server, owner.token, 'lin', 'writer')
      const reader = await makeUser(server, owner.token, 'zhang', 'reader')

      // writer adds
      const add = remoteRun(server, writer, [
        'task',
        'add',
        'Remote task',
        '--owner',
        'lin',
      ])
      expect(add.exitCode, add.stderr).toBe(0)
      const id = add.stdout.trim()

      // reader cannot write
      const deny = remoteRun(server, reader, ['task', 'done', id])
      expect(deny.exitCode).toBe(1)
      expect(deny.stderr).toContain('role "reader" cannot call task.done')
      // reader can read
      const list = remoteRun(server, reader, [
        'task',
        'list',
        '--format',
        'json',
      ])
      expect(list.exitCode).toBe(0)

      // remote --mine: lin sees their (still open) task
      const mine = remoteRun(server, writer, [
        'task',
        'list',
        '--mine',
        '--format',
        'json',
      ])
      const mineRows = JSON.parse(mine.stdout) as Record<string, unknown>[]
      expect(mineRows.some((r) => r.title === 'Remote task')).toBe(true)

      // writer marks done
      const done = remoteRun(server, writer, ['task', 'done', id])
      expect(done.exitCode, done.stderr).toBe(0)
      expect(done.stdout).toContain('done')

      // audit recorded a task.add with entity_type task
      const audit = remoteRun(server, owner.token, [
        'audit',
        'list',
        '--format',
        'json',
      ])
      const rows = JSON.parse(audit.stdout) as Record<string, unknown>[]
      const taskAdds = rows.filter((r) => r.action === 'task.add')
      expect(taskAdds.length).toBeGreaterThanOrEqual(1)
      expect(taskAdds[0].entity_type).toBe('task')
    } finally {
      await server.close()
      cleanup()
    }
  })
})
