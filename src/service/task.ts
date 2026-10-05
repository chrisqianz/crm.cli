/**
 * Task service (P9) — lightweight follow-up to-dos that link to a contact
 * and/or deal so "what do I do about Acme today" is answerable. Pure
 * business logic shared by local and remote mode.
 */

import { eq } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import * as schema from '../db/schema-sqlite'
import { taskToRow } from '../format'
import { ServiceError } from '../lib/errors'
import { confirmOrThrow, makeId, now } from '../lib/helpers'
import { resolveContact, resolveDeal, resolveTask } from '../resolve'

export interface TaskAddParams {
  contact?: string
  deal?: string
  /** Due date (YYYY-MM-DD) or full ISO timestamp. */
  due?: string
  /** Assigned owner (username). */
  owner?: string
  title?: string
}

function parseDue(raw: string | undefined): string | null {
  if (!raw) {
    return null
  }
  const value = raw.trim()
  if (!value) {
    return null
  }
  // date-only → end of that local day (so "today" is not instantly overdue)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    const dt = new Date(y, m - 1, d, 23, 59, 59, 999)
    if (Number.isNaN(dt.getTime())) {
      throw new ServiceError('INVALID', `Error: invalid due date "${value}"`)
    }
    return dt.toISOString()
  }
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) {
    throw new ServiceError('INVALID', `Error: invalid due date "${value}"`)
  }
  return dt.toISOString()
}

function localDate(iso: string): string {
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) {
    return ''
  }
  // en-CA renders YYYY-MM-DD in the runtime's local time zone
  return dt.toLocaleDateString('en-CA')
}

export async function taskAdd(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const opts = p as TaskAddParams
  opts.title = (opts.title ?? '').trim()
  if (!opts.title) {
    throw new ServiceError('INVALID', 'Error: task title is required')
  }
  const due = parseDue(opts.due)
  const owner = opts.owner?.trim() || null
  let contactId: string | null = null
  if (opts.contact) {
    const ct = await resolveContact(db, opts.contact, config)
    if (!ct) {
      throw new ServiceError(
        'NOT_FOUND',
        `Error: contact not found: ${opts.contact}`,
      )
    }
    contactId = ct.id
  }
  let dealId: string | null = null
  if (opts.deal) {
    const dl = await resolveDeal(db, opts.deal)
    if (!dl) {
      throw new ServiceError('NOT_FOUND', `Error: deal not found: ${opts.deal}`)
    }
    dealId = dl.id
  }
  const id = makeId('tk')
  const n = now()
  const actor = p.actor as string | undefined
  await db.insert(schema.tasks).values({
    id,
    title: opts.title,
    due_at: due,
    status: 'open',
    owner,
    contact: contactId,
    deal: dealId,
    created_at: n,
    updated_at: n,
    ...(actor ? { updated_by: actor } : {}),
  })
  return { id }
}

export interface TaskListParams {
  contact?: string
  /** Due today (open tasks). Mirrors the `--due-today` flag. */
  dueToday?: boolean
  limit?: string
  /** Filter to the caller's own records (remote mode). */
  mine?: boolean
  offset?: string
  /** Past their due date (open tasks). */
  overdue?: boolean
  /** Filter by assigned owner (username, case-insensitive). */
  owner?: string
  /** Only open (default) or only done. */
  status?: string
}

export async function taskList(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as TaskListParams
  let rows = (await db.select().from(schema.tasks)).map((t) => taskToRow(t))
  const status = (opts.status ?? '').trim().toLowerCase()
  if (status === 'done' || status === 'open') {
    rows = rows.filter((r) => r.status === status)
  } else if (!(opts.dueToday || opts.overdue)) {
    // default: open tasks only (done are explicit via --status done)
    rows = rows.filter((r) => r.status === 'open')
  }
  const owner = (opts.owner ?? '').trim().toLowerCase()
  const caller = (p.caller as string | undefined)?.toLowerCase()
  const mineOwner = opts.mine ? caller : undefined
  if (owner) {
    rows = rows.filter(
      (r) => (r.owner as string | null)?.toLowerCase() === owner,
    )
  } else if (mineOwner) {
    rows = rows.filter(
      (r) => (r.owner as string | null)?.toLowerCase() === mineOwner,
    )
  }
  if (opts.contact) {
    const ct = await resolveContact(db, opts.contact, config)
    if (ct) {
      rows = rows.filter((r) => r.contact === ct.id)
    } else {
      rows = []
    }
  }
  const todayStr = localDate(now())
  if (opts.dueToday) {
    rows = rows.filter(
      (r) =>
        r.status === 'open' &&
        typeof r.due_at === 'string' &&
        localDate(r.due_at) === todayStr,
    )
  }
  if (opts.overdue) {
    const nowIso = now()
    rows = rows.filter(
      (r) =>
        r.status === 'open' &&
        typeof r.due_at === 'string' &&
        r.due_at < nowIso,
    )
  }
  // due first (nulls last), then created
  rows.sort((a, b) => {
    const ad = typeof a.due_at === 'string' ? a.due_at : ''
    const bd = typeof b.due_at === 'string' ? b.due_at : ''
    if (ad === bd) {
      return 0
    }
    if (ad === '') {
      return 1 // no due date sorts last
    }
    if (bd === '') {
      return -1
    }
    return ad.localeCompare(bd)
  })
  if (opts.offset) {
    rows = rows.slice(Number(opts.offset))
  }
  if (opts.limit) {
    rows = rows.slice(0, Number(opts.limit))
  }
  return { rows }
}

export async function taskDone(
  db: DB,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string; status: string }> {
  const ref = (p.ref as string) ?? ''
  const t = await resolveTask(db, ref.trim())
  if (!t) {
    throw new ServiceError('NOT_FOUND', `Error: task not found: ${ref}`)
  }
  const actor = p.actor as string | undefined
  await db
    .update(schema.tasks)
    .set({
      status: 'done',
      updated_at: now(),
      version: (t.version ?? 1) + 1,
      ...(actor ? { updated_by: actor } : {}),
    })
    .where(eq(schema.tasks.id, t.id))
  return { id: t.id, status: 'done' }
}

export async function taskShow(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ detail: Record<string, unknown> }> {
  const ref = (p.ref as string) ?? ''
  const t = await resolveTask(db, ref.trim())
  if (!t) {
    throw new ServiceError('NOT_FOUND', `Error: task not found: ${ref}`)
  }
  const row = taskToRow(t)
  if (t.contact) {
    const ct = await resolveContact(db, t.contact, config)
    row.contact = ct ? { id: ct.id, name: ct.name } : t.contact
  }
  if (t.deal) {
    const dl = await resolveDeal(db, t.deal)
    row.deal = dl ? { id: dl.id, title: dl.title } : t.deal
  }
  row.version = t.version
  row.updated_by = t.updated_by
  return { detail: row }
}

export async function taskRm(
  db: DB,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const ref = (p.ref as string) ?? ''
  const force = p.force as boolean | undefined
  const t = await resolveTask(db, ref.trim())
  if (!t) {
    throw new ServiceError('NOT_FOUND', `Error: task not found: ${ref}`)
  }
  confirmOrThrow(force, `task "${t.title}" (${t.id})`)
  await db.delete(schema.tasks).where(eq(schema.tasks.id, t.id))
  return { id: t.id }
}
