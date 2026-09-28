/**
 * Contact service — pure business logic shared by local mode (in-process)
 * and remote mode (executed inside `crm serve` per RPC frame).
 *
 * Functions take (db, config, params) and return plain data; they throw
 * ServiceError on failure. No console output, no process.exit — rendering
 * and transport concerns live in the CLI command layer.
 */
import { and, eq, sql } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { removeSearchIndex, upsertSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { applyFilter, parseFilter } from '../filter'
import { contactToRow, safeJSON } from '../format'
import { runHook } from '../hooks'
import { ServiceError } from '../lib/errors'
import {
  buildContactSearch,
  casConflict,
  checkDupeEmail,
  checkDupePhone,
  checkDupeSocial,
  confirmOrThrow,
  contactDetail,
  getOrCreateCompanyId,
  makeId,
  now,
  parseCasVersion,
  parseKV,
  rowsAffected,
  validateEmail,
} from '../lib/helpers'
import {
  normalizePhone,
  normalizeSocialHandle,
  tryNormalizePhone,
} from '../normalize'
import { resolveCompany, resolveContact } from '../resolve'

export interface ContactAddParams {
  bluesky?: string
  company?: string[]
  email?: string[]
  linkedin?: string
  name?: string
  phone?: string[]
  set?: string[]
  tag?: string[]
  telegram?: string
  x?: string
}

export async function contactAdd(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const opts = p as ContactAddParams
  opts.name = (opts.name ?? '').trim()
  opts.email = (opts.email ?? []).map((e) => e.trim())
  opts.phone = (opts.phone ?? []).map((ph) => ph.trim())
  opts.company = (opts.company ?? []).map((c) => c.trim())
  opts.tag = (opts.tag ?? []).map((t) => t.trim())
  const cid = makeId('ct')
  const n = now()
  for (const e of opts.email ?? []) {
    validateEmail(e)
    await checkDupeEmail(db, e)
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
    await checkDupePhone(db, norm, 'contacts')
    phones.push(norm)
  }
  const linkedin = opts.linkedin
    ? normalizeSocialHandle('linkedin', opts.linkedin.trim())
    : null
  const x = opts.x ? normalizeSocialHandle('x', opts.x.trim()) : null
  const bluesky = opts.bluesky
    ? normalizeSocialHandle('bluesky', opts.bluesky.trim())
    : null
  const telegram = opts.telegram
    ? normalizeSocialHandle('telegram', opts.telegram.trim())
    : null
  if (linkedin) {
    await checkDupeSocial(db, 'linkedin', linkedin)
  }
  if (x) {
    await checkDupeSocial(db, 'x', x)
  }
  if (bluesky) {
    await checkDupeSocial(db, 'bluesky', bluesky)
  }
  if (telegram) {
    await checkDupeSocial(db, 'telegram', telegram)
  }
  const companies: string[] = []
  for (const c of opts.company ?? []) {
    companies.push(await getOrCreateCompanyId(db, c))
  }
  const custom = parseKV(opts.set ?? [])
  if (
    !runHook(config, 'pre-contact-add', {
      name: opts.name,
      emails: opts.email,
      phones,
      companies,
      linkedin,
      x,
      bluesky,
      telegram,
      tags: opts.tag,
      custom_fields: custom,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-contact-add hook rejected creation',
    )
  }
  const actor = p.actor as string | undefined
  await db.insert(schema.contacts).values({
    id: cid,
    name: opts.name,
    emails: JSON.stringify(opts.email),
    phones: JSON.stringify(phones),
    companies: JSON.stringify(companies),
    linkedin,
    x,
    bluesky,
    telegram,
    tags: JSON.stringify(opts.tag),
    custom_fields: JSON.stringify(custom),
    created_at: n,
    updated_at: n,
    ...(actor ? { updated_by: actor } : {}),
  })
  const results = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, cid))
  const row = results[0]
  await upsertSearchIndex(db, 'contact', cid, await buildContactSearch(db, row))
  runHook(config, 'post-contact-add', {
    id: cid,
    name: opts.name,
    emails: opts.email,
    phones,
    companies,
    linkedin,
    x,
    bluesky,
    telegram,
    tags: opts.tag,
    custom_fields: custom,
  })
  return { id: cid }
}

