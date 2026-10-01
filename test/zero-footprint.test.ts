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
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NEEDS_DB, NOT_CONNECTED } from '../src/remote/dispatch'
import { leaked } from './helpers'

function cli(home: string, args: string[]) {
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    NO_COLOR: '1',
    // Hermeticity: a crm.toml in the repo (or in a parent of the cwd these
    // commands run in) must not decide the mode under test. /dev/null parses
    // as an empty config and counts as explicitly selected, so nothing is
    // discovered and nothing is invented — same trick as
    // test/enterprise/mode-contract.test.ts. A test that wants config
    // discovery runs it in its own cwd (see the repo-local case below).
    CRM_CONFIG: '/dev/null',
  } as Record<string, string>
  for (const k of ['CRM_SERVER', 'CRM_TOKEN', 'CRM_LOCAL', 'CRM_DB']) {
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

/** The walker lives in test/helpers.ts (`leaked`) — the REPL session test in
 * test/repl/core.test.ts asserts the same contract from a different surface. */

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

  /**
   * A project-discovered config is the same kind of declaration: `loadConfig`
   * finds the nearest `crm.toml` by walking up from the cwd, so a checked-in
   * `[database] path` enables local mode inside that repo. Honoring it is the
   * stated decision (spec/client-repl.md A1) — a `crm.toml` you cd into was
   * authored by someone, so nothing was invented, which is what zero-footprint
   * actually forbids. Needs its own spawn: cwd *is* the input here, and
   * cli() pins CRM_CONFIG, which would outrank discovery.
   */
  test('a repo-local crm.toml [database] path is honored as a declaration, not invented', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-zf-repo-'))
    writeFileSync(join(dir, 'crm.toml'), '[database]\npath = "./here.db"\n')
    const env: Record<string, string> = {
      ...process.env,
      HOME: dir,
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
    const p = Bun.spawnSync(
      [
        'bun',
        'run',
        join(import.meta.dir, '..', 'src', 'cli.ts'),
        'contact',
        'add',
        '--name',
        'RepoLocal',
        '--email',
        'rl@x.io',
      ],
      { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const out = p.stdout.toString() + p.stderr.toString()
    expect(p.exitCode, out).toBe(0)
    // The declared relative path resolves against the cwd, and it is the only
    // database that appears: crm used what was declared, it did not guess.
    expect(existsSync(join(dir, 'here.db'))).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.db'))).toEqual([
      'here.db',
    ])
  })
})
