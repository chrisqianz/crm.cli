/**
 * Company service — pure business logic shared by local and remote mode.
 */
import { eq } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { removeSearchIndex, upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { applyFilter, parseFilter } from '../filter'
import { companyToRow, safeJSON } from '../format'
import { runHook } from '../hooks'
import { ServiceError } from '../lib/errors'
import {
  buildCompanySearch,
  checkDupePhone,
  checkDupeWebsite,
  companyDetail,
  confirmOrThrow,
  makeId,
  now,
  parseKV,
} from '../lib/helpers'
import {
  normalizePhone,
  normalizeWebsite,
  tryNormalizePhone,
} from '../normalize'
import { resolveCompany } from '../resolve'

export interface CompanyAddParams {
  name?: string
  phone?: string[]
  set?: string[]
  tag?: string[]
  website?: string[]
}

export async function companyAdd(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const opts = p as CompanyAddParams
  opts.name = (opts.name ?? '').trim()
  opts.website = (opts.website ?? []).map((w) => w.trim())
  opts.phone = (opts.phone ?? []).map((ph) => ph.trim())
  opts.tag = (opts.tag ?? []).map((t) => t.trim())
  const cid = makeId('co')
  const n = now()
  const websites: string[] = []
  for (const w of opts.website ?? []) {
    const norm = normalizeWebsite(w)
    await checkDupeWebsite(db, norm)
    websites.push(norm)
  }
  const phones: string[] = []
  for (const raw of opts.phone ?? []) {
    let norm: string
    try {
      norm = normalizePhone(raw, config.phone.default_country)
    } catch (e: unknown) {
      throw new ServiceError(
        'INVALID',
        `Error: invalid phone — ${(e as Error).message}`,
      )
    }
    await checkDupePhone(db, norm, 'companies')
    phones.push(norm)
  }
  const custom = parseKV(opts.set ?? [])
  if (
    !runHook(config, 'pre-company-add', {
      name: opts.name,
      websites,
      phones,
      tags: opts.tag,
      custom_fields: custom,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-company-add hook rejected creation',
    )
  }
  await db.insert(schema.companies).values({
    id: cid,
    name: opts.name,
    websites: JSON.stringify(websites),
    phones: JSON.stringify(phones),
    tags: JSON.stringify(opts.tag),
    custom_fields: JSON.stringify(custom),
    created_at: n,
    updated_at: n,
  })
  const results = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, cid))
  const row = results[0]
  await upsertSearchIndex(db, 'company', cid, buildCompanySearch(row))
  runHook(config, 'post-company-add', {
    id: cid,
    name: opts.name,
    websites,
    phones,
    tags: opts.tag,
    custom_fields: custom,
  })
  return { id: cid }
}

export interface CompanyListParams {
  filter?: string
  limit?: string
  offset?: string
  reverse?: boolean
  sort?: string
  tag?: string
}