export interface ContactListParams {
  company?: string
  filter?: string
  limit?: string
  offset?: string
  reverse?: boolean
  sort?: string
  tag?: string
}

export async function contactList(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as ContactListParams
  const tag = opts.tag
  const company = opts.company
  const filter = opts.filter
  const sort = opts.sort
  const offset = opts.offset
  const limit = opts.limit
  let rows = (await db.select().from(schema.contacts)).map((c) =>
    contactToRow(c),
  )
  if (tag) {
    rows = rows.filter((c) => (c.tags as string[] | undefined)?.includes(tag))
  }
  if (company) {
    const co = await resolveCompany(db, company, config)
    if (co) {
      rows = rows.filter((c) =>
        (c.companies as string[] | undefined)?.includes(co.id),
      )
    } else {
      rows = []
    }
  }
  if (filter) {
    const f = parseFilter(filter)
    rows = rows.filter((c) => applyFilter(c, f))
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

export async function contactShow(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ detail: Record<string, unknown> }> {
  const ref = (p.ref as string) ?? ''
  const c = await resolveContact(db, ref, config)
  if (!c) {
    throw new ServiceError('NOT_FOUND', `Error: contact not found: ${ref}`)
  }
  return { detail: await contactDetail(db, c, config) }
}

export interface ContactEditParams {
  addCompany?: string[]
  addEmail?: string[]
  addPhone?: string[]
  addTag?: string[]
  bluesky?: string
  linkedin?: string
  name?: string
  rmCompany?: string[]
  rmEmail?: string[]
  rmPhone?: string[]
  rmTag?: string[]
  set?: string[]
  telegram?: string
  unset?: string[]
  x?: string
}

export async function contactEdit(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const ref = (p.ref as string) ?? ''
  const opts = p as ContactEditParams
  if (opts.name) {
    opts.name = opts.name.trim()
  }
  opts.addEmail = (opts.addEmail ?? []).map((e) => e.trim())
  opts.rmEmail = (opts.rmEmail ?? []).map((e) => e.trim())
  opts.addPhone = (opts.addPhone ?? []).map((ph) => ph.trim())
  opts.rmPhone = (opts.rmPhone ?? []).map((ph) => ph.trim())
  opts.addCompany = (opts.addCompany ?? []).map((c) => c.trim())
  opts.rmCompany = (opts.rmCompany ?? []).map((c) => c.trim())
  opts.addTag = (opts.addTag ?? []).map((t) => t.trim())
  opts.rmTag = (opts.rmTag ?? []).map((t) => t.trim())
  const c = await resolveContact(db, ref.trim(), config)
  if (!c) {
    throw new ServiceError('NOT_FOUND', `Error: contact not found: ${ref}`)
  }
  const expectedVersion = parseCasVersion(p.version)
  const actor = p.actor as string | undefined
  let emails: string[] = safeJSON(c.emails)
  let phones: string[] = safeJSON(c.phones)
  let companies: string[] = safeJSON(c.companies)
  let tags: string[] = safeJSON(c.tags)
  const custom: Record<string, unknown> = safeJSON(c.custom_fields)
  let name = c.name,
    linkedin = c.linkedin,
    x = c.x,
    bluesky = c.bluesky,
    telegram = c.telegram
  if (opts.name) {
    name = opts.name
  }
  for (const e of opts.addEmail ?? []) {
    validateEmail(e)
    await checkDupeEmail(db, e, c.id)
    if (!emails.includes(e)) {
      emails.push(e)
    }
  }
  for (const e of opts.rmEmail ?? []) {
    emails = emails.filter((v) => v !== e)
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
      await checkDupePhone(db, norm, 'contacts', c.id)
      phones.push(norm)
    }
  }
  for (const ph of opts.rmPhone ?? []) {
    const norm = tryNormalizePhone(ph, config.phone.default_country)
    phones = norm
      ? phones.filter((v) => v !== norm)
      : phones.filter((v) => v !== ph)
  }
  for (const co of opts.addCompany ?? []) {
    const coId = await getOrCreateCompanyId(db, co)
    if (!companies.includes(coId)) {
      companies.push(coId)
    }
  }
  for (const co of opts.rmCompany ?? []) {
    const resolved = await resolveCompany(db, co, config)
    if (resolved) {
      companies = companies.filter((v) => v !== resolved.id)
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
  if (opts.linkedin) {
    linkedin = normalizeSocialHandle('linkedin', opts.linkedin.trim())
    await checkDupeSocial(db, 'linkedin', linkedin, c.id)
  }
  if (opts.x) {
    x = normalizeSocialHandle('x', opts.x.trim())
    await checkDupeSocial(db, 'x', x, c.id)
  }
  if (opts.bluesky) {
    bluesky = normalizeSocialHandle('bluesky', opts.bluesky.trim())
    await checkDupeSocial(db, 'bluesky', bluesky, c.id)
  }
  if (opts.telegram) {
    telegram = normalizeSocialHandle('telegram', opts.telegram.trim())
    await checkDupeSocial(db, 'telegram', telegram, c.id)
  }
  const kvs = parseKV(opts.set ?? [])
  for (const [k, v] of Object.entries(kvs)) {
    custom[k] = v
  }
  for (const k of opts.unset ?? []) {
    delete custom[k]
    if (k === 'linkedin') {
      linkedin = null
    }
    if (k === 'x') {
      x = null
    }
    if (k === 'bluesky') {
      bluesky = null
    }
    if (k === 'telegram') {
      telegram = null
    }
  }
  if (
    !runHook(config, 'pre-contact-edit', {
      id: c.id,
      name,
      emails,
      phones,
      companies,
      linkedin,
      x,
      bluesky,
      telegram,
      tags,
      custom_fields: custom,
    })
  ) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-contact-edit hook rejected edit',
    )
  }
  const res = await db
    .update(schema.contacts)
    .set({
      name,
      emails: JSON.stringify(emails),
      phones: JSON.stringify(phones),
      companies: JSON.stringify(companies),
      linkedin,
      x,
      bluesky,
      telegram,
      tags: JSON.stringify(tags),
      custom_fields: JSON.stringify(custom),
      updated_at: now(),
      version: sql`${schema.contacts.version} + 1`,
      ...(actor ? { updated_by: actor } : {}),
    })
    .where(
      expectedVersion
        ? and(
            eq(schema.contacts.id, c.id),
            eq(schema.contacts.version, expectedVersion),
          )
        : eq(schema.contacts.id, c.id),
    )
  if (expectedVersion !== undefined && rowsAffected(res) === 0) {
    const cur = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, c.id))
    if (!cur[0]) {
      throw new ServiceError('NOT_FOUND', `Error: contact not found: ${ref}`)
    }
    throw casConflict('contact', expectedVersion, cur[0])
  }
  const results = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, c.id))
  const row = results[0]
  await upsertSearchIndex(
    db,
    'contact',
    c.id,
    await buildContactSearch(db, row),
  )
  runHook(config, 'post-contact-edit', {
    id: c.id,
    name,
    emails,
    phones,
    companies,
    linkedin,
    x,
    bluesky,
    telegram,
    tags,
    custom_fields: custom,
  })
  return { id: c.id }
}

