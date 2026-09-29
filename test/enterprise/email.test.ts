/**
 * P7: email integration on the server (remote mode). The SMTP relay
 * config lives in the SERVER's trusted config; the relay password in the
 * SERVER process env (never in the config file, never sent over RPC).
 * RBAC: writer+ may send; reader is refused. The send is auto-audited.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type MockSmtp, startMockSmtp } from '../smtp-mock'
import {
  bootstrapOwner,
  connect,
  freshDb,
  REPO,
  startServer,
  type TestServer,
} from './helpers'

const CRM = join(REPO, 'src', 'cli.ts')

async function slurp(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) {
    return ''
  }
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    out += dec.decode(value, { stream: true })
  }
  return out
}

/**
 * Async spawn on purpose: the mock SMTP relay lives in the test process,
 * and spawnSync would block the event loop it needs.
 */
async function remoteRun(
  server: TestServer,
  token: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: mkdtempSync(join(tmpdir(), 'crm-email-home-')),
      CRM_SERVER: `127.0.0.1:${server.port}`,
      CRM_TOKEN: token,
      CRM_INSECURE: '1',
      CRM_CONFIG: '/dev/null',
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    slurp(proc.stdout),
    slurp(proc.stderr),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
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

async function withEmailServer<T>(
  mock: MockSmtp,
  fn: (server: TestServer, ownerToken: string) => Promise<T>,
): Promise<T> {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath, {
    configBody: `[mail]
host = "127.0.0.1"
port = ${mock.port}
user = "relay-user"
from = "crm@corp.example"
`,
    env: { CRM_SMTP_PASSWORD: 'server-relay-pw' },
  })
  try {
    const owner = await bootstrapOwner(server)
    return await fn(server, owner.token)
  } finally {
    await server.close()
    cleanup()
  }
}

describe('email.send over RPC (server-side SMTP)', () => {
  test('owner sends through the server relay; activity + audit recorded', async () => {
    const mock = await startMockSmtp({
      auth: { user: 'relay-user', password: 'server-relay-pw' },
    })
    await withEmailServer(mock, async (server, ownerToken) => {
      const client = await connect(server.port, ownerToken)
      await client.call('contact.add', {
        name: 'Jane',
        email: ['jane@acme.com'],
      })
      client.close()

      const r = await remoteRun(server, ownerToken, [
        'email',
        'send',
        'Jane',
        '--subject',
        'Q3 proposal',
        '--body',
        'Hello Jane',
      ])
      expect(r.exitCode, r.stderr).toBe(0)

      expect(mock.messages.length).toBe(1)
      const msg = mock.messages[0]
      expect(msg.from).toBe('crm@corp.example')
      expect(msg.to).toEqual(['jane@acme.com'])
      expect(msg.data).toContain('Subject: Q3 proposal')
      expect(msg.auth?.password).toBe('server-relay-pw')

      // activity auto-logged
      const act = await remoteRun(server, ownerToken, [
        'activity',
        'list',
        '--contact',
        'Jane',
        '--format',
        'json',
      ])
      const rows = JSON.parse(act.stdout) as Array<{ type: string }>
      expect(rows.some((a) => a.type === 'email')).toBe(true)

      // auto-audited (write:true)
      const audit = await remoteRun(server, ownerToken, [
        'audit',
        'list',
        '--format',
        'json',
      ])
      const auditRows = JSON.parse(audit.stdout) as Array<{ action: string }>
      expect(auditRows.some((a) => a.action === 'email.send')).toBe(true)
    })
    await mock.close()
  }, 30_000)

  test('reader is refused; writer may send', async () => {
    const mock = await startMockSmtp({
      auth: { user: 'relay-user', password: 'server-relay-pw' },
    })
    await withEmailServer(mock, async (server, ownerToken) => {
      const client = await connect(server.port, ownerToken)
      await client.call('contact.add', {
        name: 'Jane',
        email: ['jane@acme.com'],
      })
      client.close()

      const readerToken = await makeToken(
        server,
        ownerToken,
        'reader1',
        'reader',
      )
      const reader = await remoteRun(server, readerToken, [
        'email',
        'send',
        'Jane',
        '--subject',
        's',
        '--body',
        'b',
      ])
      expect(reader.exitCode).toBe(1)
      expect(reader.stderr).toContain('role "reader" cannot call email.send')
      expect(mock.messages.length).toBe(0)

      const writerToken = await makeToken(
        server,
        ownerToken,
        'writer1',
        'writer',
      )
      const writer = await remoteRun(server, writerToken, [
        'email',
        'send',
        'Jane',
        '--subject',
        's',
        '--body',
        'b',
      ])
      expect(writer.exitCode, writer.stderr).toBe(0)
      expect(mock.messages.length).toBe(1)
    })
    await mock.close()
  }, 30_000)
})
