import {
  type FieldChoices,
  type FieldSpec,
  fieldsFor,
  type WizardVerb,
} from './fields'
import type { Entity } from './parser'

/** One searchable row for an entity-typed field. `flag` lets a merged
 * search (log's subject) say which flag the row belongs to. */
export interface FieldOption {
  display: string
  flag?: string
  value: string
}

/** Everything the wizard can ask. `line` resolves null ONLY at end of
 * input — that aborts the wizard instead of looping on a dead stdin. */
export interface Ask {
  line(q: string): Promise<string | null>
  /** Numbered list; the implementation re-asks until 1..options.length. */
  pick(q: string, options: string[]): Promise<number>
  secret(q: string): Promise<string>
}

/** Stdin ran out mid-answers. The loop treats it as a clean goodbye. */
export class WizardAbort extends Error {}

export type FetchOptions = (
  entity: Entity,
  query: string,
) => Promise<FieldOption[]>

const ENTITY_WORDS: Record<string, Entity> = {
  activity: 'log',
  company: 'company',
  companies: 'company',
  contact: 'contact',
  contacts: 'contact',
  deal: 'deal',
  deals: 'deal',
  log: 'log',
  task: 'task',
  tasks: 'task',
}

function keyOf(f: FieldSpec): string {
  return f.flag.replace(/^--/, '')
}

async function need(ask: Ask, q: string): Promise<string> {
  const a = await ask.line(q)
  if (a === null) {
    throw new WizardAbort('input ended during the wizard')
  }
  return a
}

/** Ask everything still missing and assemble a one-shot argv.
 * `given` (from the typed line: prefills and flags) is never asked again;
 * edit issues zero no-op flags when the user just walks the list with Enter. */
export async function runWizard(
  entity: Entity | null,
  verb: WizardVerb,
  given: Record<string, string | string[]>,
  ask: Ask,
  fetchOptions: FetchOptions,
  choices?: FieldChoices,
  /** Edit wizard: print the current record before the questions start. */
  preview?: (entity: Entity, ref: string) => Promise<void>,
): Promise<{ entity: Entity; argv: string[] }> {
  let ent = entity
  if (!ent) {
    for (;;) {
      const a = await need(
        ask,
        'which entity? contact / company / deal / task / log',
      )
      const hit = ENTITY_WORDS[a.toLowerCase()]
      if (hit) {
        ent = hit
        break
      }
    }
  }
  const specs = fieldsFor(ent, verb, choices)
  let ref = typeof given.ref === 'string' ? given.ref : undefined
  if (verb === 'edit' && !ref) {
    for (;;) {
      ref = (await need(ask, `which ${ent} to edit? (id or name)`)) || undefined
      if (ref) {
        break
      }
    }
  }
  if (verb === 'edit' && ref && preview) {
    await preview(ent, ref)
  }

  const positional: Record<string, string> = {}
  const flagPairs: string[] = []
  const isPositional = (key: string) =>
    ent === 'log' && (key === 'type' || key === 'body')
  const setVal = (f: FieldSpec, v: string) => {
    const key = keyOf(f)
    if (isPositional(key)) {
      positional[key] = v
    } else {
      flagPairs.push(f.flag, v)
    }
  }

  for (const f of specs) {
    const key = keyOf(f)
    const pre = given[key]
    if (pre !== undefined) {
      if (Array.isArray(pre)) {
        for (const v of pre) {
          setVal(f, v)
        }
      } else {
        setVal(f, String(pre))
      }
      continue
    }

    if (f.entity) {
      const entities: Entity[] = Array.isArray(f.entity) ? f.entity : [f.entity]
      for (;;) {
        let hint = ' (Enter to skip)'
        if (f.editKeepOnEmpty) {
          hint = ' (Enter keeps current)'
        } else if (f.multiple) {
          hint = ' (Enter when done)'
        }
        const text = await need(ask, `${f.label}${hint}`)
        if (!text) {
          break // skip / keep / done — no flag either way
        }
        let opts: FieldOption[] = []
        for (const e of entities) {
          opts = opts.concat(await fetchOptions(e, text))
        }
        if (opts.length === 0) {
          flagPairs.push(f.flag, text)
        } else if (opts.length === 1) {
          flagPairs.push(opts[0].flag ?? f.flag, opts[0].value)
        } else {
          const shown = opts
            .map((o) => o.display)
            .concat([`use "${text}" exactly as typed`])
          const i = await ask.pick(`which ${f.label}?`, shown)
          if (i >= 0 && i < opts.length) {
            flagPairs.push(opts[i].flag ?? f.flag, opts[i].value)
          } else {
            flagPairs.push(f.flag, text)
          }
        }
        if (!f.multiple) {
          break
        }
      }
      continue
    }

    if (f.choices) {
      for (;;) {
        const tail = f.default ? ` — Enter for ${f.default}` : ''
        const a = await need(
          ask,
          `${f.label} (${f.choices.join(' / ')})${tail}`,
        )
        if (!a) {
          // Empty: the command's own default covers a flag, but a log
          // positional must land as something, so it takes the default.
          if (f.default !== undefined && isPositional(key)) {
            setVal(f, f.default)
          }
          break
        }
        if (f.choices.includes(a)) {
          setVal(f, a)
          break
        }
        if (!(f.default || f.required)) {
          setVal(f, a) // free text (custom activity types beyond the list)
          break
        }
      }
      continue
    }

    if (f.secret) {
      const a = await ask.secret(`${f.label}: `)
      if (a) {
        setVal(f, a)
      }
      continue
    }

    if (f.multiple) {
      const keep = f.editKeepOnEmpty
      const first = await need(
        ask,
        `${f.label}${keep ? ' (Enter keeps current)' : ' (one per line, Enter to finish)'}`,
      )
      if (!first) {
        continue // skip, or keep-current
      }
      setVal(f, first)
      for (;;) {
        const more = await need(ask, `${f.label} (Enter when done)`)
        if (!more) {
          break
        }
        setVal(f, more)
      }
      continue
    }

    // plain single answer
    for (;;) {
      let hint = f.required ? '' : ' (Enter to skip)'
      if (f.editKeepOnEmpty) {
        hint = ' (Enter keeps current)'
      }
      const a = await need(ask, `${f.label}${hint}`)
      if (a) {
        setVal(f, a)
        break
      }
      if (f.editKeepOnEmpty || !f.required) {
        break
      }
      // required and empty: ask again — the human might have mis-keyed
    }
  }

  let argv: string[]
  if (ent === 'log') {
    argv = [
      'log',
      positional.type ?? 'note',
      positional.body ?? '',
      ...flagPairs,
    ]
  } else if (verb === 'edit') {
    argv = [ent, 'edit', ref ?? '', ...flagPairs]
  } else {
    argv = [ent, 'add', ...flagPairs]
  }
  return { entity: ent, argv }
}
