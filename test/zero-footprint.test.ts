/**
 * Zero footprint (spec/client-repl.md, sub-project A): a machine that was
 * never told where its database lives must say so instead of creating one.
 * Host commands (`serve`, `backup`, `mount`, `export-fs`) take the fixed
 * NEEDS_DB copy; the client-side "not connected" copy lands with the mode
 * contract.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    expect(r.out).toContain('server-host command — needs --db')
  })

  test('crm backup status without any db path fails with NEEDS_DB', () => {
    const r = cli(mkdtempSync(join(tmpdir(), 'crm-zf-')), ['backup', 'status'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('server-host command — needs --db')
  })

  test('crm export-fs without any db path fails with NEEDS_DB', () => {
    const out = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const r = cli(out, ['export-fs', join(out, 'tree')])
    expect(r.code).toBe(1)
    expect(r.out).toContain('server-host command — needs --db')
  })
})
