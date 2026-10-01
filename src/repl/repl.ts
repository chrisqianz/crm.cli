import { homedir } from 'node:os'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

import type { Command } from 'commander'

import { loadSession } from '../lib/session'
import { execGuarded } from './guard'
import type { ParsedIntent } from './parser'

const PROMPT = 'crm> '
const BANNER = 'crm interactive REPL — ? for help, q to quit'

/** Everything the loop needs to turn a line into work. */
export interface ReplContext {
  /** Raw entry argv (`crm --db x.db` → `['--db','x.db']`), the local-mode hint. */
  entryArgv: string[]
  home: string
  /** The same commander program one-shot parses — nothing is re-implemented. */
  program: Command
}

export interface ReplIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream
}

/**
 * Split a REPL line into argv, honouring double quotes so a name with a space
 * stays one argument. Quotes are not shell quotes: no escapes, no `$`, no
 * redirection — a REPL line only ever becomes an argv array.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

/**
 * The whole of Task 1's grammar: session words, everything else is argv.
 * Returns null for a line that asks for nothing (a bare Enter).
 *
 * `_ctx` is unused until Task 2's parser, which reads session state and the
 * entity tables out of it — the signature is the contract already.
 */
// biome-ignore lint/suspicious/useAwait: the Promise is Task 2's contract (its parser reads session state); Task 1's grammar is synchronous.
export async function handleLine(
  line: string,
  _ctx: ReplContext,
): Promise<ParsedIntent | null> {
  const text = line.trim()
  if (!text) {
    return null
  }
  if (text === 'q' || text === 'quit' || text === 'exit') {
    return { kind: 'session', op: 'quit' }
  }
  if (text === '?' || text === 'help' || text === 'commands') {
    return { kind: 'session', op: 'help' }
  }
  if (text === 'status') {
    return { kind: 'session', op: 'status' }
  }
  if (text === 'logout') {
    return { kind: 'session', op: 'logout' }
  }
  return { kind: 'exec', argv: tokenize(text) }
}

/** Where this session's data would come from: a local db, a server, or neither. */
export function statusLine(ctx: ReplContext): string {
  const db = flagValue(ctx.entryArgv, '--db')
  if (db) {
    return `local:${basename(db)}`
  }
  const session = loadSession()
  if (session) {
    return session.username
      ? `${session.username}@${session.server} ✓`
      : `${session.server} ✓`
  }
  return 'not logged in'
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i >= 0) {
    return argv[i + 1]
  }
  // `--db=x.db` is the same flag to commander, so it names the same database.
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
}

/** Commander argv a session word maps to; null means the loop handles it. */
function sessionArgv(
  op: 'quit' | 'logout' | 'help' | 'status' | 'whoami' | 'login',
) {
  switch (op) {
    case 'help':
      return ['--help']
    case 'logout':
      return ['logout']
    // Task 2 routes `whoami`/`login` here as they enter the grammar.
    default:
      return null
  }
}

/**
 * The read-eval-print loop. Each line becomes argv for the shared commander
 * program under the exit guard, so output, colors, RBAC, audit and the
 * zero-footprint rules of one-shot mode are inherited rather than re-done.
 *
 * Readline history is in-memory only — typed refs are business data and
 * `~/.crm` stays a whitelist (spec/client-repl.md §C1).
 */
export async function runRepl(program: Command, io?: ReplIo): Promise<void> {
  const input = io?.input ?? process.stdin
  const output = io?.output ?? process.stdout
  // A forced (piped) run is not a terminal: scripted stdin must echo nothing.
  const terminal = input.isTTY === true
  const ctx: ReplContext = {
    program,
    home: homedir(),
    entryArgv: process.argv.slice(2),
  }
  const rl = createInterface({ input, output, terminal })
  rl.setPrompt(PROMPT)
  const say = (text: string) => {
    output.write(`${text}\n`)
  }
  // readline draws the prompt itself in a terminal; in a pipe it draws nothing,
  // so the loop says where it is.
  const showPrompt = () => {
    if (terminal) {
      rl.prompt()
    } else {
      output.write(PROMPT)
    }
  }

  say(BANNER)
  showPrompt()
  try {
    for await (const line of rl) {
      const intent = await handleLine(line, ctx)
      if (intent) {
        if (intent.kind === 'session') {
          if (intent.op === 'quit') {
            break
          }
          if (intent.op === 'status') {
            say(statusLine(ctx))
            showPrompt()
            continue
          }
          const argv = sessionArgv(intent.op)
          if (argv) {
            await runArgv(ctx, argv)
          }
          showPrompt()
          continue
        }
        await runArgv(ctx, intent.argv)
      }
      showPrompt()
    }
  } finally {
    rl.close()
  }
  output.write('\n')
}

/** One line's argv, with a command's failure printed and the loop kept alive. */
async function runArgv(ctx: ReplContext, argv: string[]): Promise<void> {
  try {
    await execGuarded(ctx.program, argv)
  } catch (e) {
    // A crash inside a command is a bug, and a bug is not a reason to lose the
    // session — print it the way node would and hand back the prompt.
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e)
    process.stderr.write(`${detail}\n`)
  }
}
