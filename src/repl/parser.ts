/**
 * The REPL intent union.
 *
 * This is the contract between the parser (Task 2), the wizard (Task 3), the
 * fuzzy layer (Task 4) and the macros (Task 5): a line is parsed into one of
 * these, and `repl.ts` is the only thing that turns an intent into argv for
 * commander or into prompts. Task 1 only ever constructs `session` and `exec`
 * members — the union itself is fixed from day one and never redesigned.
 */

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
 * The slice of the union the current grammar actually produces. Task 1 builds
 * `session` and `exec` only; widening `handleLine`'s return type towards
 * wizard/open/openWord/macro is then a compile error at every loop that has to
 * route the new intent, which is the point of declaring the union up front.
 */
export type ParsedIntent = Extract<Intent, { kind: 'session' | 'exec' }>