export async function companyList(
  db: DB,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as CompanyListParams
  const tag = opts.tag
  const filter = opts.filter
  const sort = opts.sort
  const offset = opts.offset
  const limit = opts.limit
  let rows = (await db.select().from(schema.companies)).map((c) =>
    companyToRow(c),
  )
  if (filter) {
    const f = parseFilter(filter)
    rows = rows.filter((c) => applyFilter(c, f))
  }
  if (tag) {
    rows = rows.filter((c) => (c.tags as string[] | undefined)?.includes(tag))
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

export async function companyShow(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ detail: Record<string, unknown> }> {
  const ref = (p.ref as string) ?? ''
  const co = await resolveCompany(db, ref, config)
  if (!co) {
    throw new ServiceError('NOT_FOUND', `Error: company not found: ${ref}`)
  }
  return { detail: await companyDetail(db, co, config) }
}

export interface CompanyEditParams {
  addPhone?: string[]
  addTag?: string[]
  addWebsite?: string[]
  name?: string
  rmPhone?: string[]
  rmTag?: string[]
  rmWebsite?: string[]
  set?: string[]
  unset?: string[]
}

export async function companyEdit(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const ref = (p.ref as string) ?? ''
  const opts = p as CompanyEditParams
  if (opts.name) {
    opts.name = opts.name.trim()
  }
  opts.addWebsite = (opts.addWebsite ?? []).map((w) => w.trim())
  opts.rmWebsite = (opts.rmWebsite ?? []).map((w) => w.trim())
  opts.addPhone = (opts.addPhone ?? []).map((ph) => ph.trim())
  opts.rmPhone = (opts.rmPhone ?? []).map((ph) => ph.trim())
  opts.addTag = (opts.addTag ?? []).map((t) => t.trim())
  opts.rmTag = (opts.rmTag ?? []).map((t) => t.trim())
  const co = await resolveCompany(db, ref.trim(), config)
  if (!co) {
    throw new ServiceError('NOT_FOUND', `Error: company not found: ${ref}`)
  }
  let websites: string[] = safeJSON(co.websites)
  let phones: string[] = safeJSON(co.phones)
  let tags: string[] = safeJSON(co.tags)
  const custom: Record<string, unknown> = safeJSON(co.custom_fields)
  let name = co.name
  if (opts.name) {
    name = opts.name
  }
  for (const w of opts.addWebsite ?? []) {
    const norm = normalizeWebsite(w)
    if (!websites.includes(norm)) {
      await checkDupeWebsite(db, norm, co.id)
      websites.push(norm)
    }
  }
  for (const w of opts.rmWebsite ?? []) {
    const norm = normalizeWebsite(w)
    websites = websites.filter((v) => v !== norm)
  }
  for (const raw of opts.addPhone ?? []) {
    let norm: string
    try {
      norm = normalizePhone(raw, config.phone.default_country)
    } catch (e: unknown) {
      throw new ServiceError(
        'INVALID',
        `Error: invalid phone — ${(e as Error).message}`,
      )
    }
    if (!phones.includes(norm)) {
      await checkDupePhone(db, norm, 'companies', co.id)
      phones.push(norm)
    }
  }
  for (const ph of opts.rmPhone ?? []) {
    const norm = tryNormalizePhone(ph, config.phone.default_country)
    phones = norm
      ? phones.filter((v) => v !== norm)
      : phones.filter((v) => v !== ph)
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
    !runHook(config, 'pre-company-edit', {
      id: co.id,
      name,
      websites,
      phones,
      tags,
      custom_fields: custom,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-company-edit hook rejected edit',
    )
  }
  await db
    .update(schema.companies)
    .set({
      name,
      websites: JSON.stringify(websites),
      phones: JSON.stringify(phones),
      tags: JSON.stringify(tags),
      custom_fields: JSON.stringify(custom),
      updated_at: now(),
    })
    .where(eq(schema.companies.id, co.id))
  const results = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, co.id))
  const row = results[0]
  await upsertSearchIndex(db, 'company', co.id, buildCompanySearch(row))
  runHook(config, 'post-company-edit', {
    id: co.id,
    name,
    websites,
    phones,
    tags,
    custom_fields: custom,
  })
  return { id: co.id }
}

export async function companyRm(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<Record<string, never>> {
  const ref = (p.ref as string) ?? ''
  const force = p.force as boolean | undefined
  const co = await resolveCompany(db, ref, config)
  if (!co) {
    throw new ServiceError('NOT_FOUND', `Error: company not found: ${ref}`)
  }
  confirmOrThrow(force, `company "${co.name}" (${co.id})`)
  if (!runHook(config, 'pre-company-rm', { id: co.id, name: co.name })) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-company-rm hook rejected deletion',
    )
  }
  // Unlink from contacts
  const allContacts = await db.select().from(schema.contacts)
  for (const ct of allContacts) {
    const companies: string[] = safeJSON(ct.companies)
    if (companies.includes(co.id)) {
      await db
        .update(schema.contacts)
        .set({
          companies: JSON.stringify(companies.filter((n) => n !== co.id)),
        })
        .where(eq(schema.contacts.id, ct.id))
    }
  }
  // Set deals company to null
  await db
    .update(schema.deals)
    .set({ company: null })
    .where(eq(schema.deals.company, co.id))
  await db.delete(schema.companies).where(eq(schema.companies.id, co.id))
  await removeSearchIndex(db, co.id)
  runHook(config, 'post-company-rm', { id: co.id, name: co.name })
  return {}
}

export async function companyMerge(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const id1 = (p.id1 as string) ?? ''
  const id2 = (p.id2 as string) ?? ''
  const c1 = await resolveCompany(db, id1, config),
    c2 = await resolveCompany(db, id2, config)
  if (!(c1 && c2)) {
    throw new ServiceError(
      'NOT_FOUND',
      'Error: one or both companies not found',
    )
  }
  const mergedWebsites = [
    ...new Set([...safeJSON(c1.websites), ...safeJSON(c2.websites)]),
  ]
  const mergedPhones = [
    ...new Set([...safeJSON(c1.phones), ...safeJSON(c2.phones)]),
  ]
  const mergedTags = [...new Set([...safeJSON(c1.tags), ...safeJSON(c2.tags)])]
  const mergedCustom = {
    ...safeJSON(c2.custom_fields),
    ...safeJSON(c1.custom_fields),
  }
  await db
    .update(schema.companies)
    .set({
      websites: JSON.stringify(mergedWebsites),
      phones: JSON.stringify(mergedPhones),
      tags: JSON.stringify(mergedTags),
      custom_fields: JSON.stringify(mergedCustom),
      updated_at: now(),
    })
    .where(eq(schema.companies.id, c1.id))
  // Relink contacts
  const allContacts = await db.select().from(schema.contacts)
  for (const ct of allContacts) {
    const companies: string[] = safeJSON(ct.companies)
    if (companies.includes(c2.id)) {
      const updated = [
        ...new Set(companies.map((n) => (n === c2.id ? c1.id : n))),
      ]
      await db
        .update(schema.contacts)
        .set({ companies: JSON.stringify(updated) })
        .where(eq(schema.contacts.id, ct.id))
    }
  }
  // Relink deals
  await db
    .update(schema.deals)
    .set({ company: c1.id })
    .where(eq(schema.deals.company, c2.id))
  // Transfer activities
  await db
    .update(schema.activities)
    .set({ company: c1.id })
    .where(eq(schema.activities.company, c2.id))
  await db.delete(schema.companies).where(eq(schema.companies.id, c2.id))
  await removeSearchIndex(db, c2.id)
  const results = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, c1.id))
  const row = results[0]
  await upsertSearchIndex(db, 'company', c1.id, buildCompanySearch(row))
  return { id: c1.id }
}

export async function companyResolve(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const ref = (p.ref as string) ?? ''
  const co = await resolveCompany(db, ref, config)
  if (!co) {
    throw new ServiceError('NOT_FOUND', `Error: company not found: ${ref}`)
  }
  return { id: co.id, name: co.name }
}
