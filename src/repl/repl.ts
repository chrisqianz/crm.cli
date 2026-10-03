import { homedir } from 'node:os'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

import type { Command } from 'commander'

import { promptSecret } from '../lib/prompt'
import { loadSession } from '../lib/session'
import { rankCandidates, scoreToken } from '../lib/suggest'
import { dispatch } from '../remote/dispatch'
import { RefCache } from './cache'
import {
  applyBunCompletion,
  completeLine,
  nextActions,
  type PlaneCtx,
} from './complete'
import { callGuarded, execGuarded } from './guard'
import { tokenize } from './lex'
import { type Entity, type Intent, parseReplLine } from './parser'
import { type Ask, type FieldOption, runWizard, WizardAbort } from './wizard'

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
 * stays one argument. The canonical home is lex.ts — the completer and the
 * executor must never disagree about what a token is.
 */

/** Tokens for a line, or a complaint — an open quote would otherwise run a
 * command with an argument the user never finished typing. */
function parseTokens(text: string): string[] {
  if ((text.match(/"/g)?.length ?? 0) % 2 !== 0) {
    throw new ReplInputError('unmatched " — finish the quote or drop it')
  }
  return tokenize(text)
}

/**
 * One line in, one intent out: tokenize (quotes are the only syntax) and
 * hand the tokens to the grammar in parser.ts. Returns null for a line that
 * asks for nothing (a bare Enter); an unterminated quote throws
 * ReplInputError, which the loop prints as one clean error line.
 */
// biome-ignore lint/suspicious/useAwait: the Promise is the loop's contract; the grammar itself is synchronous by design.
export async function handleLine(
  line: string,
  ctx: ReplContext,
): Promise<Intent | null> {
  const text = line.trim()
  if (!text) {
    return null
  }
  return parseReplLine(parseTokens(text), { program: ctx.program })
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

/** Fuzzy-open layer: a row the bare-word lookup can pick from. */
interface OpenHit {
  entity: 'company' | 'contact' | 'deal' | 'task'
  id: string
  label: string
  score: number
}

const OPEN_ENTITIES = ['contact', 'company', 'deal', 'task'] as const

function openWordScore(q: string, t: string): number {
  const s = scoreToken(q, t)
  if (s > 0) {
    return s
  }
  // Containment is what makes CJK refs work (张 ~ 张三): the command scorer's
  // 3-char prefix/edit guards are tuned for ASCII words and score them 0.
  if (t.includes(q)) {
    return 2.5
  }
  return 0
}

/**
 * Rank every openable row against a bare word, local or remote (dispatch
 * decides, exactly like a command would). `error: true` means the data layer
 * already printed its own complaint — no db, no session — so the loop just
 * moves on; there is nothing to add on top of that copy.
 */
async function openWordHits(
  word: string,
): Promise<{ error: boolean; hits: OpenHit[] }> {
  const lists = await callGuarded(async () => {
    const out: Record<string, Record<string, unknown>[]> = {}
    for (const entity of OPEN_ENTITIES) {
      const r = await dispatch<{ rows: Record<string, unknown>[] }>(
        `${entity}.list`,
        { limit: '200' },
      )
      out[entity] = r.rows ?? []
    }
    return out
  })
  if (!(lists.ok && lists.value)) {
    return { error: true, hits: [] }
  }
  const candidates: OpenHit[] = []
  for (const entity of OPEN_ENTITIES) {
    for (const row of lists.value[entity] ?? []) {
      const id = String(row.id ?? '')
      if (!id) {
        continue
      }
      candidates.push({
        entity,
        id,
        label: String(row.name ?? row.title ?? id),
        score: 0,
      })
    }
  }
  const ranked = rankCandidates(
    [word.toLowerCase()],
    candidates,
    (c) => [c.label.toLowerCase(), c.id.toLowerCase()],
    { score: openWordScore, top: 9 },
  )
  return {
    error: false,
    hits: ranked.map((r) => ({ ...r.item, score: r.score })),
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
  // Tab completion reads the live program plus this ref plane — neither is a
  // hand-maintained list, so neither can drift from what the CLI accepts.
  const refCache = new RefCache(async (entity) => {
    if (entity === 'log') {
      return []
    }
    const g = await callGuarded(() =>
      dispatch<{ rows: Record<string, unknown>[] }>(`${entity}.list`, {
        limit: '200',
      }),
    )
    const out: string[] = []
    const rows = g.ok && g.value ? (g.value.rows ?? []) : []
    for (const row of rows) {
      const id = String(row.id ?? '')
      const label = String(row.name ?? row.title ?? '')
      if (label) {
        out.push(label)
      }
      if (id) {
        out.push(id)
      }
    }
    return out
  })
  const planeCtx: PlaneCtx = { program, refs: (entity) => refCache.get(entity) }
  const dim = (text: string) => (terminal ? `\u{1b}[2m${text}\u{1b}[0m` : text)
  const queue: (string | null)[] = [] // lines typed while a command ran
  // An ambiguous fuzzy word: numbered rows waiting for a numeric pick.
  let pending: OpenHit[] | null = null
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
    const rl = createInterface({
      input,
      output,
      terminal,
      prompt: PROMPT,
      completer: (line: string) => {
        const result = completeLine(line, planeCtx)
        // bun calls the completer then ignores the return value (1.3.14) —
        // on bun, the completer is also the renderer. node still gets the
        // classic [candidates, common] contract through the return.
        applyBunCompletion(rl, line, result[0], result[1], PROMPT)
        return result
      },
    })
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

  // Wizard plumbing: questions ride the same readline, entity fields search
  // live rows through dispatch — so the wizard works identically local and
  // remote, and piped sessions script their answers like any other line.
  const optionsCache = new Map<string, FieldOption[]>()
  async function fetchOptions(
    entity: Entity,
    query: string,
  ): Promise<FieldOption[]> {
    const cacheKey = `${entity} ${query.toLowerCase()}`
    const cached = optionsCache.get(cacheKey)
    if (cached) {
      return cached
    }
    const g = await callGuarded(() =>
      dispatch<{ rows: Record<string, unknown>[] }>(`${entity}.list`, {
        limit: '200',
      }),
    )
    let opts: FieldOption[] = []
    if (g.ok && g.value) {
      const linkFlag: Record<Entity, string> = {
        contact: '--contact',
        company: '--company',
        deal: '--deal',
        log: '',
        task: '--task',
      }
      const ranked = rankCandidates(
        [query],
        g.value.rows ?? [],
        (row) => {
          const label = String(row.name ?? row.title ?? '')
          return label ? [label, String(row.id ?? '')] : [String(row.id ?? '')]
        },
        { score: openWordScore, top: 8 },
      )
      opts = ranked
        .filter((c) => c.score > 0)
        .map(({ item: row }) => {
          const id = String(row.id ?? '')
          const label = String(row.name ?? row.title ?? id)
          return {
            display: `${label} (${id.slice(0, 12)})`,
            value: id,
            flag: linkFlag[entity],
          }
        })
    }
    if (optionsCache.size > 64) {
      optionsCache.clear() // blunt, but a long session must not grow unbounded
    }
    optionsCache.set(cacheKey, opts)
    return opts
  }

  const ask: Ask = {
    async line(q) {
      if (terminal) {
        rl.setPrompt(`${q} `)
        rl.prompt()
      } else {
        output.write(`${q} `)
      }
      const a = await nextLine()
      if (terminal) {
        rl.setPrompt(PROMPT)
      }
      return a === null ? null : a.trim()
    },
    async secret(q) {
      // Password-like answers never ride the line queue or history. No
      // secret field exists yet; the plumbing is here for when one does.
      return await promptSecret(q)
    },
    async pick(q, options) {
      say(q)
      for (const [i, o] of options.entries()) {
        say(`  ${i + 1}. ${o}`)
      }
      for (;;) {
        const a = await ask.line('number')
        if (a === null) {
          throw new WizardAbort('input ended during the wizard')
        }
        const n = Number(a)
        if (Number.isInteger(n) && n >= 1 && n <= options.length) {
          return n - 1
        }
        say(`  pick 1-${options.length}`)
      }
    },
  }

  say(BANNER)
  // the two planes a human reaches for first; a failed warm stays silent
  refCache.warmStart().catch(() => undefined)
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
      let intent: Intent | null
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
      // A bare number answers the last ambiguous openWord list, and nothing
      // else: every other line clears the pending pick first.
      if (pending && /^\d+$/.test(text)) {
        const hit = pending[Number(text) - 1]
        if (hit) {
          pending = null
          await runHanded([hit.entity, 'show', hit.id])
          showPrompt()
          continue
        }
        say(
          `no #${text} — pick 1-${pending.length}, or type anything to move on`,
        )
        showPrompt()
        continue
      }
      pending = null
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
      if (intent.kind === 'open') {
        await runHanded([intent.entity, 'show', intent.ref])
        if (!ctx.lastErrored) {
          say(dim(`· next: ${nextActions(intent).join('  ·  ')}`))
        }
        showPrompt()
        continue
      }
      if (intent.kind === 'openWord') {
        const { error, hits } = await openWordHits(intent.word)
        if (error) {
          ctx.lastErrored = true
        } else if (hits.length === 0) {
          // Not a row after all — commander fields it (did-you-mean lives
          // there), which keeps `zygote` a usage error, not a shrug.
          await runHanded([intent.word])
        } else if (hits.length === 1 || hits[0].score > hits[1].score) {
          await runHanded([hits[0].entity, 'show', hits[0].id])
        } else {
          pending = hits
          for (const [i, h] of hits.entries()) {
            say(`  ${i + 1}. ${h.entity} · ${h.label}`)
          }
          say('  number to open, anything else to move on')
        }
        showPrompt()
        continue
      }
      if (intent.kind === 'wizard') {
        let w: { entity: Entity; argv: string[] }
        try {
          w = await runWizard(
            intent.entity,
            intent.verb,
            intent.given,
            ask,
            fetchOptions,
            undefined,
            async (entity, ref) => {
              // Edit starts by showing what is there — "keeps current"
              // needs something visible to keep.
              await runHanded([entity, 'show', ref])
            },
          )
        } catch (e) {
          if (e instanceof WizardAbort) {
            break // stdin ended mid-question: just a normal goodbye
          }
          throw e
        }
        await runHanded(w.argv)
        showPrompt()
        continue
      }
      if (intent.kind === 'macro') {
        // Task 5 executes today/done; meanwhile the commands work.
        say(
          'today/done land in the next drop — meanwhile: task list, report pipeline',
        )
        showPrompt()
        continue
      }
      await runHanded(intent.argv)
      if (!ctx.lastErrored) {
        const tips = nextActions(intent)
        if (tips.length > 0) {
          say(dim(`· next: ${tips.join('  ·  ')}`))
        }
      }
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
