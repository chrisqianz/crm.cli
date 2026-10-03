/**
 * The grammar table (spec/client-repl.md §C2, plan Task 2).
 *
 * `parseReplLine` is pure — commander introspection only, no I/O — so every
 * rule is a row here. One deliberate deviation from the plan's sample table:
 * a single unknown token parses to `openWord`, not `exec`; the LOOP falls
 * back to exec passthrough when the fuzzy search finds nothing, so `zygote`
 * still reaches commander's did-you-mean. A pure parser cannot know whether
 * the word matches a row, so the split has to live there.
 */
import { describe, expect, test } from 'bun:test'

import { buildProgram } from '../../src/cli'
import { parseReplLine } from '../../src/repl/parser'
import { tokenize } from '../../src/repl/repl'

const program = buildProgram()
const ctx = { program }
const parse = (line: string) => parseReplLine(tokenize(line), ctx)

test('verb-first: ls contact lists contacts', () => {
  expect(parse('ls contact')).toEqual({
    kind: 'exec',
    argv: ['contact', 'list'],
  })
})

test('entity-first shorthand: a ref opens', () => {
  expect(parse('contact 张三')).toEqual({
    kind: 'open',
    entity: 'contact',
    ref: '张三',
  })
})

test('entity alone lists', () => {
  expect(parse('contact')).toEqual({ kind: 'exec', argv: ['contact', 'list'] })
})

test('bare verb → wizard asks the entity first', () => {
  expect(parse('add')).toEqual({
    kind: 'wizard',
    entity: null,
    verb: 'add',
    given: {},
  })
  expect(parse('new')).toEqual({
    kind: 'wizard',
    entity: null,
    verb: 'add',
    given: {},
  })
})

test('add <entity> with nothing else → wizard with empty given', () => {
  expect(parse('add contact')).toEqual({
    kind: 'wizard',
    entity: 'contact',
    verb: 'add',
    given: {},
  })
})

test('add <entity> <name> prefills the name field', () => {
  expect(parse('add contact 张三')).toEqual({
    kind: 'wizard',
    entity: 'contact',
    verb: 'add',
    given: { name: '张三' },
  })
  expect(parse('add task 跟进合同')).toEqual({
    kind: 'wizard',
    entity: 'task',
    verb: 'add',
    given: { title: '跟进合同' },
  })
})

test('edit <entity> <ref> prefills the ref', () => {
  expect(parse('e deal 42')).toEqual({
    kind: 'wizard',
    entity: 'deal',
    verb: 'edit',
    given: { ref: '42' },
  })
})

test('add/edit WITH flags skip the wizard (power users)', () => {
  expect(parse('contact add Ada --email a@x.io')).toEqual({
    kind: 'exec',
    argv: ['contact', 'add', 'Ada', '--email', 'a@x.io'],
  })
  expect(parse('e deal 42 --value 5000')).toEqual({
    kind: 'exec',
    argv: ['deal', 'edit', '42', '--value', '5000'],
  })
  expect(parse('new contact --name Ada')).toEqual({
    kind: 'exec',
    argv: ['contact', 'add', '--name', 'Ada'],
  })
})

test('entity-first add with flags is untouched', () => {
  // Already commander-shaped; the parser must not reorder it.
  expect(parse('deal add 大单 --value 12')).toEqual({
    kind: 'exec',
    argv: ['deal', 'add', '大单', '--value', '12'],
  })
})

test('verb without an entity passes through (did-you-mean owns it)', () => {
  expect(parse('s 42')).toEqual({ kind: 'exec', argv: ['show', '42'] })
})

test('find searches across entities', () => {
  expect(parse('find 张')).toEqual({ kind: 'exec', argv: ['search', '张'] })
  expect(parse('f 张三 --type contact')).toEqual({
    kind: 'exec',
    argv: ['search', '--type', 'contact', '张三'],
  })
})

test('log with text is a wizard one-liner; bare log starts the wizard', () => {
  expect(parse('log 刚给张三打完电话')).toEqual({
    kind: 'wizard',
    entity: 'log',
    verb: 'add',
    given: { body: '刚给张三打完电话' },
  })
  expect(parse('log')).toEqual({
    kind: 'wizard',
    entity: 'log',
    verb: 'add',
    given: {},
  })
  expect(parse('l 给李四发了报价')).toEqual({
    kind: 'wizard',
    entity: 'log',
    verb: 'add',
    given: { body: '给李四发了报价' },
  })
})

test('macros', () => {
  expect(parse('today')).toEqual({ kind: 'macro', name: 'today' })
  expect(parse('done')).toEqual({ kind: 'macro', name: 'done' })
})

test('session words (with alias me)', () => {
  expect(parse('me')).toEqual({ kind: 'session', op: 'whoami' })
  expect(parse('whoami')).toEqual({ kind: 'session', op: 'whoami' })
  expect(parse('q')).toEqual({ kind: 'session', op: 'quit' })
  expect(parse('?')).toEqual({ kind: 'session', op: 'help' })
  expect(parse('status')).toEqual({ kind: 'session', op: 'status' })
  expect(parse('login')).toEqual({ kind: 'session', op: 'login' })
  expect(parse('logout')).toEqual({ kind: 'session', op: 'logout' })
})

test('session words are bare words only — flags pass through', () => {
  expect(parse('login --server h:1 --username u')).toEqual({
    kind: 'exec',
    argv: ['login', '--server', 'h:1', '--username', 'u'],
  })
})

test('unknown single word → openWord (the loop falls back to exec)', () => {
  expect(parse('zygote')).toEqual({ kind: 'openWord', word: 'zygote' })
  expect(parse('张')).toEqual({ kind: 'openWord', word: '张' })
})

test('multi-token unknown lines pass through verbatim', () => {
  expect(parse('report pipeline')).toEqual({
    kind: 'exec',
    argv: ['report', 'pipeline'],
  })
  expect(parse('dupes --min 3')).toEqual({
    kind: 'exec',
    argv: ['dupes', '--min', '3'],
  })
})

test('entity subcommands and flags stay on the commander path', () => {
  expect(parse('contact add Ada')).toEqual({
    kind: 'exec',
    argv: ['contact', 'add', 'Ada'],
  })
  expect(parse('task done 3')).toEqual({
    kind: 'exec',
    argv: ['task', 'done', '3'],
  })
  expect(parse('deal list --stage open')).toEqual({
    kind: 'exec',
    argv: ['deal', 'list', '--stage', 'open'],
  })
})

test('multi-word refs open as one ref (names have spaces)', () => {
  expect(parse('contact Ada Lovelace')).toEqual({
    kind: 'open',
    entity: 'contact',
    ref: 'Ada Lovelace',
  })
})

test('quotes survive the tokenizer into given (add "one two")', () => {
  expect(parse('add contact "Ada Lovelace"')).toEqual({
    kind: 'wizard',
    entity: 'contact',
    verb: 'add',
    given: { name: 'Ada Lovelace' },
  })
})

test('empty token list asks for nothing', () => {
  expect(parseReplLine([], ctx)).toBeNull()
})

describe('handleLine wiring (parser → REPL)', () => {
  test('a bare word line reaches openWord through handleLine', async () => {
    const { handleLine } = await import('../../src/repl/repl')
    const ctx = {
      entryArgv: [],
      home: '/tmp',
      program: buildProgram(),
    }
    expect(await handleLine('张三', ctx)).toEqual({
      kind: 'openWord',
      word: '张三',
    })
    expect(await handleLine('contact 42', ctx)).toEqual({
      kind: 'open',
      entity: 'contact',
      ref: '42',
    })
  })
})
