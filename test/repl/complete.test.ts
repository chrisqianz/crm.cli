import { describe, expect, test } from 'bun:test'

import { buildProgram } from '../../src/cli'
import { RefCache } from '../../src/repl/cache'
import {
  completeLine,
  flagsForCommand,
  nextActions,
  type PlaneCtx,
} from '../../src/repl/complete'

const REFS: Record<string, string[]> = {
  contact: ['张三', '张伟', 'ct_abc123', 'ct_def456'],
  company: ['Acme', 'co_x1'],
  deal: [],
  task: [],
  log: [],
}

function ctx(): PlaneCtx {
  return { program: buildProgram(), refs: (e) => REFS[e] ?? [] }
}

function completions(line: string): string[] {
  return completeLine(line, ctx())[0]
}

describe('static plane (token 0)', () => {
  test('offers verbs, aliases, session words, macros and entities', () => {
    const c = completions('')
    expect(c).toContain('list')
    expect(c).toContain('ls')
    expect(c).toContain('login')
    expect(c).toContain('today')
    expect(c).toContain('contact')
    expect(c).not.toContain('--email')
  })
  test('prefix narrows and the common prefix comes back', () => {
    const [words, partial] = completeLine('compl', ctx())
    expect(words).toEqual(['completion'])
    expect(partial).toBe('completion')
    const [, shared] = completeLine('comp', ctx())
    expect(shared).toBe('comp') // company|completion share nothing past comp
  })
  test('a lone word never offers flags', () => {
    expect(completions('t').some((w) => w.startsWith('--'))).toBe(false)
  })
})

describe('plane scoping (the named spec bug)', () => {
  test('a half-typed subcommand is completed inside the entity plane only', () => {
    const c = completions('contact lst')
    expect(c).not.toContain('log')
    expect(c).not.toContain('login')
  })
  test('after an unresolvable subcommand, nothing crosses over', () => {
    expect(completions('contact lst ')).toEqual([])
    expect(completions('contact lst --e')).toEqual([])
  })
})

describe('subcommand plane', () => {
  test('entity then space lists its real verbs', () => {
    const c = completions('contact ')
    expect(c).toContain('add')
    expect(c).toContain('list')
    expect(c).toContain('show')
    expect(c).not.toContain('pipeline')
  })
  test('prefix fuzzy lands on show for sh', () => {
    expect(completions('contact sh')).toContain('show')
  })
  test('top-level command verbs too', () => {
    expect(completions('report pi')).toContain('pipeline')
  })
})

describe('flag plane', () => {
  test('only the resolved subcommand flags after --', () => {
    const c = completions('task list --')
    expect(c).toContain('--due-today')
    expect(c).toContain('--mine')
    expect(c).not.toContain('--email')
    expect(c).not.toContain('--value')
  })
  test('verb-first prefix normalizes before resolving', () => {
    const c = completions('add contact --e')
    expect(c).toContain('--email')
    expect(c).not.toContain('--due')
  })
  test('entity-first add resolves too', () => {
    const c = completions('contact add --')
    expect(c).toContain('--company')
    expect(c).toContain('--name')
  })
  test('flagsForCommand walks the real program', () => {
    const flags = flagsForCommand(buildProgram(), ['contact', 'add'])
    expect(flags).toContain('--name')
  })
})

describe('entity-ref plane', () => {
  test('ref slot after show filters the cached refs', () => {
    expect(completions('contact show 张')).toEqual(['张三', '张伟'])
    expect(completions('contact show 张三')).toEqual(['张三'])
    expect(completions('contact show ct_a')).toEqual(['ct_abc123'])
  })
  test('a fresh ref slot lists everything cached', () => {
    expect(completions('contact show ')).toContain('张伟')
    expect(completions('contact rm ')).toContain('ct_def456')
    expect(completions('e company ')).toContain('Acme')
  })
  test('add never completes refs (its positional is a name, not a ref)', () => {
    expect(completions('contact add 张')).toEqual([])
  })
  test('unknown words in a ref slot stay empty, not verbs', () => {
    expect(completions('contact show zzzq')).toEqual([])
  })
})

describe('flagsForCommand', () => {
  test('an unknown command yields no flags', () => {
    expect(flagsForCommand(buildProgram(), ['zygote', 'x'])).toEqual([])
  })
})

describe('RefCache', () => {
  test('cold get is empty, warm fills with a cap, re-warm is free', async () => {
    const fetched: string[] = []
    const cache = new RefCache((e) => {
      fetched.push(e)
      return Promise.resolve(Array.from({ length: 250 }, (_, i) => `${e}${i}`))
    })
    expect(cache.get('contact')).toEqual([])
    await cache.warm('contact')
    expect(cache.get('contact').length).toBe(200)
    await cache.warm('contact')
    expect(fetched).toEqual(['contact'])
    cache.refresh('contact')
    expect(cache.get('contact')).toEqual([])
  })
  test('a failing fetch is swallowed — offline completion still works', async () => {
    const cache = new RefCache(() => Promise.reject(new Error('offline')))
    await cache.warm('contact')
    expect(cache.get('contact')).toEqual([])
  })
  test('concurrent warms share one in-flight fetch', async () => {
    let calls = 0
    const cache = new RefCache(() => {
      calls += 1
      return Promise.resolve(['a'])
    })
    await Promise.all([cache.warm('contact'), cache.warm('contact')])
    expect(calls).toBe(1)
  })
})

describe('nextActions', () => {
  test('opening a contact hints logging and editing it', () => {
    const tips = nextActions({ kind: 'open', entity: 'contact', ref: 'ct_1' })
    expect(tips.join(' ')).toContain('ct_1')
    expect(tips.join(' ')).toContain('log')
  })
  test('add and list hint the show verb for the touched entity', () => {
    expect(
      nextActions({
        kind: 'exec',
        argv: ['contact', 'add', '--name', 'A'],
      }).join(' '),
    ).toContain('s contact')
    expect(
      nextActions({ kind: 'exec', argv: ['company', 'list'] }).join(' '),
    ).toContain('s company')
  })
  test('wizard, session, macro and unknown words stay quiet', () => {
    expect(
      nextActions({
        kind: 'wizard',
        entity: 'contact',
        verb: 'add',
        given: {},
      }),
    ).toEqual([])
    expect(nextActions({ kind: 'session', op: 'quit' })).toEqual([])
    expect(nextActions({ kind: 'exec', argv: ['zygote'] })).toEqual([])
    expect(nextActions({ kind: 'openWord', word: '张三' })).toEqual([])
  })
})
