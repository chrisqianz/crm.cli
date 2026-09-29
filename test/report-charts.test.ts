/**
 * Report charts: `--chart` renders a terminal bar chart; `--chart <file.svg>`
 * writes a standalone SVG (zero-dependency) for embedding in docs/mail.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestContext } from './helpers'

describe('report charts', () => {
  test('pipeline --chart renders a terminal bar chart', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Alpha',
      '--value',
      '100000',
      '--stage',
      'lead',
    )
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Beta',
      '--value',
      '50000',
      '--stage',
      'qualified',
    )
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Gamma',
      '--value',
      '30000',
      '--stage',
      'qualified',
    )

    const out = ctx.runOK('report', 'pipeline', '--chart')
    expect(out).toContain('█')
    expect(out).toContain('lead')
    expect(out).toContain('qualified')
    // the bigger stage gets the longer bar
    const lines = out.split('\n').filter((l) => l.includes('█'))
    const lead = lines.find((l) => l.trim().startsWith('lead'))!
    const qual = lines.find((l) => l.trim().startsWith('qualified'))!
    expect(lead.match(/█/g)!.length).toBeGreaterThan(qual.match(/█/g)!.length)
  })

  test('pipeline --chart file writes an SVG', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Alpha',
      '--value',
      '100000',
      '--stage',
      'lead',
    )
    const svgPath = join(
      mkdtempSync(join(tmpdir(), 'crm-chart-')),
      'pipeline.svg',
    )
    ctx.runOK('report', 'pipeline', '--chart', svgPath)
    expect(existsSync(svgPath)).toBe(true)
    const svg = readFileSync(svgPath, 'utf-8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('lead')
    expect(svg).toContain('<rect')
  })

  test('conversion --chart shows stage rates', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'A', '--stage', 'lead')
    ctx.runOK('deal', 'add', '--title', 'B', '--stage', 'lead')
    ctx.runOK('deal', 'add', '--title', 'C', '--stage', 'lead')
    ctx.runOK('deal', 'move', 'C', '--stage', 'qualified')
    const out = ctx.runOK('report', 'conversion', '--chart')
    expect(out).toContain('█')
    expect(out).toMatch(/%/)
    expect(out).toContain('lead')
  })

  test('forecast --chart groups by close month', () => {
    const ctx = createTestContext()
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Nov1',
      '--value',
      '200000',
      '--probability',
      '50',
      '--expected-close',
      '2026-11-15',
    )
    ctx.runOK(
      'deal',
      'add',
      '--title',
      'Nov2',
      '--value',
      '100000',
      '--probability',
      '100',
      '--expected-close',
      '2026-11-20',
    )
    const out = ctx.runOK('report', 'forecast', '--chart')
    expect(out).toContain('2026-11')
    expect(out).toContain('█')
  })

  test('won --chart ranks deals by value', () => {
    const ctx = createTestContext()
    ctx.runOK('deal', 'add', '--title', 'SmallWin', '--value', '1000')
    ctx.runOK('deal', 'add', '--title', 'BigWin', '--value', '50000')
    ctx.runOK('deal', 'move', 'BigWin', '--stage', 'closed-won')
    ctx.runOK('deal', 'move', 'SmallWin', '--stage', 'closed-won')
    const out = ctx.runOK('report', 'won', '--chart')
    expect(out).toContain('BigWin')
    expect(out).toContain('█')
  })

  test('empty pipeline chart degrades gracefully', () => {
    const ctx = createTestContext()
    const out = ctx.runOK('report', 'pipeline', '--chart')
    expect(out).toMatch(/no (deals|data)/i)
  })
})
