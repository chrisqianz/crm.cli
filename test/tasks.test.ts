/**
 * P9 data model: follow-up tasks. `crm task add/list/show/done/rm` with
 * due-date filtering (--due-today / --overdue), ownership (--owner/--mine),
 * and contact/deal links. Title resolution follows the name-ref rules
 * (case-insensitive exact; ambiguity → exit 3).
 */
import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers'

describe('tasks: follow-up to-dos', () => {
  test('add stores title/owner/due; show exposes them', () => {
    const { runOK, runJSON } = createTestContext()
    const id = runOK(
      'task',
      'add',
      'Call Acme re: renewal',
      '--due',
      '2030-01-15',
      '--owner',
      'lin',
    )
    expect(id).toMatch(/^tk_/)
    const detail = runJSON(
      'task',
      'show',
      '--format',
      'json',
      'Call Acme re: renewal',
    )
    expect(detail.title).toBe('Call Acme re: renewal')
    expect(detail.owner).toBe('lin')
    expect(String(detail.due_at)).toContain('2030-01-15')
    expect(detail.status).toBe('open')
  })

  test('links to a contact and deal by ref', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('contact', 'add', 'Acme', '--email', 'acme@x.com')
    runOK('deal', 'add', 'Renewal', '--stage', 'qualified')
    runOK('task', 'add', 'Follow up', '--contact', 'Acme', '--deal', 'Renewal')
    const detail = runJSON('task', 'show', '--format', 'json', 'Follow up')
    expect((detail.contact as Record<string, unknown>).name).toBe('Acme')
    expect((detail.deal as Record<string, unknown>).title).toBe('Renewal')
  })

  test('list defaults to open only; --status done shows done', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('task', 'add', 'A')
    runOK('task', 'add', 'B')
    runOK('task', 'done', 'A')
    const open = runJSON('task', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(open.map((r) => r.title)).toEqual(['B'])
    const done = runJSON(
      'task',
      'list',
      '--status',
      'done',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(done.map((r) => r.title)).toEqual(['A'])
  })

  test('--due-today and --overdue filter open tasks by date', () => {
    const { runOK, runJSON } = createTestContext()
    // today (local)
    const today = new Date()
    const isoToday = today.toISOString().slice(0, 10)
    // yesterday (local)
    const y = new Date()
    y.setDate(y.getDate() - 1)
    const isoYesterday = y.toISOString().slice(0, 10)
    runOK('task', 'add', 'DueToday', '--due', isoToday)
    runOK('task', 'add', 'Overdue', '--due', isoYesterday)
    runOK('task', 'add', 'NoDue')

    const todayRows = runJSON(
      'task',
      'list',
      '--due-today',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(todayRows.map((r) => r.title)).toEqual(['DueToday'])

    const overdueRows = runJSON(
      'task',
      'list',
      '--overdue',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(overdueRows.map((r) => r.title)).toEqual(['Overdue'])

    // a due-today task is not overdue (stored at end-of-day)
    expect(overdueRows.some((r) => r.title === 'DueToday')).toBe(false)
  })

  test('done tasks drop out of --overdue even when past due', () => {
    const { runOK, runJSON } = createTestContext()
    const y = new Date()
    y.setDate(y.getDate() - 2)
    const iso = y.toISOString().slice(0, 10)
    runOK('task', 'add', 'Old', '--due', iso)
    runOK('task', 'done', 'Old')
    const overdue = runJSON(
      'task',
      'list',
      '--overdue',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(overdue.length).toBe(0)
  })

  test('list --owner / --mine filter (local --mine keeps all)', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('task', 'add', 'Mine', '--owner', 'lin')
    runOK('task', 'add', 'Yours', '--owner', 'zhang')
    const byOwner = runJSON(
      'task',
      'list',
      '--owner',
      'lin',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(byOwner.map((r) => r.title)).toEqual(['Mine'])
    // local has no caller → --mine keeps everything
    const mine = runJSON(
      'task',
      'list',
      '--mine',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(mine.length).toBe(2)
  })

  test('rm deletes; show after rm is not found', () => {
    const { runOK, runFail } = createTestContext()
    runOK('task', 'add', 'Gone')
    runOK('task', 'rm', 'Gone', '--force')
    const r = runFail('task', 'show', 'Gone')
    expect(r.stderr).toContain('not found')
  })

  test('ambiguous title → exit 3 conflict with candidates', () => {
    const { runOK, run } = createTestContext()
    runOK('task', 'add', 'Same')
    // a second distinct task; to create two identical titles we use ids
    const b = runOK('task', 'add', 'Same')
    const r = run('task', 'done', 'Same')
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toContain('multiple tasks match')
    expect(r.stderr).toContain(b.slice(0, 5))
  })

  test("list --contact narrows to a contact's tasks", () => {
    const { runOK, runJSON } = createTestContext()
    runOK('contact', 'add', 'Acme', '--email', 'acme@x.com')
    runOK('contact', 'add', 'Globex', '--email', 'globex@x.com')
    runOK('task', 'add', 'ForAcme', '--contact', 'Acme')
    runOK('task', 'add', 'ForGlobex', '--contact', 'Globex')
    const rows = runJSON(
      'task',
      'list',
      '--contact',
      'Acme',
      '--format',
      'json',
    ) as Record<string, unknown>[]
    expect(rows.map((r) => r.title)).toEqual(['ForAcme'])
  })
})
