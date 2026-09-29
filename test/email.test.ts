/**
 * Email integration (local mode): `crm email send` routes through the
 * configured SMTP relay (mocked in-process) and auto-logs an `email`
 * activity. Relay secrets live only in env, never in the config file.
 *
 * NOTE: the CLI must be spawned ASYNCHRONOUSLY — the mock SMTP server
 * lives in the test process, and spawnSync would block the event loop
 * the mock needs to answer the greeting.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type MockSmtp, startMockSmtp } from './smtp-mock'

const REPO = join(import.meta.dir, '..')

async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
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

interface LocalCtx {
  run: (
    args: string[],
    env?: Record<string, string>,
  ) => Promise<{ code: number; out: string }>
}

function makeCtx(mock: MockSmtp, dir: string): LocalCtx {
  const cfg = join(dir, 'crm.toml')
  writeFileSync(
    cfg,
    `[phone]
default_country = "US"

[mail]
host = "127.0.0.1"
port = ${mock.port}
user = "crm-cli"
from = "crm-cli@corp.example"
`,
  )
  const baseEnv = {
    ...process.env,
    HOME: dir,
    NO_COLOR: '1',
    CRM_CONFIG: cfg,
    CRM_SMTP_PASSWORD: 'sekrit-relay-pw',
  }
  return {
    run: async (args, extra = {}) => {
      const proc = Bun.spawn(
        ['bun', 'run', join(REPO, 'src', 'cli.ts'), ...args],
        {
          cwd: REPO,
          env: { ...baseEnv, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        proc.stdout ? streamToString(proc.stdout) : Promise.resolve(''),
        proc.stderr ? streamToString(proc.stderr) : Promise.resolve(''),
        proc.exited,
      ])
      return { code, out: stdout + stderr }
    },
  }
}

describe('crm email send (local mode)', () => {
  const toClose: MockSmtp[] = []

  async function newMock(): Promise<MockSmtp> {
    const m = await startMockSmtp({
      auth: { user: 'crm-cli', password: 'sekrit-relay-pw' },
    })
    toClose.push(m)
    return m
  }

  afterAll(async () => {
    for (const m of toClose) {
      await m.close()
    }
  })

  test('sends to the contact address and logs the activity', async () => {
    const m = await newMock()
    const dir = mkdtempSync(join(tmpdir(), 'crm-email-'))
    const ctx = makeCtx(m, dir)
    await ctx.run(['contact', 'add', 'Jane', '--email', 'jane@acme.com'])
    const r = await ctx.run([
      'email',
      'send',
      'Jane',
      '--subject',
      'Q3 proposal',
      '--body',
      'Hi Jane, attached the proposal.',
    ])
    expect(r.code).toBe(0)
    expect(r.out).toContain('jane@acme.com')
    expect(m.messages.length).toBe(1)
    const msg = m.messages[0]
    expect(msg.from).toBe('crm-cli@corp.example')
    expect(msg.to).toEqual(['jane@acme.com'])
    expect(msg.data).toContain('Subject: Q3 proposal')
    expect(msg.data).toContain('Hi Jane, attached the proposal.')
    expect(msg.auth?.user).toBe('crm-cli')
    expect(msg.auth?.password).toBe('sekrit-relay-pw')
    const act = await ctx.run([
      'activity',
      'list',
      '--contact',
      'Jane',
      '--format',
      'json',
    ])
    const rows = JSON.parse(act.out) as Record<string, string>[]
    expect(rows.some((a) => a.type === 'email')).toBe(true)
  })

  test('--to overrides the recipient; --cc is added', async () => {
    const m = await newMock()
    const dir = mkdtempSync(join(tmpdir(), 'crm-email-'))
    const ctx = makeCtx(m, dir)
    await ctx.run(['contact', 'add', 'Bob', '--email', 'bob@x.com'])
    const r = await ctx.run([
      'email',
      'send',
      'Bob',
      '--to',
      'bob@other.com',
      '--cc',
      'boss@corp.example',
      '--subject',
      'FYI',
      '--body',
      'cc test',
    ])
    expect(r.code).toBe(0)
    // SMTP RCPT TO carries BOTH To: and Cc: recipients
    expect(m.messages[0].to).toContain('bob@other.com')
    expect(m.messages[0].to).toContain('boss@corp.example')
    expect(m.messages[0].data).toContain('To: bob@other.com')
    expect(m.messages[0].data).toContain('Cc: boss@corp.example')
  })

  test('unconfigured SMTP fails cleanly', async () => {
    const m = await newMock()
    const dir = mkdtempSync(join(tmpdir(), 'crm-email-'))
    const ctx = makeCtx(m, dir)
    writeFileSync(join(dir, 'crm.toml'), `[phone]\ndefault_country = "US"\n`)
    await ctx.run(['contact', 'add', 'A', '--email', 'a@a.com'])
    const r = await ctx.run([
      'email',
      'send',
      'A',
      '--subject',
      's',
      '--body',
      'b',
    ])
    expect(r.code).toBe(1)
    expect(r.out).toContain('SMTP not configured')
    expect(m.messages.length).toBe(0)
  })

  test('missing relay password fails cleanly', async () => {
    const m = await newMock()
    const dir = mkdtempSync(join(tmpdir(), 'crm-email-'))
    const ctx = makeCtx(m, dir)
    await ctx.run(['contact', 'add', 'A', '--email', 'a@a.com'])
    const r = await ctx.run(
      ['email', 'send', 'A', '--subject', 's', '--body', 'b'],
      { CRM_SMTP_PASSWORD: '' },
    )
    expect(r.code).toBe(1)
    expect(r.out).toContain('CRM_SMTP_PASSWORD')
  })

  test('--body-file reads the body from disk', async () => {
    const m = await newMock()
    const dir = mkdtempSync(join(tmpdir(), 'crm-email-'))
    const ctx = makeCtx(m, dir)
    await ctx.run(['contact', 'add', 'FileGuy', '--email', 'fg@x.com'])
    writeFileSync(join(dir, 'note.txt'), 'Body from file')
    const r = await ctx.run([
      'email',
      'send',
      'FileGuy',
      '--subject',
      'F',
      '--body-file',
      join(dir, 'note.txt'),
    ])
    expect(r.code).toBe(0)
    expect(m.messages[0].data).toContain('Body from file')
  })

  test('contact without email requires --to', async () => {
    const m = await newMock()
    const dir = mkdtempSync(join(tmpdir(), 'crm-email-'))
    const ctx = makeCtx(m, dir)
    await ctx.run(['contact', 'add', 'NoMail'])
    const r = await ctx.run([
      'email',
      'send',
      'NoMail',
      '--subject',
      's',
      '--body',
      'b',
    ])
    expect(r.code).toBe(1)
    expect(r.out).toContain('no email address')
  })
})
