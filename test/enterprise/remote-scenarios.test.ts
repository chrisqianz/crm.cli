/**
 * P2 — scenario tests run against the server.
 *
 * The scenario suite is written against the CLI command surface only, so it
 * can be pointed at a live `crm serve` instance by exporting
 * CRM_TEST_REMOTE_SERVER (+ token). This file boots a server and re-runs a
 * full scenario file in that mode, proving local and remote produce the same
 * behavior end to end.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  bootstrapOwner,
  freshDb,
  REPO,
  startServer,
  type TestServer,
} from './helpers'

const SCENARIO = 'devrel-outreach.test.ts'

describe('scenario against server (remote mode)', () => {
  let server: TestServer | null = null
  let token = ''
  let dbCleanup: (() => void) | null = null

  beforeAll(async () => {
    const { dbPath, cleanup } = freshDb()
    dbCleanup = cleanup
    server = await startServer(dbPath)
    const owner = await bootstrapOwner(server)
    token = owner.token
  })

  afterAll(async () => {
    if (server) {
      await server.close()
    }
    dbCleanup?.()
  })

  test(`scenario ${SCENARIO} passes in remote mode`, () => {
    const result = spawnSync(
      'bun',
      ['test', join(REPO, 'test', 'scenarios', SCENARIO)],
      {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          CRM_TEST_REMOTE_SERVER: `127.0.0.1:${server?.port ?? 0}`,
          CRM_TEST_REMOTE_TOKEN: token,
        },
        timeout: 180_000,
      },
    )
    const err = result.stderr?.toString() ?? ''
    const out = `${result.stdout?.toString() ?? ''}\n${err}`
    if (result.status !== 0) {
      // keep the failing scenario's own output for diagnosis
      throw new Error(`remote scenario failed (exit ${result.status})\n${out}`)
    }
    // bun test writes its summary to stderr
    expect(out).toContain('1 pass')
    expect(out).toContain('0 fail')
  }, 240_000)
})
