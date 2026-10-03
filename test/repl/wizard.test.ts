import { describe, expect, test } from 'bun:test'

import { fieldsFor } from '../../src/repl/fields.ts'
import type { Entity } from '../../src/repl/parser.ts'
import {
  type Ask,
  type FieldOption,
  runWizard,
  WizardAbort,
} from '../../src/repl/wizard.ts'

// A scripted Ask: `lines` feeds line()/pick()'s number prompt, `picks` feeds
// pick() answers after its list is shown. `null` means stdin ran out.
function fakeAsk(lines: (string | null)[], picks: number[] = []) {
  const prompts: string[] = []
  const ask: Ask = {
    line(q) {
      prompts.push(q)
      const next = lines.shift()
      return Promise.resolve(next === undefined ? null : next)
    },
    async secret(q) {
      return (await ask.line(q)) ?? ''
    },
    pick(q, options) {
      prompts.push(`${q} ${options.join('|')}`)
      const next = picks.shift()
      if (next === undefined) {
        throw new Error('script out of picks')
      }
      return Promise.resolve(next)
    },
  }
  return { ask, prompts }
}

const CHOICES = { stages: ['lead', 'won'], types: ['note', 'call'] }
const NO_FETCH = async () => [] as FieldOption[]

function fetcher(table: Record<string, FieldOption[]>) {
  return (e: Entity, q: string): Promise<FieldOption[]> =>
    Promise.resolve(table[`${e}:${q}`] ?? [])
}

describe('fields table', () => {
  test('contact add asks name first and keeps schema order', () => {
    const specs = fieldsFor('contact', 'add', CHOICES)
    expect(specs.map((f) => f.flag)).toEqual([
      '--name',
      '--email',
      '--phone',
      '--company',
      '--tag',
    ])
    expect(specs[0].required).toBe(true)
    expect(specs[1].multiple).toBe(true)
    expect(specs[3].entity).toBe('company')
  })
  test('log is type + body with an optional cross-entity subject', () => {
    const specs = fieldsFor('log', 'add', CHOICES)
    expect(specs.map((f) => f.flag)).toEqual(['--contact', '--type', '--body'])
    expect(specs[0].entity).toEqual(['contact', 'company', 'deal'])
    expect(specs[1].choices).toEqual(['note', 'call'])
    expect(specs[1].default).toBe('note')
    expect(specs[2].required).toBe(true)
  })
  test('edit specs keep answers on empty', () => {
    const specs = fieldsFor('company', 'edit', CHOICES)
    expect(specs.every((f) => f.editKeepOnEmpty)).toBe(true)
  })
  test('deal stage takes the configured pipeline', () => {
    const specs = fieldsFor('deal', 'add', CHOICES)
    const stage = specs.find((f) => f.flag === '--stage')
    expect(stage?.choices).toEqual(['lead', 'won'])
  })
})

