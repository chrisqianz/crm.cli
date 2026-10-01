/**
 * The REPL is a presentation layer: every line ends up as argv in the *same*
 * commander program one-shot uses. These tests drive the real binary (spawned
 * from source, hermetic HOME) with CRM_REPL_FORCE=1 — the hidden test seam —
 * so what is asserted is what a human gets: same commands, same output, and a
 * loop that survives a command calling die() → process.exit(1).
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'

import { buildProgram } from '../../src/cli'
import type { ReplContext } from '../../src/repl/repl'
import { handleLine, statusLine, tokenize } from '../../src/repl/repl'

interface ReplRun {
  code: number
  err: string
  home: string
  out: string
}

/** spawn: bun src/cli.ts, HOME=isolated, CRM_REPL_FORCE=1, feed stdin lines */
async function repl(
  lines: string[],
  argv: string[] = [],
  extra: Record<string, string> = {},
): Promise<ReplRun> {
  const home = mkdtempSync(join(tmpdir(), 'crm-repl-'))
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    CRM_REPL_FORCE: '1',
    CRM_CONFIG: '/dev/null',
    NO_COLOR: '1',
    ...extra,
  }
  // Hermetic: an inherited CRM_DB/CRM_SERVER/CRM_TOKEN would silently switch
  // the spawned CLI out of the mode the test is about. Computed key, matching
  // test/zero-footprint.test.ts.
  for (const k of ['CRM_DB', 'CRM_SERVER', 'CRM_TOKEN']) {
    delete env[k]
  }
  const p = Bun.spawn(['bun', 'src/cli.ts', ...argv], {
    cwd: process.cwd(),
    env: env as NodeJS.ProcessEnv,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  p.stdin.write(`${lines.map((l) => `${l}\n`).join('')}`)
  p.stdin.end()
  return {
    out: await new Response(p.stdout).text(),
    err: await new Response(p.stderr).text(),
    code: await p.exited,
    home,
  }
}

function freshDb(name = 'x.db'): string {
  return join(mkdtempSync(join(tmpdir(), 'crm-repl-db')), name)
}

function ctx(entryArgv: string[] = []): ReplContext {
  return { program: new Command(), home: '/tmp/crm-unit-home', entryArgv }
}

test('empty crm opens the REPL and q exits 0', async () => {
  const r = await repl(['q'])
  expect(r.out).toContain('crm>')
  expect(r.code).toBe(0)
}, 30_000)

test('REPL runs one-shot commands through the same surface', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'crm-repl-db')), 'x.db')
  const r = await repl(
    ['contact add Ada --email ada@x.io', 'contact list', 'q'],
    ['--db', db],
  )
  expect(r.out).toContain('Ada')
  expect(r.code).toBe(0)
}, 30_000)

test('die() inside a command does not kill the REPL', async () => {
  const r = await repl(
    ['contact show nope', 'contact add Ben --email b@x.io', 'q'],
    ['--db', `/tmp/none-${Date.now()}.db`],
  )
  // first line: not-found error printed, REPL survives, Ben created → exit 0
  expect(r.err + r.out).toContain('Error:')
  expect(r.err + r.out).toContain('contact not found: nope')
  // the id line the surviving second command printed
  expect(r.out).toMatch(/ct_[0-9A-Z]{20,}/)
  expect(r.code).toBe(0)
}, 30_000)

test('non-TTY without FORCE never enters the REPL', async () => {
  const r = await repl(['q'], [], { CRM_REPL_FORCE: '' })
  expect(r.out).not.toContain('crm>')
  expect(r.code).not.toBe(0) // commander usage error, machine surface untouched
}, 30_000)

describe('REPL session words', () => {
  test('status says not logged in, help reaches commander', async () => {
    const r = await repl(['status', 'help', 'q'])
    expect(r.out).toContain('not logged in')
    expect(r.out).toContain('Usage: crm')
    expect(r.code).toBe(0)
  }, 30_000)

  test('status names the local database the entry argv carried', async () => {
    const r = await repl(['status', 'q'], ['--db', freshDb('mine.db')])
    expect(r.out).toContain('local:mine.db')
    expect(r.code).toBe(0)
  }, 30_000)

  test('status reads the --db=value form too', () => {
    // Pure: the --db branch decides before anything touches session state.
    expect(statusLine(ctx(['--db=mine.db']))).toBe('local:mine.db')
    expect(statusLine(ctx(['--verbose', '--db', 'other.db']))).toBe(
      'local:other.db',
    )
  })

  /**
   * Commander keeps option values between parses on the same program and the
   * shared `[]` default of a collecting flag is the one thing it cannot undo.
   * A second `contact add` in one session must not inherit the first one's
   * emails (which would also trip the duplicate-email CONFLICT).
   */
  test('consecutive commands do not leak collecting flags', async () => {
    const r = await repl(
      [
        'contact add Ada --email ada@x.io',
        'contact add Ben --email ben@x.io',
        'contact show Ben',
        'q',
      ],
      ['--db', freshDb()],
    )
    expect(r.err).not.toContain('Error:')
    expect(r.out).toContain('emails: ben@x.io')
    expect(r.out).not.toContain('ada@x.io, ben@x.io')
    expect(r.code).toBe(0)
  }, 30_000)
})

describe('handleLine (Task 1 grammar)', () => {
  test('empty and whitespace-only lines are no-ops', async () => {
    expect(await handleLine('', ctx())).toBeNull()
    expect(await handleLine('   ', ctx())).toBeNull()
  })

  test('session words map to the session intent', async () => {
    expect(await handleLine('q', ctx())).toEqual({
      kind: 'session',
      op: 'quit',
    })
    expect(await handleLine('quit', ctx())).toEqual({
      kind: 'session',
      op: 'quit',
    })
    expect(await handleLine('exit', ctx())).toEqual({
      kind: 'session',
      op: 'quit',
    })
    expect(await handleLine('?', ctx())).toEqual({
      kind: 'session',
      op: 'help',
    })
    expect(await handleLine('help', ctx())).toEqual({
      kind: 'session',
      op: 'help',
    })
    expect(await handleLine('commands', ctx())).toEqual({
      kind: 'session',
      op: 'help',
    })
    expect(await handleLine('status', ctx())).toEqual({
      kind: 'session',
      op: 'status',
    })
    expect(await handleLine('  logout  ', ctx())).toEqual({
      kind: 'session',
      op: 'logout',
    })
  })

  test('anything else becomes argv passthrough', async () => {
    expect(await handleLine('contact list --limit 5', ctx())).toEqual({
      kind: 'exec',
      argv: ['contact', 'list', '--limit', '5'],
    })
  })

  test('tokenize respects double quotes', async () => {
    expect(tokenize('a "b c"')).toEqual(['a', 'b c'])
    expect(await handleLine('contact add "Ada Lovelace"', ctx())).toEqual({
      kind: 'exec',
      argv: ['contact', 'add', 'Ada Lovelace'],
    })
  })
})

describe('cli entry surface', () => {
  test('buildProgram is importable without running the entry branch', () => {
    // An import that parsed argv would have exited this test process already.
    const program = buildProgram()
    expect(program.name()).toBe('crm')
    expect(program.commands.length).toBeGreaterThan(10)
  })
})
