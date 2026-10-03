import { loadConfig } from '../config'
import { activityTypes } from '../service/activity'
import type { Entity } from './parser'

export type WizardVerb = 'add' | 'edit'

/** One wizard question. The table in this file is the REPL's ONLY field
 * source of truth (spec §C3): the commands own validation, we own asking. */
export interface FieldSpec {
  /** Asked as `a / b / c`; empty answer falls back to `default` when set. */
  choices?: string[]
  default?: string
  /** Edit verb: an empty answer means "keep what is there" — no flag. */
  editKeepOnEmpty?: boolean
  /** Entity-typed: search live rows and pick; typed text survives when
   * nothing matches (companies auto-create, names fuzzy-resolve). */
  entity?: Entity | Entity[]
  /** Commander flag the answer maps to; `--type`/`--body` mark log's two
   * positionals, which the assembler splices after `log`. */
  flag: string
  label: string
  /** Repeat until a blank answer (collect-style flags). */
  multiple?: boolean
  required?: boolean
  secret?: boolean
}

export interface FieldChoices {
  stages: string[]
  types: string[]
}

function base(entity: Entity, c: FieldChoices): FieldSpec[] {
  switch (entity) {
    case 'contact':
      return [
        { flag: '--name', label: 'name', required: true },
        { flag: '--email', label: 'email', multiple: true },
        { flag: '--phone', label: 'phone', multiple: true },
        {
          flag: '--company',
          label: 'company',
          entity: 'company',
          multiple: true,
        },
        { flag: '--tag', label: 'tag', multiple: true },
      ]
    case 'company':
      return [
        { flag: '--name', label: 'name', required: true },
        { flag: '--website', label: 'website', multiple: true },
        { flag: '--tag', label: 'tag', multiple: true },
      ]
    case 'deal':
      return [
        { flag: '--title', label: 'title', required: true },
        { flag: '--company', label: 'company', entity: 'company' },
        { flag: '--value', label: 'value' },
        {
          flag: '--stage',
          label: 'stage',
          choices: c.stages,
          default: c.stages[0],
        },
      ]
    case 'task':
      return [
        { flag: '--title', label: 'title', required: true },
        { flag: '--due', label: 'due (YYYY-MM-DD)' },
        { flag: '--contact', label: 'contact', entity: 'contact' },
      ]
    case 'log':
      return [
        // Subject is a stretch goal of the human path: one prompt across the
        // three linkable entities; the picked row decides the flag, typed
        // text without a match lands as a contact.
        {
          flag: '--contact',
          label: 'subject',
          entity: ['contact', 'company', 'deal'],
        },
        { flag: '--type', label: 'type', choices: c.types, default: 'note' },
        { flag: '--body', label: 'body', required: true },
      ]
    default:
      return []
  }
}

let cachedDefaults: FieldChoices | null = null
function defaultChoices(): FieldChoices {
  if (!cachedDefaults) {
    const config = loadConfig({})
    cachedDefaults = {
      stages: config.pipeline.stages,
      types: activityTypes(config),
    }
  }
  return cachedDefaults
}

/** The ask-list for one entity+verb. Edit copies keep-on-empty and drop the
 * required mark — there is already a value sitting there. */
export function fieldsFor(
  entity: Entity,
  verb: WizardVerb,
  choices?: FieldChoices,
): FieldSpec[] {
  const specs = base(entity, choices ?? defaultChoices()).map((f) => ({ ...f }))
  if (verb === 'edit') {
    for (const f of specs) {
      f.editKeepOnEmpty = true
      f.required = false
    }
  }
  return specs
}
