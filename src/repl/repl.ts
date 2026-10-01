import { homedir } from 'node:os'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

import type { Command } from 'commander'

import { loadSession } from '../lib/session'
import { execGuarded } from './guard'
import type { ParsedIntent } from './parser'

const PROMPT = 'crm> '
const BANNER = 'crm interactive REPL — ? for help, q to quit'
const HISTORY_CAP = 100

/** Everything the loop needs to turn a line into work. */
export interface ReplContext {
  /** Raw entry argv (`crm --db x.db` → `['--db','x.db']`), the local-mode hint. */
  entryArgv: string[]
  home: string
  /** Set after each command line; deliberately unused by the loop itself —
   * Task 5's prompt marker reads it. */
  lastErrored?: boolean
  /** The same commander program one-shot parses — nothing is re-implemented. */
  program: Command
}

export interface ReplIo {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean
    setRawMode?: (on: boolean) => void
  }
  output: NodeJS.WritableStream
}

/** A line the user asked for but that cannot be parsed; one clear error, the
 * session continues. */
export class ReplInputError extends Error {}

/**
 * Split a REPL line into argv, honouring double quotes so a name with a space
 * stays one argument. Quotes are not shell quotes: no escapes, no `$`, no
 * redirection — a REPL line only ever becomes an argv array. The splitter
 * itself stays dumb; `parseLine` is what refuses an unterminated quote.
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

/** Tokens for a line, or a complaint — an open quote would otherwise run a
 * command with an argument the user never finished typing. */
function parseTokens(text: string): string[] {
  if ((text.match(/"/g)?.length ?? 0) % 2 !== 0) {
    throw new ReplInputError('unmatched " — finish the quote or drop it')
  }
  return tokenize(text)
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
  return { kind: 'exec', argv: parseTokens(text) }
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

/** The separated form is the only one that can reach the REPL: the argv
 * pre-parser strips `--db <path>` and nothing else, so `--db=x.db` never
 * empties `cleanArgv` and never opens a session at all. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

/** Commander argv a session word maps to; null means the loop itself handles
 * it. Total over the op union so a Task-2 addition cannot land as a silent
 * no-op here. */
function sessionArgv(
  op: 'quit' | 'logout' | 'help' | 'status' | 'whoami' | 'login',
): string[] | null {
  switch (op) {
    case 'help':
      return ['--help']
    case 'logout':
      return ['logout']
    case 'whoami':
    case 'login':
      // Task 2 routes these here as they enter the grammar; the commands
      // already exist, so forwarding argv is all the loop has to do.
      return [op]
    case 'quit':
    case 'status':
      // The loop's own words: no command to run.
      return null
    default: {
      // Compile-time exhaustiveness: a new op without a case lands here as a
      // type error, not as a silent no-op at runtime.
      const _exhaustive: never = op
      return _exhaustive
    }
  }
}

/**
 * The read-eval-print loop. Each line becomes argv for the shared commander
 * program under the exit guard, so output, colors, RBAC, audit and the
 * zero-footprint rules of one-shot mode are inherited rather than re-done.
 *
 * Readline history is in-memory only — typed refs are business data and
 * `~/.crm` stays a whitelist (spec/client-repl.md §C1). History rides along
 * the readline-recreate handoff below in a plain capped array.
 *
 * Terminal handoff: readline holds stdin in raw mode with its own listeners.
 * Commands that prompt (`crm login` through promptSecret, confirmations)
 * attach their own readers to the same stdin — two owners, split bytes, and a
 * typed password that can resurface as an executed line. So at a real
 * terminal the loop CLOSES readline for the duration of a command and rebuilds
 * it afterwards; a piped run has no prompts to race (the command layer refuses
 * to prompt without a TTY), so there the interface stays open and the line
 * queue keeps buffering input.
 */
export async function runRepl(
  program: Command,
  io?: ReplIo,
  entryArgv: string[] = process.argv.slice(2),
): Promise<void> {
  const input = io?.input ?? process.stdin
  const output = io?.output ?? process.stdout
  // A forced (piped) run is not a terminal: scripted stdin must echo nothing.
  const terminal = input.isTTY === true
  const ctx: ReplContext = { program, home: homedir(), entryArgv }

  const history: string[] = [] // newest first; capped; never a file
  const queue: (string | null)[] = [] // lines typed while a command ran
  let waiter: ((line: string | null) => void) | null = null
  let handingOff = false
  const onLine = (line: string | null) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(line)
    } else {
      queue.push(line)
    }
  }
  const onClose = () => {
    if (handingOff) {
      return // the handoff close is ours, not stdin's end
    }
    onLine(null)
  }
  const makeRl = () => {
    const rl = createInterface({ input, output, terminal, prompt: PROMPT })
    // bun's readline exposes the scrollback as a plain array (newest first);
    // the node typings don't declare it.
    const scrollback = rl as unknown as { history: string[] }
    for (const h of history) {
      scrollback.history.push(h)
    }
    rl.on('line', onLine)
    rl.on('close', onClose)
    return rl
  }
  let rl = makeRl()
  const nextLine = () =>
    new Promise<string | null>((resolve) => {
      const q = queue.shift()
      if (q === undefined) {
        waiter = resolve
      } else {
        resolve(q)
      }
    })

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

  /** Run argv with the terminal handed to the command. */
  async function runHanded(argv: string[]): Promise<void> {
    if (terminal) {
      handingOff = true
      rl.close()
      handingOff = false
      // readline put stdin in raw mode; the command's own prompt layer
      // (line-buffered answers, /dev/tty confirmations) expects cooked.
      input.setRawMode?.(false)
    }
    try {
      const { errored } = await execGuarded(ctx.program, argv)
      // A failing line has already printed its own copy (die() / usage), so
      // `errored` changes nothing here except keeping the session alive;
      // Task 5's prompt marker is its consumer.
      ctx.lastErrored = errored
    } catch (e) {
      // A crash inside a command is a bug, and a bug is not a reason to lose
      // the session — print it the way node would and hand back the prompt.
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e)
      process.stderr.write(`${detail}\n`)
    } finally {
      if (terminal) {
        rl = makeRl()
      }
    }
  }

  say(BANNER)
  showPrompt()
  try {
    for (;;) {
      const line = await nextLine()
      if (line === null) {
        break
      }
      const text = line.trim()
      if (text) {
        history.unshift(text)
        if (history.length > HISTORY_CAP) {
          history.pop()
        }
      }
      let intent: ParsedIntent | null
      try {
        intent = await handleLine(line, ctx)
      } catch (e) {
        if (e instanceof ReplInputError) {
          say(`Error: ${e.message}`)
          showPrompt()
          continue
        }
        throw e
      }
      if (!intent) {
        showPrompt()
        continue
      }
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
          await runHanded(argv)
        }
        showPrompt()
        continue
      }
      await runHanded(intent.argv)
      showPrompt()
    }
  } finally {
    handingOff = true
    rl.close()
    if (terminal) {
      // Never hand a shell back sitting in raw mode.
      input.setRawMode?.(false)
    }
  }
  output.write('\n')
}