export async function contactRm(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<Record<string, never>> {
  const ref = (p.ref as string) ?? ''
  const force = p.force as boolean | undefined
  const c = await resolveContact(db, ref, config)
  if (!c) {
    throw new ServiceError('NOT_FOUND', `Error: contact not found: ${ref}`)
  }
  confirmOrThrow(force, `contact "${c.name}" (${c.id})`)
  if (!runHook(config, 'pre-contact-rm', { id: c.id, name: c.name })) {
    throw new ServiceError(
      'INVALID',
      'Error: pre-contact-rm hook rejected deletion',
    )
  }
  const actor = p.actor as string | undefined
  const allDeals = await db.select().from(schema.deals)
  for (const d of allDeals) {
    const contacts: string[] = safeJSON(d.contacts)
    if (contacts.includes(c.id)) {
      await db
        .update(schema.deals)
        .set({
          contacts: JSON.stringify(contacts.filter((id) => id !== c.id)),
          version: sql`${schema.deals.version} + 1`,
          ...(actor ? { updated_by: actor } : {}),
        })
        .where(eq(schema.deals.id, d.id))
    }
  }
  await db.delete(schema.contacts).where(eq(schema.contacts.id, c.id))
  await removeSearchIndex(db, c.id)
  runHook(config, 'post-contact-rm', { id: c.id, name: c.name })
  return {}
}

export async function contactMerge(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string }> {
  const id1 = (p.id1 as string) ?? ''
  const id2 = (p.id2 as string) ?? ''
  const c1 = await resolveContact(db, id1, config),
    c2 = await resolveContact(db, id2, config)
  if (!(c1 && c2)) {
    throw new ServiceError('NOT_FOUND', 'Error: one or both contacts not found')
  }
  const mergedEmails = [
    ...new Set([...safeJSON(c1.emails), ...safeJSON(c2.emails)]),
  ]
  const mergedPhones = [
    ...new Set([...safeJSON(c1.phones), ...safeJSON(c2.phones)]),
  ]
  const mergedCompanies = [
    ...new Set([...safeJSON(c1.companies), ...safeJSON(c2.companies)]),
  ]
  const mergedTags = [...new Set([...safeJSON(c1.tags), ...safeJSON(c2.tags)])]
  const mergedCustom = {
    ...safeJSON(c2.custom_fields),
    ...safeJSON(c1.custom_fields),
  }
  const linkedin = c1.linkedin || c2.linkedin
  const x = c1.x || c2.x
  const bluesky = c1.bluesky || c2.bluesky
  const telegram = c1.telegram || c2.telegram
  // Clear loser's social handles to avoid UNIQUE constraint conflicts, then delete loser first
  const actor = p.actor as string | undefined
  await db
    .update(schema.contacts)
    .set({
      linkedin: null,
      x: null,
      bluesky: null,
      telegram: null,
      version: sql`${schema.contacts.version} + 1`,
      ...(actor ? { updated_by: actor } : {}),
    })
    .where(eq(schema.contacts.id, c2.id))
  await db
    .update(schema.contacts)
    .set({
      emails: JSON.stringify(mergedEmails),
      phones: JSON.stringify(mergedPhones),
      companies: JSON.stringify(mergedCompanies),
      tags: JSON.stringify(mergedTags),
      custom_fields: JSON.stringify(mergedCustom),
      linkedin,
      x,
      bluesky,
      telegram,
      updated_at: now(),
      version: sql`${schema.contacts.version} + 1`,
      ...(actor ? { updated_by: actor } : {}),
    })
    .where(eq(schema.contacts.id, c1.id))
  const allDeals = await db.select().from(schema.deals)
  for (const d of allDeals) {
    const contacts: string[] = safeJSON(d.contacts)
    if (contacts.includes(c2.id)) {
      const updated = [
        ...new Set(contacts.map((id) => (id === c2.id ? c1.id : id))),
      ]
      await db
        .update(schema.deals)
        .set({
          contacts: JSON.stringify(updated),
          version: sql`${schema.deals.version} + 1`,
          ...(actor ? { updated_by: actor } : {}),
        })
        .where(eq(schema.deals.id, d.id))
    }
  }
  const allActivities = await db.select().from(schema.activities)
  for (const a of allActivities) {
    const contacts: string[] = safeJSON(a.contacts)
    if (contacts.includes(c2.id)) {
      const updated = [
        ...new Set(contacts.map((id) => (id === c2.id ? c1.id : id))),
      ]
      await db
        .update(schema.activities)
        .set({ contacts: JSON.stringify(updated) })
        .where(eq(schema.activities.id, a.id))
    }
  }
  await db.delete(schema.contacts).where(eq(schema.contacts.id, c2.id))
  await removeSearchIndex(db, c2.id)
  const results = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, c1.id))
  const row = results[0]
  await upsertSearchIndex(
    db,
    'contact',
    c1.id,
    await buildContactSearch(db, row),
  )
  return { id: c1.id }
}

export async function contactResolve(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const ref = (p.ref as string) ?? ''
  const c = await resolveContact(db, ref, config)
  if (!c) {
    throw new ServiceError('NOT_FOUND', `Error: contact not found: ${ref}`)
  }
  return { id: c.id, name: c.name }
}
