/**
 * Static vocabulary tables for the REPL grammar, plus the plane-scoped Tab
 * completion the fuzzy layer needs.
 *
 * The parser (parser.ts) consumes the tables for routing; completeLine turns
 * a half-typed line into readline's [candidates, common] pair. Every plane is
 * resolved from the *real* commander program, so flags and subcommands can
 * never drift from what the commands actually accept — and candidates never
 * cross planes (the `contact lst → crm log` class of junk is scoped away by
 * construction).
 */

import type { Command } from 'commander'

import { rankCandidates } from '../lib/suggest'
import { endsOpen, tokenize } from './lex'
import type { Entity, Intent, WizardVerb } from './parser'

/** Typed shorthand → canonical word. Aliasing happens before every rule. */
export const ALIASES: Record<string, string> = {
  e: 'edit',
  f: 'find',
  l: 'log',
  ls: 'list',
  me: 'whoami',
  new: 'add',
  s: 'show',
}

/** Verbs accepted verb-first (`add contact …`). add/edit may become a wizard;
 * the rest always expand to `<entity> <verb>` argv. */
export const VERBS: WizardVerb[] = ['add', 'edit']
export const PASSTHROUGH_VERBS = ['list', 'rm', 'show']
export const VERB_FIRST = [...VERBS, ...PASSTHROUGH_VERBS]

/** Session words are bare words only; anything with flags goes to commander
 * (`login --server h:1 --username u` is a commander invocation). */
export const SESSION_WORDS: Record<
  string,
  'help' | 'login' | 'logout' | 'quit' | 'status' | 'whoami'
> = {
  '?': 'help',
  commands: 'help',
  exit: 'quit',
  help: 'help',
  login: 'login',
  logout: 'logout',
  q: 'quit',
  quit: 'quit',
  status: 'status',
  whoami: 'whoami',
}

/** One-word reports (Task 5 executes them). */
export const MACROS: Record<string, 'done' | 'today'> = {
  done: 'done',
  today: 'today',
}

/** Entities the grammar knows. `log` is the activity pseudo-entity: it can
 * open a wizard, but it never opens or lists like a data entity. */
export const ENTITIES: Entity[] = ['contact', 'company', 'deal', 'task', 'log']

/** Which field a lone positional prefills in an add wizard (per entity). */
export const NAME_FIELD: Record<Entity, string> = {
  company: 'name',
  contact: 'name',
  deal: 'title',
  log: 'body',
  task: 'title',
}

/** Subcommands whose next positional is a ref worth completing. `add` is
 * deliberately absent: its positional is a brand-new name, not a ref. */
const REF_VERBS = ['show', 'edit', 'rm']

/** What completion may look at: the live program, plus the ref plane. */
export interface PlaneCtx {
  program: Command
  refs: (entity: Entity) => string[]
}

function isEntity(word: string): word is Entity {
  return (ENTITIES as string[]).includes(word)
}

/** Static plane: everything a human may start a line with, deduped. */
function staticWords(program: Command): string[] {
  const words = new Set<string>([
    ...Object.keys(ALIASES),
    ...VERB_FIRST,
    ...Object.keys(SESSION_WORDS),
    ...Object.keys(MACROS),
    ...ENTITIES,
  ])
  for (const cmd of program.commands) {
    words.add(cmd.name())
  }
  return [...words].sort()
}

/** Subcommand names (plus aliases) of the deepest resolvable command. */
function subWords(cmd: Command): string[] {
  const words = new Set<string>()
  for (const sub of cmd.commands) {
    words.add(sub.name())
    for (const alias of sub.aliases()) {
      words.add(alias)
    }
  }
  return [...words].sort()
}

/** Walk the real program through argv-shaped words; last match wins. */
function resolveCommand(program: Command, words: string[]): Command | null {
  let cmd: Command | null = null
  let current: Command = program
  for (const word of words) {
    const next = current.commands.find(
      (c) => c.name() === word || c.aliases().includes(word),
    )
    if (!next) {
      break
    }
    cmd = next
    current = next
  }
  return cmd
}

/** Long flags of the command the prefix resolves to, plus the program-level
 * globals (--db, --json, …) that are legal after any subcommand. */
export function flagsForCommand(program: Command, words: string[]): string[] {
  const cmd = resolveCommand(program, words)
  if (!cmd) {
    return []
  }
  const longs = new Set<string>()
  for (const option of [...program.options, ...cmd.options]) {
    if (option.long) {
      longs.add(option.long)
    }
  }
  return [...longs].sort()
}

/** Canonicalize `s` → `show` and verb-first `add contact` → `contact add`. */
function canonicalize(tokens: string[]): string[] {
  if (tokens.length === 0) {
    return []
  }
  const head = ALIASES[tokens[0]] ?? tokens[0]
  const rest = tokens.slice(1)
  if (isEntity(head)) {
    return [head, ...rest]
  }
  const verb = VERB_FIRST.includes(head) ? head : null
  if (verb && isEntity(rest[0])) {
    return [rest[0], verb, ...rest.slice(1)]
  }
  return [head, ...rest]
}

