/**
 * Contact enrichment: first-class `addresses` field (add/edit/list/show)
 * and an `open_deal` (opportunity) column in the contact list, so the
 * default list reads like a CRM table instead of an id/name dump.
 */
import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers'

describe('contact address and opportunity fields', () => {
  test('add --address stores addresses; show and list expose them', () => {
    const { runOK, runJSON } = createTestContext()
    runOK(
      'contact',
      'add',
      '张三',
      '--email',
      'zs@a.com',
      '--address',
      '1099 8th St, San Francisco',
      '--address',
      '浦东兴福路88号12F',
    )
    expect(runOK('contact', 'show', '张三')).toContain(
      '1099 8th St, San Francisco',
    )
    const rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0].addresses).toEqual([
      '1099 8th St, San Francisco',
      '浦东兴福路88号12F',
    ])
  })

  test('edit --add-address / --rm-address', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('contact', 'add', '李四', '--address', 'old office')
    runOK('contact', 'edit', '李四', '--add-address', 'new office')
    let rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0].addresses).toEqual(['old office', 'new office'])
    runOK('contact', 'edit', '李四', '--rm-address', 'old office')
    rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0].addresses).toEqual(['new office'])
  })

  test("list carries the contact's open deal; closed deals drop out", () => {
    const { runOK, runJSON } = createTestContext()
    runOK('contact', 'add', '王五', '--phone', '4155551234')
    runOK(
      'deal',
      'add',
      'Q3 报价',
      '--value',
      '12000',
      '--contact',
      '王五',
      '--stage',
      'qualified',
    )
    let rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(String(rows[0].open_deal)).toContain('Q3 报价')
    expect(String(rows[0].open_deal)).toContain('qualified')
    // multiple open deals: biggest first, rest counted
    runOK(
      'deal',
      'add',
      '企业续约',
      '--value',
      '30000',
      '--contact',
      '王五',
      '--stage',
      'proposal',
    )
    rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(String(rows[0].open_deal)).toContain('企业续约')
    expect(String(rows[0].open_deal)).toContain('+1 more')
    // winning the deal removes it from the column
    runOK('deal', 'move', '企业续约', '--stage', 'closed-won')
    rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(String(rows[0].open_deal)).toContain('Q3 报价')
    expect(String(rows[0].open_deal)).not.toContain('more')
    // both closed → column empty
    runOK('deal', 'move', 'Q3 报价', '--stage', 'closed-won')
    rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0].open_deal ?? null).toBe(null)
  })

  test('table list shows phones, addresses and open_deal columns', () => {
    const { runOK } = createTestContext()
    runOK(
      'contact',
      'add',
      '赵六',
      '--phone',
      '2125551234',
      '--address',
      '1 Main St',
    )
    runOK(
      'deal',
      'add',
      'Enterprise Renewal',
      '--value',
      '5000',
      '--contact',
      '赵六',
      '--stage',
      'proposal',
    )
    const out = runOK('contact', 'list')
    for (const col of ['name', 'phones', 'addresses', 'open_deal']) {
      expect(out).toContain(col)
    }
  })
})
