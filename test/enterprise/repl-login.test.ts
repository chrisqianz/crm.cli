/**
 * Task 5 — the login path end to end: a human opens the REPL, types
 * `login`, answers three prompts, and every later command rides the saved
 * session to the real server. Asserts the whole contract: status line,
 * remote write + read-back, and the audit row the server recorded.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bootstrapOwner, freshDb, startServer } from './helpers'

interface ReplRun {
  code: number
  err: string
  out: string
}

async function repl(
  lines: string[],
  opts: { argv?: string[]; extra?: Record<string, string> } = {},
): Promise<ReplRun> {
  const home = mkdtempSync(join(tmpdir(), 'crm-repl-login-'))
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    CRM_REPL_FORCE: '1',
    CRM_CONFIG: '/dev/null',
    NO_COLOR: '1',
  }
  // Hermetic: strip inherited mode switches, then let the test re-add its
  // own through `extra` — the strip must not eat what the test just set.
  for (const k of ['CRM_DB', 'CRM_SERVER', 'CRM_TOKEN']) {
    delete env[k]
  }
  Object.assign(env, opts.extra)
  const p = Bun.spawn(['bun', 'src/cli.ts', ...(opts.argv ?? [])], {
    cwd: process.cwd(),
    env: env as NodeJS.ProcessEnv,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  p.stdin.write(`${lines.map((l) => `${l}\n`).join('')}`)
  p.stdin.end()
  return {
    out: await new Response(p.stdout).text(),
    err: await new Response(p.stderr).text(),
    code: await p.exited,
  }
}

test('login wizard rides the real login command and the session works', async () => {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server, 'owner')
    // `crm --insecure` at the door: the test server's cert is self-signed,
    // exactly the dev-box situation a human faces.
    const r = await repl(
      [
        'login',
        `127.0.0.1:${server.port}`,
        'owner',
        owner.password,
        'status',
        'contact add "Ada Remote" --email ada@x.io',
        'find Ada',
        'logout',
        'status',
        'q',
      ],
      { argv: ['--insecure'] },
    )
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    // the wizard asked for exactly what it should have
    expect(r.out).toContain('server (host:port)')
    expect(r.out).toContain('username')
    expect(r.out).toContain('password')
    // login worked: the status line names the session
    expect(r.out).toContain(`owner@127.0.0.1:${server.port} ✓`)
    // a remote write landed and reads back through the same session:
    // add prints the bare id, and `find Ada` resolves it to a row line
    expect(r.out).toMatch(/ct_[A-Z0-9]+/)
    expect(r.out).toContain('[contact] Ada Remote')
    // logout drops the session
    const after = r.out.split('Cleared')[1] ?? ''
    expect(after).toContain('not logged in')

    // the server recorded the write as an audit row owned by `owner`
    // (libSQL client, same as audit.test.ts — the serve DB is libSQL,
    // not something bun:sqlite can see)
    const { createClient } = await import('@libsql/client')
    const lq = createClient({ url: `file:${dbPath}` })
    const res = await lq.execute(
      `SELECT action, actor_name, entity_type FROM audit_log
             WHERE action = 'contact.add'`,
    )
    expect(res.rows.length).toBe(1)
    expect(res.rows[0].actor_name).toBe('owner')
    expect(res.rows[0].entity_type).toBe('contact')
  } finally {
    await server.close()
    cleanup()
  }
}, 60_000)

test('login keeps a known server and only asks for credentials', async () => {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  try {
    await bootstrapOwner(server, 'owner')
    // CRM_SERVER is set: the wizard must skip the server question.
    const r = await repl(['login', 'owner', 'Owner-pass-123', 'status', 'q'], {
      argv: ['--insecure'],
      extra: { CRM_SERVER: `127.0.0.1:${server.port}` },
    })
    expect(r.out).not.toContain('server (host:port)')
    expect(r.out).toContain('username')
    expect(r.out).toContain(`owner@127.0.0.1:${server.port} ✓`)
    expect(r.code).toBe(0)
  } finally {
    await server.close()
    cleanup()
  }
}, 60_000)

test('a wrong password fails the wizard without logging in', async () => {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  try {
    await bootstrapOwner(server, 'owner')
    const r = await repl(
      [
        'login',
        `127.0.0.1:${server.port}`,
        'owner',
        'totally-wrong',
        'status',
        'q',
      ],
      { argv: ['--insecure'] },
    )
    // the failure is die() copy — stderr, same as the one-shot CLI — and
    // the loop survives it: the following status still answers.
    expect(r.err).toContain('login failed: invalid credentials')
    expect(r.out).toContain('not logged in')
    expect(r.out).not.toContain(`owner@127.0.0.1:${server.port} ✓`)
    expect(r.code).toBe(0) // the REPL survives a failed login
  } finally {
    await server.close()
    cleanup()
  }
}, 60_000)