/** Prefix first, fuzzy second — fuzzy never outranks a real prefix hit, so
 * Tab stays predictable. */
function planeFilter(token: string, words: string[]): string[] {
  if (!token) {
    return words
  }
  const lower = token.toLowerCase()
  const prefixed = words.filter((w) => w.toLowerCase().startsWith(lower))
  if (prefixed.length > 0) {
    return prefixed
  }
  return rankCandidates([lower], words, (w) => [w], {
    score: fuzzy,
    top: 8,
  }).map((ranked) => ranked.item)
}

function fuzzy(query: string, word: string): number {
  // same (queryToken, itemToken) contract as the openWord scorer
  return word.toLowerCase().includes(query.toLowerCase()) ? 1 : 0
}

/** Candidates for the token under the cursor. */
export function completeLine(line: string, ctx: PlaneCtx): [string[], string] {
  const all = tokenize(line)
  const open = endsOpen(line)
  const token = open ? '' : (all.at(-1) ?? '')
  const before = canonicalize(open ? all : all.slice(0, -1))
  const words = planeWords(before, token, ctx)
  const candidates = planeFilter(token, words)
  return [candidates, commonPrefix(candidates, token)]
}

function planeWords(before: string[], token: string, ctx: PlaneCtx): string[] {
  if (before.length === 0) {
    return token.startsWith('--') ? [] : staticWords(ctx.program)
  }
  if (token.startsWith('--')) {
    return flagsForCommand(ctx.program, before)
  }
  const top = resolveCommand(ctx.program, [before[0]])
  if (!top) {
    return []
  }
  if (before.length === 1) {
    // the word after a top command is its subcommand, whatever the grammar
    // also has to say about it
    return top.commands.length > 0 ? subWords(top) : []
  }
  const [entity, verb] = before
  if (isEntity(entity) && verb && REF_VERBS.includes(verb)) {
    return ctx.refs(entity)
  }
  return []
}

interface BunishReadline {
  _refreshLine?: () => void
  cursor?: number
  line?: string
  output?: { write(text: string): void }
}

/**
 * Apply completion to a bun readline instance. bun calls the completer and
 * then drops the result on the floor (1.3.14): the return value only means
 * something to node's readline, so on bun the completer must do its own
 * drawing. Single candidate or a longer common prefix rewrites the line
 * buffer in place; several candidates print the list and redraw the prompt,
 * exactly the behaviour everyone already knows from shells.
 */
export function applyBunCompletion(
  rl: unknown,
  line: string,
  candidates: string[],
  common: string,
  prompt: string,
): boolean {
  const b = rl as BunishReadline
  if (
    candidates.length === 0 ||
    typeof b.line !== 'string' ||
    typeof b._refreshLine !== 'function' ||
    !b.output
  ) {
    return false
  }
  // The completion replaces only the trailing token — same contract shells
  // use, and the reason `contact show 张<TAB>` must not eat "contact show ".
  const token = line.slice(line.lastIndexOf(' ') + 1)
  const head = line.slice(0, line.length - token.length)
  if (candidates.length === 1) {
    b.line = head + candidates[0]
    b.cursor = b.line.length
    b._refreshLine()
    return true
  }
  if (common.length > token.length) {
    b.line = head + common
    b.cursor = b.line.length
    b._refreshLine()
    return true
  }
  b.output.write(`\n${candidates.join('  ')}\n${prompt}${line}`)
  return true
}

/** Longest common prefix, clamped to be no shorter than what was typed. */
function commonPrefix(candidates: string[], token: string): string {
  if (candidates.length === 0) {
    return token
  }
  let prefix = candidates[0]
  for (const word of candidates.slice(1)) {
    let i = 0
    while (
      i < prefix.length &&
      i < word.length &&
      prefix[i].toLowerCase() === word[i].toLowerCase()
    ) {
      i += 1
    }
    prefix = prefix.slice(0, i)
  }
  return token.length > prefix.length ? token : prefix
}

/** One dim line after a successful command: what a human does next.
 * Deliberately quiet — wizards, macros and anything unrecognized stay out. */
export function nextActions(intent: Intent): string[] {
  if (intent.kind === 'open') {
    return [`log ${intent.ref} …`, `e ${intent.entity} ${intent.ref}`]
  }
  if (intent.kind === 'exec') {
    const [head, verb] = intent.argv
    const canonical = ALIASES[head] ?? head
    if (isEntity(canonical) && (verb === 'add' || verb === 'list')) {
      return [
        verb === 'add'
          ? `s ${canonical} <the id above>`
          : `s ${canonical} <a word from the list>`,
      ]
    }
  }
  return []
}
