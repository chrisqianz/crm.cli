/**
 * Zero footprint (spec/client-repl.md, sub-project A): a machine that was
 * never told where its database lives must say so instead of creating one.
 * Host commands (`serve`, `backup`, `mount`, `export-fs`) take the fixed
 * NEEDS_DB copy; the client-side "not connected" copy lands with the mode
 * contract.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NEEDS_DB } from '../src/remote/dispatch'

function cli(home: string, args: string[]) {
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    NO_COLOR: '1',
  } as Record<string, string>
  for (const k of [
    'CRM_SERVER',
    'CRM_TOKEN',
    'CRM_LOCAL',
    'CRM_DB',
    'CRM_CONFIG',
  ]) {
    delete env[k]
  }
  const p = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: join(import.meta.dir, '..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: p.exitCode ?? -1,
    out: p.stdout.toString() + p.stderr.toString(),
  }
}

describe('zero footprint: host commands', () => {
  test('crm serve without any db path fails with NEEDS_DB', () => {
    const r = cli(mkdtempSync(join(tmpdir(), 'crm-zf-')), [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '1',
    ])
    expect(r.code).toBe(1)
    expect(r.out).toContain(NEEDS_DB)
  })

  test('crm backup status without any db path fails with NEEDS_DB', () => {
    const r = cli(mkdtempSync(join(tmpdir(), 'crm-zf-')), ['backup', 'status'])
    expect(r.code).toBe(1)
    expect(r.out).toContain(NEEDS_DB)
  })

  test('crm export-fs without any db path fails with NEEDS_DB', () => {
    const out = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const r = cli(out, ['export-fs', join(out, 'tree')])
    expect(r.code).toBe(1)
    expect(r.out).toContain(NEEDS_DB)
  })

  test('crm mount without any db path fails before touching the mountpoint', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const mp = mkdtempSync(join(tmpdir(), 'crm-zf-mp-'))
    const r = cli(home, ['mount', mp])
    expect(r.code).toBe(1)
    expect(r.out).toContain(NEEDS_DB)
    // the guard fires ahead of the helper compile / mkdir / spawn work
    expect(readdirSync(mp)).toEqual([])
  })
})
