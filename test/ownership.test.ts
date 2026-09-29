/**
 * P9 data model: ownership. Contacts and deals carry an `owner` (a
 * username), settable at add/edit and filterable at list via `--owner`.
 * `--mine` is exercised in remote mode (test/enterprise/ownership.test.ts),
 * where a caller identity exists; locally there is no caller, so `--mine`
 * keeps everything (a single user owns all rows).
 */
import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers'

describe('ownership: owner field on contacts and deals', () => {
  test('contact add --owner stores it; show/list expose it', () => {
    const { runOK, runJSON } = createTestContext()
    runOK(
      'contact',
      'add',
      'Acme 张',
      '--email',
      'zs@acme.com',
      '--owner',
      'lin',
    )
    const rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0].owner).toBe('lin')
    expect(runOK('contact', 'show', 'Acme 张')).toContain('lin')
  })

  test('contact edit --owner reassigns; absent owner is untouched', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('contact', 'add', '李四', '--owner', 'alice')
    runOK('contact', 'edit', '李四', '--owner', 'bob')
    let rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0].owner).toBe('bob')
    // an edit that does not pass --owner leaves the owner alone
    runOK('contact', 'edit', '李四', '--add-tag', 'vip')
    rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0].owner).toBe('bob')
  })

  test('contact list --owner filters (case-insensitive); --mine is a no-op locally', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('contact', 'add', 'A', '--owner', 'lin')
    runOK('contact', 'add', 'B', '--owner', 'zhang')
    runOK('contact', 'add', 'C')
    // exact, case-insensitive
    let rows = runJSON(
      'contact',
      'list',
      '--owner',
      'LIN',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(rows.map((r) => r.name).sort()).toEqual(['A'])
    // --mine with no caller (local) returns all rows
    rows = runJSON('contact', 'list', '--mine', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows.length).toBe(3)
  })

  test('deal add --owner + edit --owner + list --owner', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('deal', 'add', '续约', '--owner', 'lin', '--stage', 'qualified')
    runOK('deal', 'add', '新单', '--owner', 'zhang', '--stage', 'lead')
    runOK('deal', 'edit', '续约', '--owner', 'zhang')
    const rows = runJSON(
      'deal',
      'list',
      '--owner',
      'zhang',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(rows.map((r) => r.title).sort()).toEqual(['新单', '续约'])
    // a deal with no owner is excluded from an --owner filter
    runOK('deal', 'add', '无主单', '--stage', 'lead')
    const none = runJSON(
      'deal',
      'list',
      '--owner',
      'nobody',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(none.length).toBe(0)
  })

  test('owner column appears in table output once set', () => {
    const { runOK } = createTestContext()
    runOK('contact', 'add', '王五', '--owner', 'lin')
    expect(runOK('contact', 'list')).toContain('owner')
    runOK('deal', 'add', 'DealX', '--owner', 'lin', '--stage', 'qualified')
    expect(runOK('deal', 'list')).toContain('owner')
  })
})
