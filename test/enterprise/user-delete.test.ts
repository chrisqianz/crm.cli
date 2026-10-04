/**
 * B2 — admin.user.delete: cascade tokens, owner refs → NULL, self-guard.
 *
 * Business rows survive the person: contacts/deals/tasks owned by the
 * username are unowned (NULL), not deleted — erasure is a P6 data-subject
 * question, not this one.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@libsql/client'

import {
  bootstrapOwner,
  connect,
  freshDb,
  startServer,
  type TestServer,
} from './helpers'

test("delete cascades tokens and unowns the target's rows", async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    await admin.call('admin.user.create', {
      username: 'doomed',
      role: 'writer',
    })
    const token = await admin.call<{ token: string }>('admin.token.create', {
      name: 'doomed-api',
      username: 'doomed',
    })
    expect(token.token).toMatch(/^crm_/)
    // give doomed owned rows in all three owner tables
    const client = createClient({ url: `file:${dbPath}` })
    await client.execute({
      sql: "INSERT INTO contacts (id, name, owner, created_at, updated_at) VALUES ('ct_doomed1', 'Doomed Contact', 'doomed', datetime('now'), datetime('now'))",
    })
    await client.execute({
      sql: "INSERT INTO deals (id, title, stage, owner, created_at, updated_at) VALUES ('dl_doomed1', 'Doomed Deal', 'open', 'doomed', datetime('now'), datetime('now'))",
    })
    await client.execute({
      sql: "INSERT INTO tasks (id, title, owner, created_at, updated_at) VALUES ('tk_doomed1', 'Doomed Task', 'doomed', datetime('now'), datetime('now'))",
    })
    client.close()

    const r = await admin.call<{ username: string }>('admin.user.delete', {
      username: 'doomed',
    })
    expect(r.username).toBe('doomed')

    // the user row and every token are gone
    const after = createClient({ url: `file:${dbPath}` })
    const users = await after.execute({
      sql: 'SELECT COUNT(*) AS n FROM users WHERE username = ?',
      args: ['doomed'],
    })
    expect(Number(users.rows[0].n)).toBe(0)
    const oldTokens = await after.execute({
      sql: "SELECT COUNT(*) AS n FROM tokens WHERE name = 'doomed-api'",
    })
    expect(Number(oldTokens.rows[0].n)).toBe(0)
    // ownership survives, the person does not
    for (const table of ['contacts', 'deals', 'tasks']) {
      const row = await after.execute({
        sql: `SELECT owner FROM ${table} WHERE id IN ('ct_doomed1', 'dl_doomed1', 'tk_doomed1')`,
      })
      expect(row.rows[0].owner).toBeNull()
    }
    // audit recorded the before-state
    const audit = await after.execute({
      sql: 'SELECT entity_id, before_json FROM audit_log WHERE action = ?',
      args: ['admin.user.delete'],
    })
    expect(audit.rows.length).toBe(1)
    const before = JSON.parse(String(audit.rows[0].before_json)) as {
      username?: string
    }
    expect(before.username).toBe('doomed')
    after.close()

    // unknown user → NOT_FOUND
    await expect(
      admin.call('admin.user.delete', { username: 'ghost' }),
    ).rejects.toThrow(/not found/)
  } finally {
    await server.close()
    cleanup()
  }
})

test('self-delete is refused', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    // even the owner cannot delete their own account
    await expect(
      admin.call('admin.user.delete', { username: 'admin' }),
    ).rejects.toThrow(/cannot delete your own account/)
    // and nobody is gone
    const check = createClient({ url: `file:${dbPath}` })
    const rows = await check.execute({
      sql: 'SELECT COUNT(*) AS n FROM users',
    })
    check.close()
    expect(Number(rows.rows[0].n)).toBe(1)
  } finally {
    await server.close()
    cleanup()
  }
})

test('reader cannot delete users (RBAC)', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    const created = await admin.call<{ initial_password: string }>(
      'admin.user.create',
      { username: 'eve', role: 'reader' },
    )
    const c = await connect(server.port)
    await c.call('auth.login', {
      username: 'eve',
      password: created.initial_password,
    })
    await expect(
      c.call('admin.user.delete', { username: 'eve' }),
    ).rejects.toThrow(/cannot call admin\.user\.delete/)
    c.close()
  } finally {
    await server.close()
    cleanup()
  }
})

test('crm admin user delete: typed confirmation', async () => {
  const { dbPath, cleanup } = freshDb()
  const server: TestServer = await startServer(dbPath)
  const home = mkdtempSync(join(tmpdir(), 'crm-udel-home-'))
  try {
    const owner = await bootstrapOwner(server)
    const admin = await connect(server.port, owner.token)
    await admin.call('admin.user.create', {
      username: 'doomed',
      role: 'reader',
    })
    const base = [
      'bun',
      'src/cli.ts',
      '--insecure',
      'admin',
      'user',
      'delete',
      '--server',
      `127.0.0.1:${server.port}`,
      '--username',
      'doomed',
    ]
    const env = {
      ...process.env,
      HOME: home,
      CRM_CONFIG: '/dev/null',
      NO_COLOR: '1',
      CRM_TOKEN: owner.token,
    }
    // wrong confirmation: aborted, nothing deleted
    const p1 = Bun.spawn(base, {
      cwd: process.cwd(),
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    p1.stdin.write('someone-else\n')
    p1.stdin.end()
    const err1 = await new Response(p1.stderr).text()
    const out1 = await new Response(p1.stdout).text()
    const code1 = await p1.exited
    expect(code1).toBe(1)
    expect(err1 + out1).toContain('Aborted')
    const check1 = createClient({ url: `file:${dbPath}` })
    const still = await check1.execute({
      sql: 'SELECT COUNT(*) AS n FROM users WHERE username = ?',
      args: ['doomed'],
    })
    check1.close()
    expect(Number(still.rows[0].n)).toBe(1)
    // the typed username confirms
    const p2 = Bun.spawn(base, {
      cwd: process.cwd(),
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    p2.stdin.write('doomed\n')
    p2.stdin.end()
    const out2 = await new Response(p2.stdout).text()
    const code2 = await p2.exited
    expect(code2).toBe(0)
    expect(out2).toContain('doomed')
    const check2 = createClient({ url: `file:${dbPath}` })
    const gone = await check2.execute({
      sql: 'SELECT COUNT(*) AS n FROM users WHERE username = ?',
      args: ['doomed'],
    })
    check2.close()
    expect(Number(gone.rows[0].n)).toBe(0)
  } finally {
    await server.close()
    cleanup()
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
