/**
 * Fuzzy discoverability: `crm suggest <words>` finds the command for a
 * description — including Chinese — and unknown-command errors get a
 * cross-tree "you probably meant" hint.
 */
import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers'

describe('crm suggest: fuzzy command search', () => {
  test('finds "delete a contact" in Chinese', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('suggest', '删除', '客户')
    expect(out).toContain('crm contact rm')
  })

  test('finds "delete a contact" in English', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('suggest', 'delete', 'contact')
    expect(out).toContain('crm contact rm')
  })

  test('finds the pipeline report from its purpose', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('suggest', 'pipeline', 'chart')
    expect(out).toContain('crm report pipeline')
  })

  test('finds export from Chinese', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('suggest', '导出')
    expect(out).toContain('crm export')
  })

  test('unknown words degrade gracefully', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('suggest', 'zzzqqqq', 'xyzzy')
    expect(out).toMatch(/no matching/i)
  })

  test('typo on a command gets a cross-tree hint', () => {
    const ctx = createTestContext()
    const r = ctx.runFail('contant', 'list')
    expect(r.stderr).toContain('contact')
  })
})
