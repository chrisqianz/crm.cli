/**
 * Zero footprint (spec/client-repl.md, sub-project A): a machine that was
 * never told where its database lives must say so instead of creating one.
 * Host commands (`serve`, `backup`, `mount`, `export-fs`) take the fixed
 * NEEDS_DB copy; the client-side "not connected" failure takes NOT_CONNECTED.
 * Both are asserted as the constants exported by src/remote/dispatch.ts, so a
 * change to the copy has to be made in one place and shows up here as a
 * deliberate test edit.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NEEDS_DB, NOT_CONNECTED } from '../src/remote/dispatch'

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

/** Every path under `dir` that looks like crm state; bun's own cache is
 * excluded because it is the runtime, not the product. */
function leaked(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (p.includes('/Library/Caches')) {
        continue
      }
      if (e.isDirectory() && !e.isSymbolicLink()) {
        walk(p)
      } else if (/crm|\.db/i.test(e.name)) {
        out.push(p)
      }
    }
  }
  if (statSync(dir, { throwIfNoEntry: false })) {
    walk(dir)
  }
  return out
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

describe('zero footprint: no implicit local mode', () => {
  test('no server, no login: data command fails with guidance and leaks no files', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const r = cli(home, [
      'contact',
      'add',
      '--name',
      'Ghost',
      '--email',
      'g@x.io',
    ])
    expect(r.code).toBe(1)
    expect(r.out).toContain(NOT_CONNECTED)
    expect(leaked(home)).toEqual([])
  })
  test('CRM_LOCAL=1 alone fails with the same guidance, no files', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const env: Record<string, string> = {
      ...process.env,
      HOME: home,
      CRM_LOCAL: '1',
      NO_COLOR: '1',
    } as Record<string, string>
    for (const k of ['CRM_SERVER', 'CRM_TOKEN', 'CRM_CONFIG', 'CRM_DB']) {
      delete env[k]
    }
    const p = Bun.spawnSync(['bun', 'run', 'src/cli.ts', 'contact', 'list'], {
      cwd: join(import.meta.dir, '..'),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString() + p.stdout.toString()).toContain(NOT_CONNECTED)
    expect(leaked(home)).toEqual([])
  })
  test('explicit --db still works', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const r = cli(home, [
      '--db',
      join(home, 'explicit.db'),
      'contact',
      'add',
      '--name',
      'Local',
      '--email',
      'l@x.io',
    ])
    expect(r.code).toBe(0)
  })
  test('user-declared [database] in config still enables local mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    writeFileSync(
      join(home, 'crm.toml'),
      `[database]\npath = "${join(home, 'declared.db')}"\n`,
    )
    const r = cli(home, [
      '--config',
      join(home, 'crm.toml'),
      'contact',
      'add',
      '--name',
      'Declared',
      '--email',
      'd@x.io',
    ])
    expect(r.code).toBe(0)
  })
})
