import { describe, expect, test } from 'bun:test'

import { createClient } from '@libsql/client'

import { createTestContext } from './helpers.ts'

/**
 * P4: the `crm audit` command surface — list (with filters), verify,
 * export. The hash chain itself is covered in test/enterprise/audit.test.ts.
 */

describe('crm audit list', () => {
  test('lists recent rows with actor/action/entity/source', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'contact',
      'add',
      '--name',
      'Alice',
      '--email',
      'alice@audit.test',
    )
    const id = ctx
      .runOK('company', 'add', '--name', 'Acme', '--website', 'acme.audit.test')
      .trim()
    ctx.runOK('company', 'edit', id, '--name', 'Acme Inc')

    const out = ctx.runOK('audit', 'list')
    expect(out).toContain('contact.add')
    expect(out).toContain('company.add')
    expect(out).toContain('company.edit')
    // local actor = OS user, source cli-local
    const user = (process.env.USER || process.env.LOGNAME || '').trim()
    if (user) {
      expect(out).toContain(user)
    }
    expect(out).toContain('cli-local')
  })

  test('--limit caps the rows', () => {
    const ctx = createTestContext()
    for (let i = 0; i < 5; i++) {
      ctx.runOK(
        'contact',
        'add',
        '--name',
        `C${i}`,
        '--email',
        `c${i}@limit.test`,
      )
    }
    const out = ctx.runOK('audit', 'list', '--limit', '2')
    // 2 data rows + at most header lines — the 5 adds must not all appear
    const lines = out.split('\n').filter((l) => l.includes('contact.add'))
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  test('--actor filters by actor name', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'A', '--email', 'a@actor.test')
    const user = (process.env.USER || process.env.LOGNAME || '').trim()
    const out = ctx.runOK('audit', 'list', '--actor', user)
    expect(out).toContain('contact.add')
    // an unknown actor yields no data rows
    const empty = ctx.run('audit', 'list', '--actor', 'nobody-here')
    expect(empty.stdout).not.toContain('contact.add')
  })

  test('--action filters by action', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'A', '--email', 'a@act.test')
    ctx.runOK('company', 'add', '--name', 'B', '--website', 'b.act.test')
    const out = ctx.runOK('audit', 'list', '--action', 'contact.add')
    expect(out).toContain('contact.add')
    expect(out).not.toContain('company.add')
  })

  test('--entity filters by entity id', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'E', '--email', 'e@ent.test')
      .trim()
    ctx.runOK('company', 'add', '--name', 'F', '--website', 'f.ent.test')
    const out = ctx.runOK('audit', 'list', '--entity', id)
    expect(out).toContain(id)
    expect(out).not.toContain('company.add')
  })

  test('--since filters by timestamp', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'Old', '--email', 'old@since.test')
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const out = ctx.run('audit', 'list', '--since', future)
    expect(out.stdout).not.toContain('contact.add')
    const past = new Date(0).toISOString()
    const out2 = ctx.runOK('audit', 'list', '--since', past)
    expect(out2).toContain('contact.add')
  })

  test('--format json is parseable', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'J', '--email', 'j@json.test')
    const out = ctx.runOK('audit', 'list', '--format', 'json')
    const rows = JSON.parse(out) as Array<{
      action: string
      source: string
      row_hash: string
      prev_hash: string
    }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.some((r) => r.action === 'contact.add')).toBe(true)
    expect(rows[0].row_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].prev_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('crm audit verify', () => {
  test('passes on an untampered db', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'V', '--email', 'v@verify.test')
    const out = ctx.runOK('audit', 'verify')
    expect(out).toMatch(/chain/i)
    expect(out).toMatch(/ok|intact/i)
  })

  test('detects tamper with the exact seq, exit 1', async () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'T', '--email', 't@verify.test')
    ctx.runOK('company', 'add', '--name', 'U', '--website', 'u.verify.test')
    const client = createClient({ url: `file:${ctx.dbPath}` })
    const r = await client.execute(
      `SELECT seq FROM audit_log WHERE action = 'contact.add' LIMIT 1`,
    )
    const seq = Number(String(r.rows[0].seq))
    await client.execute(
      `UPDATE audit_log SET actor_name = 'intruder' WHERE seq = ?`,
      [seq],
    )
    client.close()
    const out = ctx.run('audit', 'verify')
    expect(out.exitCode).toBe(1)
    expect(out.stdout + out.stderr).toContain(`seq ${seq}`)
  })
})

describe('crm audit export', () => {
  test('exports every row as json', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'E1', '--email', 'e1@exp.test')
    ctx.runOK('contact', 'add', '--name', 'E2', '--email', 'e2@exp.test')
    const out = ctx.runOK('audit', 'export', '--format', 'json')
    const rows = JSON.parse(out) as Array<{ action: string }>
    const adds = rows.filter((r) => r.action === 'contact.add')
    expect(adds.length).toBe(2)
  })

  test('exports csv with a stable header', () => {
    const ctx = createTestContext()
    ctx.runOK('contact', 'add', '--name', 'C', '--email', 'c@exp.test')
    const out = ctx.runOK('audit', 'export', '--format', 'csv')
    const lines = out.trim().split('\n')
    expect(lines[0]).toContain('seq')
    expect(lines[0]).toContain('action')
    expect(lines[0]).toContain('row_hash')
    expect(lines.length).toBeGreaterThan(1)
  })
})
