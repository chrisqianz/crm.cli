/**
 * P9 data model: configurable activity types. The accepted types come from
 * `[activity] types` in config (default note/call/meeting/email). A team
 * can add its real cadence (wechat, visit, entertainment, dingtalk) — or
 * replace the defaults — without patching the binary.
 */

import { describe, expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'

import { createTestContext } from './helpers'

describe('configurable activity types', () => {
  test('default types are accepted; unknown types are rejected', () => {
    const { runOK, runFail } = createTestContext()
    for (const t of ['note', 'call', 'meeting', 'email']) {
      runOK('log', t, 'default ok')
    }
    const r = runFail('log', 'wechat', 'rejected by default')
    expect(r.stderr).toContain('invalid activity type')
    expect(r.stderr).toContain('note, call, meeting, email')
  })

  test('config [activity] types adds new types and validates against the list', () => {
    const ctx = createTestContext()
    // extend the config with a domain-specific cadence
    appendFileSync(
      ctx.configPath,
      '\n[activity]\ntypes = ["note", "call", "wechat", "visit", "entertainment"]\n',
    )
    const { runOK, runFail } = ctx
    // new types now accepted
    runOK('log', 'wechat', '客户微信沟通')
    runOK('log', 'visit', '上门拜访')
    runOK('log', 'entertainment', '招待')
    // a default type no longer in the list is now rejected
    const r = runFail('log', 'meeting', 'no longer configured')
    expect(r.stderr).toContain('invalid activity type')
    expect(r.stderr).toContain('note, call, wechat, visit, entertainment')
    // and the logged wechat row is queryable
    const { runJSON } = ctx
    const rows = runJSON(
      'activity',
      'list',
      '--type',
      'wechat',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(rows.some((a) => a.body === '客户微信沟通')).toBe(true)
  })

  test('empty [activity] types falls back to the defaults', () => {
    const ctx = createTestContext()
    appendFileSync(ctx.configPath, '\n[activity]\ntypes = []\n')
    const { runOK, runFail } = ctx
    runOK('log', 'note', 'fallback works')
    const r = runFail('log', 'wechat', 'still default-gated')
    expect(r.stderr).toContain('invalid activity type')
  })
})
