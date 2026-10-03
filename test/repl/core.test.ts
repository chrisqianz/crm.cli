/**
 * The REPL is a presentation layer: every line ends up as argv in the *same*
 * commander program one-shot uses. These tests drive the real binary (spawned
 * from source, hermetic HOME) with CRM_REPL_FORCE=1 — the hidden test seam —
 * so what is asserted is what a human gets: same commands, same output, and a
 * loop that survives a command calling die() → process.exit(1).
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Command } from 'commander'

import { buildProgram } from '../../src/cli'
import type { ReplContext, ReplIo } from '../../src/repl/repl'
import { handleLine, runRepl, statusLine, tokenize } from '../../src/repl/repl'
import {
  bootstrapOwner,
  CRM as CRM_BIN,
  freshDb as entFreshDb,
  startServer,
  type TestServer,
} from '../enterprise/helpers'
import { leaked } from '../helpers'

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
  // A real program: the parser introspects entity subcommands, so a bare
  // `new Command()` would make `contact list` look like `contact <ref>`.
  return { program: buildProgram(), home: '/tmp/crm-unit-home', entryArgv }
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

  test('status reads the separated --db past other entry flags', () => {
    // Pure: the --db branch decides before anything touches session state.
    // `--db=x.db` is deliberately NOT a supported form — the argv pre-parser
    // strips only the separated form, so `crm --db=x.db` never reaches the
    // REPL at all (commander rejects it as an unknown option).
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

test('whoami reaches the command layer', async () => {
  const r = await repl(['whoami', 'q'])
  // Not a session word: it goes through argv, hits the real whoami action,
  // dies "not logged in", and the loop still exits 0 on q.
  expect(r.err + r.out).toContain('Not logged in')
  expect(r.code).toBe(0)
}, 30_000)

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

  test('an unterminated quote is refused, not silently absorbed', async () => {
    // The likeliest REPL typo. Swallowing the quote would run a command the
    // user never typed; refusing the line costs one clear error.
    expect(tokenize('a "b')).toEqual(['a', 'b']) // pure splitter stays dumb
    await expect(handleLine('contact add "Ada', ctx())).rejects.toThrow(
      /unmatched "/,
    )
    await expect(handleLine('contact add "', ctx())).rejects.toThrow(
      /unmatched "/,
    )
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

test('a REPL session leaves no crm/db artifact in HOME', async () => {
  // The zero-footprint walker (test/helpers.ts) from a REPL surface: several
  // commands, one failing line, one session word — and the isolated HOME
  // still holds nothing crm-shaped. This is the pin for "history is
  // in-memory only, no history file, ever": a readline history file would
  // be crm-named and cannot survive this walk.
  const r = await repl(
    [
      'contact add Ada --email ada@x.io',
      'contact show nope',
      'contact list',
      'status',
      'q',
    ],
    ['--db', freshDb()],
  )
  expect(r.code).toBe(0)
  expect(leaked(r.home)).toEqual([])
}, 30_000)

describe('runRepl with injected io', () => {
  test('entry argv decides the status line; a failed line keeps the loop', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const io = {
      input: input as unknown as NodeJS.ReadableStream & { isTTY?: boolean },
      output,
    } satisfies ReplIo
    let text = ''
    output.on('data', (c: Buffer) => {
      text += c.toString()
    })
    // The entry argv arrives as a parameter — process.argv is untouched, so
    // this runs inside the test process without lying about its argv.
    const done = runRepl(new Command(), io, ['--db', 'mine.db'])
    input.write('status\ncontact\nq\n') // bare `contact` errors: no subcommand
    input.end()
    await done
    expect(text).toContain('local:mine.db')
    // initial prompt + one after each handled line — the failure did not
    // end the session early.
    expect((text.match(/crm>/g) ?? []).length).toBeGreaterThanOrEqual(3)
  }, 30_000)
})

describe('REPL at a real terminal (pty)', () => {
  const db = entFreshDb()
  let server: TestServer | null = null

  afterAll(async () => {
    await server?.close()
    db.cleanup()
  })

  test('login prompts own the terminal; the password never becomes a REPL line', async () => {
    // The REPL's readline sits on the same stdin the command layer's prompts
    // attach to. If the loop keeps listening during a command, bytes split
    // between two readers: the login stalls, or worse — the typed password
    // resurfaces as an executed REPL line. Same pty harness as
    // test/enterprise/login-tty.test.ts.
    server = await startServer(db.dbPath)
    const owner = await bootstrapOwner(server)
    let screen = ''
    const decode = new TextDecoder()
    const term = new Bun.Terminal({
      cols: 100,
      rows: 30,
      data: (_t: Bun.Terminal, chunk: Uint8Array) => {
        screen += decode.decode(chunk, { stream: true })
      },
    })
    const home = mkdtempSync(join(tmpdir(), 'crm-repl-pty-'))
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      CRM_CONFIG: '',
      NODE_EXTRA_CA_CERTS: join(homedir(), '.crm', 'certs', 'server.crt'),
    }
    for (const k of ['CRM_DB', 'CRM_SERVER', 'CRM_TOKEN', 'CRM_REPL_FORCE']) {
      delete env[k]
    }
    // No --db: this REPL is the pure remote path — login saves a session and
    // `status` must show it. With --db in the entry argv, status would name
    // the local file instead and the session half of the line goes untested.
    const proc = Bun.spawn(['bun', 'run', CRM_BIN], {
      cwd: join(import.meta.dir, '..', '..'),
      terminal: term,
      env: env as NodeJS.ProcessEnv,
    })
    const settled = async (what: () => boolean, ms: number) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (what()) {
          return true
        }
        await Bun.sleep(100)
      }
      return what()
    }
    try {
      expect(await settled(() => screen.includes('crm>'), 15_000)).toBe(true)
      term.write(
        `login --server 127.0.0.1:${server.port} --username ${owner.username}\n`,
      )
      expect(await settled(() => /password/i.test(screen), 15_000)).toBe(true)
      term.write(`${owner.password}\n`)
      expect(await settled(() => screen.includes('Logged in as'), 20_000)).toBe(
        true,
      )
      term.write('status\n')
      expect(await settled(() => screen.includes('✓'), 15_000)).toBe(true)
      expect(screen).toContain(`@127.0.0.1:${server.port}`)
      // A split-brain stdin shows itself exactly here: the password echoed
      // (promptSecret turns echo off) or echoed back as a failed command.
      expect(screen).not.toContain(owner.password)
      expect(screen.toLowerCase()).not.toContain('unknown command')
      term.write('q\n')
      const exited = await Promise.race([
        proc.exited.then((c) => c),
        Bun.sleep(15_000).then(() => -1),
      ])
      expect(exited).toBe(0)
    } finally {
      try {
        proc.kill(9)
      } catch {
        // already gone
      }
    }
  }, 90_000)
})

describe('REPL grammar (task 2)', () => {
  const dbPath = () => join(mkdtempSync(join(tmpdir(), 'crm-repl-g')), 'g.db')

  test('a unique fuzzy word opens the contact directly', async () => {
    const db = dbPath()
    const r = await repl(
      ['contact add 张三 --email zhang@x.io', '张三', 'q'],
      ['--db', db],
    )
    expect(r.out).toContain('zhang@x.io')
    expect(r.code).toBe(0)
  }, 45_000)

  test('an ambiguous word prints a numbered pick list; a number opens', async () => {
    const db = dbPath()
    const r = await repl(
      [
        'contact add 张三 --email a1@x.io',
        'contact add 张伟 --email a2@x.io',
        '张',
        '1',
        'q',
      ],
      ['--db', db],
    )
    expect(r.out).toMatch(/1\..*张三/)
    expect(r.out).toMatch(/2\..*张伟/)
    expect(r.out).toContain('a1@x.io') // the picked row opened
    expect(r.code).toBe(0)
  }, 45_000)

  test('one-shot command lines still run verbatim (report pipeline)', async () => {
    const db = dbPath()
    const r = await repl(['report pipeline', 'q'], ['--db', db])
    expect(`${r.out}${r.err}`.toLowerCase()).not.toContain('unknown command')
    expect(r.code).toBe(0)
  }, 45_000)

  test('an unknown word falls through to commander and the loop survives', async () => {
    const db = dbPath()
    const r = await repl(
      ['zygote', 'contact add Ben --email b@x.io', 'q'],
      ['--db', db],
    )
    expect(r.err.toLowerCase()).toContain('unknown command')
    expect(r.out).toMatch(/ct_[0-9A-Z]{20,}/) // the next line still ran: add printed its id
    expect(r.code).toBe(0)
  }, 45_000)
})

describe('REPL wizard (task 3)', () => {
  const dbPath = () => join(mkdtempSync(join(tmpdir(), 'crm-repl-w')), 'w.db')

  test('a bare add walks entity, name, and the optional fields', async () => {
    const db = dbPath()
    const r = await repl(
      ['new', 'contact', 'Ada L', 'ada@x.io', '', '', '', '', 'q'],
      ['--db', db],
    )
    expect(r.out).toContain('which entity')
    expect(r.out).toMatch(/ct_[0-9A-Z]{20,}/)
    expect(r.code).toBe(0)
  }, 45_000)

  test('a prefilled name is never asked again', async () => {
    const db = dbPath()
    const r = await repl(
      ['add contact AdaQ', '', '', '', '', 'q'],
      ['--db', db],
    )
    expect(r.out).toMatch(/ct_[0-9A-Z]{20,}/)
    expect(r.code).toBe(0)
  }, 45_000)

  test('log one-liner: body prefilled, Enter takes the default type', async () => {
    const db = dbPath()
    const r = await repl(
      ['log phoned lia about pricing', '', '', 'activity list', 'q'],
      ['--db', db],
    )
    expect(r.out).toContain('phoned lia about pricing')
    expect(r.out).toContain('note')
    expect(r.code).toBe(0)
  }, 45_000)

  test('edit shows the record first and Enter everywhere changes nothing', async () => {
    const db = dbPath()
    const r = await repl(
      [
        'contact add Vera --email v@x.io',
        'edit contact Vera',
        '',
        '',
        '',
        '',
        '',
        'q',
      ],
      ['--db', db],
    )
    expect(r.out).toContain('v@x.io') // the current record printed first
    expect(`${r.out}${r.err}`.toLowerCase()).not.toContain('unknown command')
    expect(r.code).toBe(0)
  }, 45_000)

  test('stdin ending mid-wizard is a clean goodbye, not a crash', async () => {
    const db = dbPath()
    const r = await repl(['new', 'contact', 'Halfway'], ['--db', db])
    expect(r.code).toBe(0)
    expect(`${r.out}${r.err}`).not.toContain('WizardAbort')
    expect(r.err).not.toContain('Unhandled')
  }, 45_000)
})