describe('runWizard', () => {
  test('add contact walks the schema order into argv', async () => {
    const { ask, prompts } = fakeAsk([
      'Ada', // name
      'a@x.io', // email (multiple)
      '', // email list done
      '', // phone
      '', // company
      '', // tag (first Enter ends it)
    ])
    const r = await runWizard('contact', 'add', {}, ask, NO_FETCH, CHOICES)
    expect(r.argv).toEqual([
      'contact',
      'add',
      '--name',
      'Ada',
      '--email',
      'a@x.io',
    ])
    expect(prompts.length).toBe(6)
  })

  test('a required field re-asks on empty', async () => {
    const { ask } = fakeAsk(['', 'Bob', '', '', '', '', ''])
    const r = await runWizard('contact', 'add', {}, ask, NO_FETCH, CHOICES)
    expect(r.argv).toEqual(['contact', 'add', '--name', 'Bob'])
  })

  test('given answers are never asked again', async () => {
    const { ask, prompts } = fakeAsk(['', '', '', ''])
    const r = await runWizard(
      'contact',
      'add',
      { name: 'Zed' },
      ask,
      NO_FETCH,
      CHOICES,
    )
    expect(r.argv).toEqual(['contact', 'add', '--name', 'Zed'])
    expect(prompts.some((p) => p.toLowerCase().includes('name'))).toBe(false)
  })

  test('edit with Enter everywhere issues zero no-op flags', async () => {
    const { ask } = fakeAsk(['', '', '', '', '', ''])
    const r = await runWizard(
      'contact',
      'edit',
      { ref: 'ct_1' },
      ask,
      NO_FETCH,
      CHOICES,
    )
    expect(r.argv).toEqual(['contact', 'edit', 'ct_1'])
  })

  test('edit records only the field that changed', async () => {
    const { ask } = fakeAsk(['', 'new@x.io', '', '', '', '', '', ''])
    const r = await runWizard(
      'contact',
      'edit',
      { ref: 'ct_1' },
      ask,
      NO_FETCH,
      CHOICES,
    )
    expect(r.argv).toEqual(['contact', 'edit', 'ct_1', '--email', 'new@x.io'])
  })

  test('an entity field picks from live rows and passes the id', async () => {
    const { ask } = fakeAsk(
      ['A', '', '', 'Acme', '', ''], // name, email, phone, company text, tag
      [0], // pick "Acme (co_1234)"
    )
    const r = await runWizard(
      'contact',
      'add',
      {},
      ask,
      fetcher({
        'company:Acme': [
          { display: 'Acme (co_1234)', value: 'co_1234', flag: '--company' },
        ],
      }),
      CHOICES,
    )
    expect(r.argv).toEqual([
      'contact',
      'add',
      '--name',
      'A',
      '--company',
      'co_1234',
    ])
  })

  test('an entity field with no live match keeps the typed text', async () => {
    const { ask } = fakeAsk(['A', '', '', 'Newco', '', ''])
    const r = await runWizard('contact', 'add', {}, ask, NO_FETCH, CHOICES)
    expect(r.argv).toEqual([
      'contact',
      'add',
      '--name',
      'A',
      '--company',
      'Newco',
    ])
  })

  test('log: empty type falls back to note, body lands positionally', async () => {
    const { ask } = fakeAsk(['', '', 'called li'])
    const r = await runWizard('log', 'add', {}, ask, NO_FETCH, CHOICES)
    expect(r.argv).toEqual(['log', 'note', 'called li'])
  })

  test('log subject pick links the resolved id with its own flag', async () => {
    const { ask } = fakeAsk(['li', 'call', 'talked it over'], [1])
    const r = await runWizard(
      'log',
      'add',
      {},
      ask,
      fetcher({
        'contact:li': [
          { display: '李四 (ct_99)', value: 'ct_99', flag: '--contact' },
          { display: 'li ft Acme (co_7)', value: 'co_7', flag: '--company' },
        ],
      }),
      CHOICES,
    )
    expect(r.argv).toEqual([
      'log',
      'call',
      'talked it over',
      '--company',
      'co_7',
    ])
  })

  test('a bare verb asks which entity first and takes plurals', async () => {
    const { ask } = fakeAsk(['banana', 'contacts', '', '', '', ''])
    // given.name pre-fills, so after the entity resolves only the four
    // optional fields are asked.
    const r = await runWizard(
      null,
      'add',
      { name: 'K' },
      ask,
      NO_FETCH,
      CHOICES,
    )
    expect(r.argv).toEqual(['contact', 'add', '--name', 'K'])
  })

  test('edit without a ref asks which record', async () => {
    const { ask } = fakeAsk(['ct_77', '', '', '', '', '', ''])
    const r = await runWizard('contact', 'edit', {}, ask, NO_FETCH, CHOICES)
    expect(r.argv).toEqual(['contact', 'edit', 'ct_77'])
  })

  test('stdin running out aborts the wizard cleanly', async () => {
    const { ask } = fakeAsk([null])
    await expect(
      runWizard('contact', 'add', {}, ask, NO_FETCH, CHOICES),
    ).rejects.toBeInstanceOf(WizardAbort)
  })

  test('multiple entity field collects until a blank line', async () => {
    const { ask } = fakeAsk(['A', '', '', 'Acme', 'Other', '', ''])
    const r = await runWizard('contact', 'add', {}, ask, NO_FETCH, CHOICES)
    // No live rows at all: both typed names survive verbatim (auto-create
    // and fuzzy-resolve are the command's job, not the wizard's).
    expect(r.argv).toEqual([
      'contact',
      'add',
      '--name',
      'A',
      '--company',
      'Acme',
      '--company',
      'Other',
    ])
  })
})
