/**
 * Activity service — pure business logic shared by local and remote mode.
 */

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { activityToRow } from '../format'
import { runHook } from '../hooks'
import { ServiceError } from '../lib/errors'
import {
  getOrCreateCompanyId,
  getOrCreateContactId,
  makeId,
  now,
  parseKV,
} from '../lib/helpers'
import { resolveCompany, resolveContact, resolveDeal } from '../resolve'

// P9: the accepted activity types come from config (`[activity] types`)
// so a team can capture its real cadence (wechat, visit, entertainment,
// dingtalk, ...) without patching the binary. The defaults below are the
// classic four; `activityTypes(config)` is the single source of truth for
// both validation and the CLI help text.
export const DEFAULT_ACTIVITY_TYPES = ['note', 'call', 'meeting', 'email']

export function activityTypes(config: CRMConfig): string[] {
  const list = (config.activity?.types ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
  return list.length > 0 ? list : DEFAULT_ACTIVITY_TYPES
}

export interface LogParams {
  at?: string
  body?: string
  company?: string
  contact?: string[]
  deal?: string
  set?: string[]
  type?: string
}

export async function activityLog(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<Record<string, never>> {
  const opts = p as LogParams
  const type = (opts.type ?? '').trim()
  const body = (opts.body ?? '').trim()
  opts.contact = (opts.contact ?? []).map((c) => c.trim())
  if (opts.company) {
    opts.company = opts.company.trim()
  }
  if (opts.deal) {
    opts.deal = opts.deal.trim()
  }
  const types = activityTypes(config)
  if (!types.includes(type)) {
    throw new ServiceError(
      'INVALID',
      `Error: invalid activity type "${type}". Must be one of: ${types.join(', ')}`,
    )
  }

  const contacts: string[] = []
  let company: string | null = null
  let deal: string | null = null

  for (const cRef of opts.contact ?? []) {
    const ctId = await getOrCreateContactId(db, cRef, config)
    if (!contacts.includes(ctId)) {
      contacts.push(ctId)
    }
  }

  if (opts.company) {
    company = await getOrCreateCompanyId(db, opts.company)
  }

  if (opts.deal) {
    const d = await resolveDeal(db, opts.deal)
    if (!d) {
      throw new ServiceError('NOT_FOUND', `Error: deal not found: ${opts.deal}`)
    }
    deal = d.id
  }

  if (opts.at) {
    opts.at = opts.at.trim()
    const d = new Date(opts.at)
    if (Number.isNaN(d.getTime())) {
      throw new ServiceError('INVALID', 'Error: invalid --at date')
    }
  }
  const id = makeId('ac')
  const ts = opts.at || now()
  const custom = parseKV(opts.set ?? [])

  if (
    !runHook(config, 'pre-activity-add', {
      type,
      body,
      contacts,
      company,
      deal,
      custom_fields: custom,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-activity-add hook rejected creation',
    )
  }
  await db.insert(schema.activities).values({
    id,
    type,
    body,
    contacts: JSON.stringify(contacts),
    company,
    deal,
    custom_fields: JSON.stringify(custom),
    created_at: ts,
  })
  await upsertSearchIndex(db, 'activity', id, `${type} ${body}`)
  runHook(config, 'post-activity-add', {
    id,
    type,
    body,
    contacts,
    company,
    deal,
    custom_fields: custom,
  })
  return {}
}

export interface ActivityListParams {
  company?: string
  contact?: string
  deal?: string
  limit?: string
  offset?: string
  reverse?: boolean
  since?: string
  sort?: string
  type?: string
}

export async function activityList(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as ActivityListParams
  const contact = opts.contact
  const company = opts.company
  const deal = opts.deal
  const type = opts.type
  let rows = (await db.select().from(schema.activities)).map((a) =>
    activityToRow(a),
  )
  if (contact) {
    const ct = await resolveContact(db, contact, config)
    if (ct) {
      rows = rows.filter((a) => (a.contacts as string[]).includes(ct.id))
    } else {
      rows = []
    }
  }
  if (company) {
    const co = await resolveCompany(db, company, config)
    if (co) {
      rows = rows.filter((a) => a.company === co.id)
    } else {
      rows = []
    }
  }
  if (deal) {
    rows = rows.filter((a) => a.deal === deal)
  }
  if (type) {
    rows = rows.filter((a) => a.type === type)
  }
  const since = opts.since
  const sort = opts.sort
  const offset = opts.offset
  const limit = opts.limit
  if (since) {
    rows = rows.filter((a) => (a.created_at as string) >= since)
  }
  if (sort) {
    rows.sort((a, b) =>
      String(a[sort] ?? '').localeCompare(String(b[sort] ?? '')),
    )
  }
  if (opts.reverse) {
    rows.reverse()
  }
  if (offset) {
    rows = rows.slice(Number(offset))
  }
  if (limit) {
    rows = rows.slice(0, Number(limit))
  }
  return { rows }
}
