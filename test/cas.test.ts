import { describe, expect, test } from 'bun:test'

import { createTestContext, type RunResult } from './helpers'

type Ctx = ReturnType<typeof createTestContext>

/**
 * P3: optimistic concurrency in local mode (spec/enterprise.md).
 *
 * Every data row (contact/company/deal) carries `version`, starting at 1 and
 * bumping on each write. `edit`/`move` accept an optional `--version <n>`:
 * when given, the update is a compare-and-set — a stale version fails with
 * exit code 3 (conflict is a recoverable, expected outcome, not an error).
 * Without `--version`, behavior is exactly today's last-write-wins.
 */

function versionOf(ctx: Ctx, id: string): number {
  const out = ctx.run('contact', 'show', id, '--format', 'json') as RunResult
  return (JSON.parse(out.stdout) as { version: number }).version
}

describe('P3 CAS: local contact edit', () => {
  test('version starts at 1 and bumps on every write', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'V', '--email', 'v@cas.test')
      .trim()
    expect(versionOf(ctx, id)).toBe(1)

    ctx.runOK('contact', 'edit', id, '--name', 'V2')
    expect(versionOf(ctx, id)).toBe(2)

    ctx.runOK('contact', 'edit', id, '--name', 'V3')
    expect(versionOf(ctx, id)).toBe(3)
  })

  test('edit with the current version succeeds (CAS pass)', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'C', '--email', 'c@cas.test')
      .trim()
    const r = ctx.run('contact', 'edit', id, '--name', 'C2', '--version', '1')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(versionOf(ctx, id)).toBe(2)
  })

  test('edit with a stale version exits 3 and reports the current version', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'S', '--email', 's@cas.test')
      .trim()
    ctx.runOK('contact', 'edit', id, '--name', 'S2') // → v2

    const r = ctx.run('contact', 'edit', id, '--name', 'S3', '--version', '1')
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toMatch(/conflict/i)
    expect(r.stderr).toContain('version: 2')
    // The losing write must not have landed
    const shown = ctx.run('contact', 'show', id, '--format', 'json')
    expect((JSON.parse(shown.stdout) as { name: string }).name).toBe('S2')
  })

  test('an unversioned write invalidates a previously read version', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'U', '--email', 'u@cas.test')
      .trim()
    // Reader A sees v1; someone else writes without CAS…
    ctx.runOK('contact', 'edit', id, '--name', 'U-unversioned')
    // …reader A's --version 1 must now conflict
    const r = ctx.run(
      'contact',
      'edit',
      id,
      '--name',
      'U-stale',
      '--version',
      '1',
    )
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toMatch(/conflict/i)
  })

  test('retrying with the new version succeeds (recoverable conflict)', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'R', '--email', 'r@cas.test')
      .trim()
    ctx.runOK('contact', 'edit', id, '--name', 'R2') // → v2
    const stale = ctx.run(
      'contact',
      'edit',
      id,
      '--name',
      'X',
      '--version',
      '1',
    )
    expect(stale.exitCode).toBe(3)
    // Re-read, retry:
    const retry = ctx.run(
      'contact',
      'edit',
      id,
      '--name',
      'R-retry',
      '--version',
      '2',
    )
    expect(retry.exitCode, retry.stderr).toBe(0)
    const shown = ctx.run('contact', 'show', id, '--format', 'json')
    expect((JSON.parse(shown.stdout) as { name: string }).name).toBe('R-retry')
  })

  test('invalid --version values are rejected with exit 1', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'I', '--email', 'i@cas.test')
      .trim()
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const r = ctx.run('contact', 'edit', id, '--name', 'I2', '--version', bad)
      expect(r.exitCode, `${bad}: ${r.stderr}`).toBe(1)
      expect(r.stderr).toMatch(/invalid/i)
    }
  })
})

describe('P3 CAS: company edit and deal move', () => {
  test('company edit enforces the same CAS contract', () => {
    const ctx = createTestContext()
    const co = ctx
      .runOK('company', 'add', '--name', 'Co', '--website', 'co.example.com')
      .trim()
    ctx.runOK('company', 'edit', co, '--name', 'Co2') // → v2
    const r = ctx.run('company', 'edit', co, '--name', 'Co3', '--version', '1')
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toMatch(/conflict/i)
    expect(r.stderr).toContain('version: 2')
  })

  test('deal move enforces the same CAS contract', () => {
    const ctx = createTestContext()
    ctx.runOK('company', 'add', '--name', 'MoveCo')
    const deal = ctx
      .runOK(
        'deal',
        'add',
        '--title',
        'D',
        '--company',
        'MoveCo',
        '--value',
        '1000',
        '--stage',
        'qualified',
      )
      .trim()
    // Someone moves the deal without CAS → v2
    ctx.runOK('deal', 'move', deal, '--stage', 'proposal')
    // A stale reader's move must conflict
    const r = ctx.run(
      'deal',
      'move',
      deal,
      '--stage',
      'negotiation',
      '--version',
      '1',
    )
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toMatch(/conflict/i)
    // stage unchanged by the losing move
    const shown = ctx.run('deal', 'show', deal, '--format', 'json')
    expect((JSON.parse(shown.stdout) as { stage: string }).stage).toBe(
      'proposal',
    )
    const ok = ctx.run(
      'deal',
      'move',
      deal,
      '--stage',
      'negotiation',
      '--version',
      '2',
    )
    expect(ok.exitCode, ok.stderr).toBe(0)
  })
})

describe('P3 CAS: actor threading (local)', () => {
  test('local writes leave updated_by empty (single-user, no identity)', () => {
    const ctx = createTestContext()
    const id = ctx
      .runOK('contact', 'add', '--name', 'A', '--email', 'a@cas.test')
      .trim()
    ctx.runOK('contact', 'edit', id, '--name', 'A2')
    const shown = ctx.run('contact', 'show', id, '--format', 'json')
    const detail = JSON.parse(shown.stdout) as { updated_by: string | null }
    expect(detail.updated_by ?? null).toBeNull()
  })
})
