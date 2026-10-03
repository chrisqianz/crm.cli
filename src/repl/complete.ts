/**
 * Static vocabulary tables for the REPL grammar.
 *
 * The parser (parser.ts) consumes these for routing; Task 4's completion and
 * footer layer will reuse the same lists so what the user can type, what gets
 * suggested, and what renders in the dim hint line never drift apart.
 */

import type { Entity, WizardVerb } from './parser'

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
