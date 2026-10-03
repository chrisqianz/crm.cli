/**
 * The REPL intent union.
 *
 * This is the contract between the parser (Task 2), the wizard (Task 3), the
 * fuzzy layer (Task 4) and the macros (Task 5): a line is parsed into one of
 * these, and `repl.ts` is the only thing that turns an intent into argv for
 * commander or into prompts. Task 1 only ever constructs `session` and `exec`
 * members — the union itself is fixed from day one and never redesigned.
 */

import type { Command } from 'commander'

import {
  ALIASES,
  ENTITIES,
  MACROS,
  NAME_FIELD,
  SESSION_WORDS,
  VERB_FIRST,
} from './complete'

export type Intent =
  | {
      kind: 'session'
      op: 'quit' | 'logout' | 'help' | 'status' | 'whoami' | 'login'
    }
  | { kind: 'exec'; argv: string[] } // passthrough incl. flags
  | {
      kind: 'wizard'
      entity: Entity | null
      verb: WizardVerb
      given: Record<string, string | string[]>
    } // Task 3; entity null = bare verb → wizard asks entity first
  | { kind: 'open'; entity: Entity; ref: string } // argv ['<entity>','show',ref]
  | { kind: 'openWord'; word: string } // bare fuzzy word
  | { kind: 'macro'; name: 'today' | 'done' } // Task 5 executes

/** `log` is the activity pseudo-entity: wizard-able, but not a data entity. */
export type Entity = 'contact' | 'company' | 'deal' | 'task' | 'log'
export type WizardVerb = 'add' | 'edit'

/**
 * The slice of the union the current grammar actually produces. Task 1 built
 * `session` and `exec` only; Task 2's parser produces every kind except the
 * ones the loop executes internally, so this alias stays for consumers that
 * only route the plain-commander outcomes.
 */
export type ParsedIntent = Extract<Intent, { kind: 'session' | 'exec' }>

/** Commander introspection only — enough to know which words an entity
 * command already owns (`contact list` stays, `contact 张三` opens). */
export interface ParseCtx {
  program: Command
}

function asEntity(word: string | undefined): Entity | null {
  return word && (ENTITIES as string[]).includes(word) ? (word as Entity) : null
}

function isFlag(token: string): boolean {
  return token.startsWith('-')
}

/** `--k v` pairs and repeated `--k` collapse into the wizard's `given`;
 * valueless flags become 'true' — the wizard treats a set flag as answered. */
function flagsToGiven(tokens: string[]): Record<string, string | string[]> {
  const given: Record<string, string | string[]> = {}
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!isFlag(token)) {
      continue
    }
    const key = token.replace(/^-+/, '')
    const next = tokens[i + 1]
    if (next !== undefined && !isFlag(next)) {
      const prev = given[key]
      if (prev === undefined) {
        given[key] = next
      } else if (Array.isArray(prev)) {
        given[key] = [...prev, next]
      } else {
        given[key] = [prev, next]
      }
      i++
    } else if (given[key] === undefined) {
      given[key] = 'true'
    }
  }
  return given
}

/**
 * The grammar (spec/client-repl.md §C2). Pure: tokens in, intent out — no
 * session reads, no db, no clock. First match wins:
 *
 *   session words → macros → verb-first (add/edit may become a wizard) →
 *   entity-first (`contact 42` opens, `contact` lists, commander-shaped
 *   lines stay) → find → openWord → exec passthrough.
 *
 * Aliases normalize the head token before every rule, so `ls`/`list` take
 * exactly one path. A single word nothing recognised becomes an openWord:
 * only the loop can tell `张` (a row) from `zygote` (a typo), so only the
 * loop decides — it falls back to exec passthrough when the fuzzy search
 * finds nothing, and commander's did-you-mean stays the last resort.
 */
export function parseReplLine(tokens: string[], ctx: ParseCtx): Intent | null {
  if (tokens.length === 0) {
    return null
  }
  const [head, ...rest] = tokens
  const word = ALIASES[head] ?? head

  if (rest.length === 0) {
    const op = SESSION_WORDS[word]
    if (op) {
      return { kind: 'session', op }
    }
    const macro = MACROS[word]
    if (macro) {
      return { kind: 'macro', name: macro }
    }
  }

  if ((VERB_FIRST as string[]).includes(word)) {
    const entity = asEntity(rest[0])
    const wizardVerb: WizardVerb | null =
      word === 'add' || word === 'edit' ? word : null
    if (!wizardVerb) {
      // list/rm/show are commander-shaped verbs, not wizards.
      return entity
        ? { kind: 'exec', argv: [entity, word, ...rest.slice(1)] }
        : { kind: 'exec', argv: [word, ...rest] }
    }
    if (entity) {
      const tail = rest.slice(1)
      if (tail.some(isFlag)) {
        // Power users skip the wizard; argv is reordered to commander shape.
        return { kind: 'exec', argv: [entity, word, ...tail] }
      }
      if (tail.length === 0) {
        return { kind: 'wizard', entity, verb: wizardVerb, given: {} }
      }
      if (tail.length === 1) {
        const field = wizardVerb === 'edit' ? 'ref' : NAME_FIELD[entity]
        return {
          kind: 'wizard',
          entity,
          verb: wizardVerb,
          given: { [field]: tail[0] },
        }
      }
      return { kind: 'exec', argv: [entity, word, ...tail] }
    }
    // `add`/`e` alone (or with flags, or with a word that is no entity): the
    // wizard asks the entity first and carries whatever was already given.
    return {
      kind: 'wizard',
      entity: null,
      verb: wizardVerb,
      given: flagsToGiven(rest),
    }
  }

  const entity = asEntity(word)
  if (entity === 'log') {
    // The activity pseudo-entity: one line of prose, the wizard supplies
    // type/subject. `log --help` and friends stay on the commander path.
    if (rest.length === 0) {
      return { kind: 'wizard', entity: 'log', verb: 'add', given: {} }
    }
    if (rest.some(isFlag)) {
      return { kind: 'exec', argv: [word, ...rest] }
    }
    return {
      kind: 'wizard',
      entity: 'log',
      verb: 'add',
      given: { body: rest.join(' ') },
    }
  }
  if (entity) {
    if (rest.length === 0) {
      return { kind: 'exec', argv: [entity, 'list'] }
    }
    const subs = new Set(
      (
        ctx.program.commands.find((c) => c.name() === entity)?.commands ?? []
      ).map((s) => s.name()),
    )
    if (isFlag(rest[0]) || subs.has(rest[0])) {
      return { kind: 'exec', argv: [word, ...rest] }
    }
    // Multi-word refs stay one ref — names have spaces.
    return { kind: 'open', entity, ref: rest.join(' ') }
  }

  if (word === 'find') {
    // The human word for a cross-entity lookup is the full-text `search`;
    // the semantic `crm find` stays on the one-shot machine surface.
    // Flag+value pairs stay together ahead of the query (same convention as
    // flagValue/cleanArgv: a flag's value is the next non-flag token).
    const flags: string[] = []
    const words: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]
      if (isFlag(token)) {
        flags.push(token)
        const next = rest[i + 1]
        if (next !== undefined && !isFlag(next)) {
          flags.push(next)
          i++
        }
      } else {
        words.push(token)
      }
    }
    return {
      kind: 'exec',
      argv: words.length
        ? ['search', ...flags, words.join(' ')]
        : ['search', ...flags],
    }
  }

  if (tokens.length === 1) {
    return { kind: 'openWord', word: head }
  }

  return { kind: 'exec', argv: [word, ...rest] }
}
