/**
 * Deal service — pure business logic shared by local and remote mode.
 */
import { and, eq, sql } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { removeSearchIndex, upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { applyFilter, parseFilter } from '../filter'
import { dealToRow, safeJSON } from '../format'
import { runHook } from '../hooks'
import { ServiceError } from '../lib/errors'
import {
  buildDealSearch,
  casConflict,
  confirmOrThrow,
  dealDetail,
  getOrCreateCompanyId,
  getOrCreateContactId,
  makeId,
  now,
  parseCasVersion,
  parseKV,
  rowsAffected,
} from '../lib/helpers'
import {
  resolveCompany,
  resolveCompanyForLink,
  resolveContact,
  resolveDeal,
} from '../resolve'

export interface DealAddParams {
  company?: string
  contact?: string[]
  expectedClose?: string
  probability?: string
  set?: string[]
  stage?: string
  tag?: string[]
  title?: string
  value?: string
}

export async function dealAdd(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const opts = p as DealAddParams
  opts.title = (opts.title ?? '').trim()
  opts.contact = (opts.contact ?? []).map((c) => c.trim())
  opts.tag = (opts.tag ?? []).map((t) => t.trim())
  if (opts.company) {
    opts.company = opts.company.trim()
  }
  if (opts.stage) {
    opts.stage = opts.stage.trim()
  }
  const id = makeId('dl')
  const n = now()
  if (opts.value !== undefined && Number(opts.value) < 0) {
    throw new ServiceError('INVALID', 'Error: value must be non-negative')
  }
  if (opts.probability !== undefined) {
    const prob = Number(opts.probability)
    if (prob < 0 || prob > 100) {
      throw new ServiceError(
        'INVALID',
        'Error: probability must be between 0 and 100',
      )
    }
  }
  if (opts.expectedClose) {
    opts.expectedClose = opts.expectedClose.trim()
    const d = new Date(opts.expectedClose)
    if (Number.isNaN(d.getTime())) {
      throw new ServiceError('INVALID', 'Error: invalid expected-close date')
    }
  }
  const stage = opts.stage || config.pipeline.stages[0]
  if (!config.pipeline.stages.includes(stage)) {
    throw new ServiceError('INVALID', `Error: invalid stage "${stage}"`)
  }
  const contactIds: string[] = []
  for (const ref of opts.contact ?? []) {
    const ctId = await getOrCreateContactId(db, ref, config)
    if (!contactIds.includes(ctId)) {
      contactIds.push(ctId)
    }
  }
  let companyId: string | null = null
  if (opts.company) {
    const co = await resolveCompanyForLink(db, opts.company)
    if (co) {
      companyId = co.id
    } else {
      // Auto-create only for plain names (no dots suggesting domain)
      if (opts.company.includes('.')) {
        throw new ServiceError(
          'NOT_FOUND',
          `Error: company not found: ${opts.company}`,
        )
      }
      companyId = await getOrCreateCompanyId(db, opts.company)
    }
  }
  const custom = parseKV(opts.set ?? [])
  const value = opts.value === undefined ? null : Number(opts.value)
  const probability =
    opts.probability === undefined ? null : Number(opts.probability)
  if (
    !runHook(config, 'pre-deal-add', {
      title: opts.title,
      value,
      stage,
      contacts: contactIds,
      company: companyId,
      expected_close: opts.expectedClose || null,
      probability,
      tags: opts.tag,
      custom_fields: custom,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-deal-add hook rejected creation',
    )
  }
  const actor = p.actor as string | undefined
  await db.insert(schema.deals).values({
    id,
    title: opts.title,
    value,
    stage,
    contacts: JSON.stringify(contactIds),
    company: companyId,
    expected_close: opts.expectedClose || null,
    probability,
    tags: JSON.stringify(opts.tag),
    custom_fields: JSON.stringify(custom),
    created_at: n,
    updated_at: n,
    ...(actor ? { updated_by: actor } : {}),
  })
  const results = await db
    .select()
    .from(schema.deals)
    .where(eq(schema.deals.id, id))
  const row = results[0]
  await upsertSearchIndex(db, 'deal', id, buildDealSearch(row))
  runHook(config, 'post-deal-add', {
    id,
    title: opts.title,
    value,
    stage,
    contacts: contactIds,
    company: companyId,
    expected_close: opts.expectedClose || null,
    probability,
    tags: opts.tag,
    custom_fields: custom,
  })
  return { id }
}

export interface DealListParams {
  company?: string
  contact?: string
  filter?: string
  limit?: string
  maxValue?: string
  minValue?: string
  offset?: string
  reverse?: boolean
  sort?: string
  stage?: string
  tag?: string
}

export async function dealList(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as DealListParams
  const stage = opts.stage
  const minValue = opts.minValue
  const maxValue = opts.maxValue
  const contact = opts.contact
  const company = opts.company
  const tag = opts.tag
  const filter = opts.filter
  const sort = opts.sort
  const offset = opts.offset
  const limit = opts.limit
  let rows = (await db.select().from(schema.deals)).map((d) => dealToRow(d))
  if (stage) {
    rows = rows.filter((d) => d.stage === stage)
  }
  if (minValue) {
    rows = rows.filter((d) => ((d.value as number) ?? 0) >= Number(minValue))
  }
  if (maxValue) {
    rows = rows.filter((d) => ((d.value as number) ?? 0) <= Number(maxValue))
  }
  if (contact) {
    const ct = await resolveContact(db, contact, config)
    if (ct) {
      rows = rows.filter((d) =>
        (d.contacts as string[] | undefined)?.includes(ct.id),
      )
    } else {
      rows = []
    }
  }
  if (company) {
    const co = await resolveCompany(db, company, config)
    if (co) {
      rows = rows.filter((d) => d.company === co.id)
    } else {
      rows = []
    }
  }
  if (tag) {
    rows = rows.filter((d) => (d.tags as string[] | undefined)?.includes(tag))
  }
  if (filter) {
    const f = parseFilter(filter)
    rows = rows.filter((d) => applyFilter(d, f))
  }
  if (sort) {
    rows.sort((a, b) => {
      const av = a[sort],
        bv = b[sort]
      if (typeof av === 'number' && typeof bv === 'number') {
        return av - bv
      }
      return String(av ?? '').localeCompare(String(bv ?? ''))
    })
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

export async function dealShow(
  db: DB,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ detail: Record<string, unknown> }> {
  const ref = (p.ref as string) ?? ''
  const d = await resolveDeal(db, ref)
  if (!d) {
    throw new ServiceError('NOT_FOUND', `Error: deal not found: ${ref}`)
  }
  return { detail: await dealDetail(db, d) }
}

export interface DealEditParams {
  addContact?: string[]
  addTag?: string[]
  company?: string
  expectedClose?: string
  probability?: string
  rmContact?: string[]
  rmTag?: string[]
  set?: string[]
  title?: string
  unset?: string[]
  value?: string
}

export async function dealEdit(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const ref = (p.ref as string) ?? ''
  const opts = p as DealEditParams
  if (opts.title) {
    opts.title = opts.title.trim()
  }
  if (opts.company) {
    opts.company = opts.company.trim()
  }
  opts.addContact = (opts.addContact ?? []).map((c) => c.trim())
  opts.rmContact = (opts.rmContact ?? []).map((c) => c.trim())
  opts.addTag = (opts.addTag ?? []).map((t) => t.trim())
  opts.rmTag = (opts.rmTag ?? []).map((t) => t.trim())
  const d = await resolveDeal(db, ref.trim())
  if (!d) {
    throw new ServiceError('NOT_FOUND', `Error: deal not found: ${ref}`)
  }
  const expectedVersion = parseCasVersion(p.version)
  const actor = p.actor as string | undefined
  const title = opts.title ?? d.title
  const value = opts.value === undefined ? d.value : Number(opts.value)
  const expectedClose = opts.expectedClose
    ? opts.expectedClose.trim()
    : d.expected_close
  const probability =
    opts.probability === undefined ? d.probability : Number(opts.probability)
  let companyId = d.company
  if (opts.company) {
    companyId = await getOrCreateCompanyId(db, opts.company)
  }
  let contacts: string[] = safeJSON(d.contacts)
  let tags: string[] = safeJSON(d.tags)
  const custom: Record<string, unknown> = safeJSON(d.custom_fields)
  for (const r of opts.addContact ?? []) {
    const ctId = await getOrCreateContactId(db, r, config)
    if (!contacts.includes(ctId)) {
      contacts.push(ctId)
    }
  }
  for (const r of opts.rmContact ?? []) {
    const ct = await resolveContact(db, r, config)
    if (ct) {
      contacts = contacts.filter((id) => id !== ct.id)
    }
  }
  for (const t of opts.addTag ?? []) {
    if (!tags.includes(t)) {
      tags.push(t)
    }
  }
  for (const t of opts.rmTag ?? []) {
    tags = tags.filter((v) => v !== t)
  }
  const kvs = parseKV(opts.set ?? [])
  for (const [k, v] of Object.entries(kvs)) {
    custom[k] = v
  }
  for (const k of opts.unset ?? []) {
    delete custom[k]
  }
  if (
    !runHook(config, 'pre-deal-edit', {
      id: d.id,
      title,
      value,
      contacts,
      tags,
      custom_fields: custom,
    })
  ) {
    throw new ServiceError('INVALID', 'Error: pre-deal-edit hook rejected edit')
  }
  const res = await db
    .update(schema.deals)
    .set({
      title,
      value,
      company: companyId,
      expected_close: expectedClose,
      probability,
      contacts: JSON.stringify(contacts),
      tags: JSON.stringify(tags),
      custom_fields: JSON.stringify(custom),
      updated_at: now(),
      version: sql`${schema.deals.version} + 1`,
      ...(actor ? { updated_by: actor } : {}),
    })
    .where(
      expectedVersion
        ? and(
            eq(schema.deals.id, d.id),
            eq(schema.deals.version, expectedVersion),
          )
        : eq(schema.deals.id, d.id),
    )
  if (expectedVersion !== undefined && rowsAffected(res) === 0) {
    const cur = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, d.id))
    if (!cur[0]) {
      throw new ServiceError('NOT_FOUND', `Error: deal not found: ${ref}`)
    }
    throw casConflict('deal', expectedVersion, cur[0])
  }
  const results = await db
    .select()
    .from(schema.deals)
    .where(eq(schema.deals.id, d.id))
  const row = results[0]
  await upsertSearchIndex(db, 'deal', d.id, buildDealSearch(row))
  runHook(config, 'post-deal-edit', {
    id: d.id,
    title,
    value,
    contacts,
    tags,
    custom_fields: custom,
  })
  return { id: d.id }
}

export async function dealMove(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const ref = (p.ref as string) ?? ''
  const stage = ((p.stage as string) ?? '').trim()
  const note = p.note ? (p.note as string).trim() : undefined
  const d = await resolveDeal(db, ref)
  if (!d) {
    throw new ServiceError('NOT_FOUND', `Error: deal not found: ${ref}`)
  }
  const expectedVersion = parseCasVersion(p.version)
  const actor = p.actor as string | undefined
  if (!config.pipeline.stages.includes(stage)) {
    throw new ServiceError('INVALID', `Error: invalid stage "${stage}"`)
  }
  if (d.stage === stage) {
    throw new ServiceError(
      'INVALID',
      `Error: deal is already in stage "${stage}"`,
    )
  }
  const oldStage = d.stage
  if (
    !runHook(config, 'pre-deal-stage-change', {
      deal: d.id,
      from: oldStage,
      to: stage,
      note,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-deal-stage-change hook rejected stage move',
    )
  }
  const n = now()
  const res = await db
    .update(schema.deals)
    .set({
      stage,
      updated_at: n,
      version: sql`${schema.deals.version} + 1`,
      ...(actor ? { updated_by: actor } : {}),
    })
    .where(
      expectedVersion
        ? and(
            eq(schema.deals.id, d.id),
            eq(schema.deals.version, expectedVersion),
          )
        : eq(schema.deals.id, d.id),
    )
  if (expectedVersion !== undefined && rowsAffected(res) === 0) {
    const cur = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, d.id))
    if (!cur[0]) {
      throw new ServiceError('NOT_FOUND', `Error: deal not found: ${ref}`)
    }
    throw casConflict('deal', expectedVersion, cur[0])
  }
  let body = `from ${oldStage} to ${stage}`
  if (note) {
    body += ` | ${note}`
  }
  const aid = makeId('ac')
  await db.insert(schema.activities).values({
    id: aid,
    type: 'stage-change',
    body,
    deal: d.id,
    created_at: n,
  })
  await upsertSearchIndex(db, 'activity', aid, `stage-change ${body}`)
  runHook(config, 'post-deal-stage-change', {
    deal: d.id,
    from: oldStage,
    to: stage,
    note,
  })
  return { id: d.id }
}

export async function dealRm(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<Record<string, never>> {
  const ref = (p.ref as string) ?? ''
  const force = p.force as boolean | undefined
  const d = await resolveDeal(db, ref)
  if (!d) {
    throw new ServiceError('NOT_FOUND', `Error: deal not found: ${ref}`)
  }
  confirmOrThrow(force, `deal "${d.title}" (${d.id})`)
  if (
    !runHook(config, 'pre-deal-rm', {
      id: d.id,
      title: d.title,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-deal-rm hook rejected deletion',
    )
  }
  await db.delete(schema.activities).where(eq(schema.activities.deal, d.id))
  await db.delete(schema.deals).where(eq(schema.deals.id, d.id))
  await removeSearchIndex(db, d.id)
  runHook(config, 'post-deal-rm', {
    id: d.id,
    title: d.title,
  })
  return {}
}

export async function dealResolve(
  db: DB,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string; title: string }> {
  const ref = (p.ref as string) ?? ''
  const d = await resolveDeal(db, ref)
  if (!d) {
    throw new ServiceError('NOT_FOUND', `Error: deal not found: ${ref}`)
  }
  return { id: d.id, title: d.title }
}

export async function pipelineSummary(
  db: DB,
  config: CRMConfig,
): Promise<{ rows: Record<string, unknown>[] }> {
  const deals = await db.select().from(schema.deals)
  const summary = config.pipeline.stages.map((stage) => ({
    stage,
    count: deals.filter((d) => d.stage === stage).length,
    value: deals
      .filter((d) => d.stage === stage)
      .reduce((s, d) => s + (d.value || 0), 0),
  }))
  const total = {
    stage: 'Total',
    count: deals.length,
    value: deals.reduce((s, d) => s + (d.value || 0), 0),
  }
  return { rows: [...summary, total] }
}
