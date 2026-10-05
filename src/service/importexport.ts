/**
 * Import/export service — pure business logic shared by local and remote
 * mode. Import records are parsed client-side (csv/json/stdin) and sent as
 * plain rows; the server performs all validation and writes.
 */
import { eq, sql } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { upsertSearchIndex } from '../db'
import type { Contact } from '../db/schema-sqlite'
import * as schema from '../db/schema-sqlite'
import {
  activityToRow,
  companyToRow,
  contactToRow,
  dealToRow,
  safeJSON,
  taskToRow,
} from '../format'
import { ServiceError } from '../lib/errors'
import {
  buildCompanySearch,
  buildContactSearch,
  buildDealSearch,
  makeId,
  now,
} from '../lib/helpers'
import { normalizeWebsite, tryNormalizePhone } from '../normalize'

const CONTACT_FIELDS = new Set([
  'name',
  'email',
  'emails',
  'phone',
  'phones',
  'address',
  'addresses',
  'company',
  'companies',
  'tags',
  'linkedin',
  'x',
  'bluesky',
  'telegram',
])
const COMPANY_FIELDS = new Set([
  'name',
  'website',
  'websites',
  'phone',
  'phones',
  'tags',
])
const DEAL_FIELDS = new Set([
  'title',
  'value',
  'stage',
  'contacts',
  'company',
  'expected_close',
  'probability',
  'tags',
])

export interface ImportContactsParams {
  dryRun?: boolean
  records?: Record<string, string>[]
  skipErrors?: boolean
  update?: boolean
}

export async function importContacts(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{
  imported: number
  skipped: number
  errors: number
  dryRunLines: string[]
}> {
  const opts = p as ImportContactsParams
  const records = opts.records ?? []
  let imported = 0
  let skipped = 0
  let errors = 0
  const dryRunLines: string[] = []
  for (const rec of records) {
    try {
      if (!rec.name) {
        if (opts.skipErrors) {
          errors++
          continue
        }
        throw new ServiceError('INVALID', 'Error: row missing name')
      }
      const name = (rec.name || '').trim()
      const emails = splitField(rec.email || rec.emails)
        .map((e) => e.trim())
        .filter(
          (e) => e.includes('@') && !e.startsWith('@') && !e.endsWith('@'),
        )
      const phones = splitField(rec.phone || rec.phones)
        .map((ph) => {
          const n = tryNormalizePhone(ph, config.phone.default_country)
          return n || ph
        })
        .filter((ph) => /^\+\d+$/.test(ph))
      const addresses = splitField(rec.address || rec.addresses)
        .map((a) => a.trim())
        .filter(Boolean)
      const companies = splitField(rec.company || rec.companies).map((c) =>
        c.trim(),
      )
      const tags = splitField(rec.tags).map((t) => t.trim())
      // Check for existing by email
      let existing: Contact | null = null
      for (const e of emails) {
        existing = await findContactByEmail(db, e)
        if (existing) {
          break
        }
      }
      if (existing && !opts.update) {
        skipped++
        continue
      }
      if (existing && opts.update) {
        const custom: Record<string, unknown> = safeJSON(existing.custom_fields)
        for (const [k, v] of Object.entries(rec)) {
          if (!CONTACT_FIELDS.has(k) && v) {
            custom[k] = v
          }
        }
        const actor = p.actor as string | undefined
        await db
          .update(schema.contacts)
          .set({
            name: name || existing.name,
            ...(addresses.length > 0
              ? {
                  addresses: JSON.stringify([
                    ...safeJSON(existing.addresses),
                    ...addresses,
                  ]),
                }
              : {}),
            custom_fields: JSON.stringify(custom),
            updated_at: now(),
            version: sql`${schema.contacts.version} + 1`,
            ...(actor ? { updated_by: actor } : {}),
          })
          .where(eq(schema.contacts.id, existing.id))
        const results = await db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, existing.id))
        const row = results[0]
        await upsertSearchIndex(
          db,
          'contact',
          existing.id,
          await buildContactSearch(db, row),
        )
        imported++
        continue
      }
      if (opts.dryRun) {
        dryRunLines.push(`[dry-run] ${name} (${emails.join(', ')})`)
        imported++
        continue
      }
      const id = makeId('ct')
      const n = now()
      const custom: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rec)) {
        if (!CONTACT_FIELDS.has(k) && v) {
          custom[k] = v
        }
      }
      const social: Record<string, string | null> = {
        linkedin: rec.linkedin?.trim() || null,
        x: rec.x?.trim() || null,
        bluesky: rec.bluesky?.trim() || null,
        telegram: rec.telegram?.trim() || null,
      }
      await db.insert(schema.contacts).values({
        id,
        name,
        emails: JSON.stringify(emails),
        phones: JSON.stringify(phones),
        addresses: JSON.stringify(addresses),
        companies: JSON.stringify(companies),
        linkedin: social.linkedin,
        x: social.x,
        bluesky: social.bluesky,
        telegram: social.telegram,
        tags: JSON.stringify(tags),
        custom_fields: JSON.stringify(custom),
        created_at: n,
        updated_at: n,
      })
      const results = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, id))
      const row = results[0]
      await upsertSearchIndex(
        db,
        'contact',
        id,
        await buildContactSearch(db, row),
      )
      imported++
    } catch (e: unknown) {
      if (e instanceof ServiceError && !opts.skipErrors) {
        throw e
      }
      if (opts.skipErrors) {
        errors++
        continue
      }
      throw new ServiceError(
        'INVALID',
        `Error importing row: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  return { imported, skipped, errors, dryRunLines }
}

export interface ImportCompaniesParams {
  dryRun?: boolean
  records?: Record<string, string>[]
  skipErrors?: boolean
}

export async function importCompanies(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ imported: number; dryRunLines: string[] }> {
  const opts = p as ImportCompaniesParams
  const records = opts.records ?? []
  let imported = 0
  const dryRunLines: string[] = []
  for (const rec of records) {
    try {
      if (!rec.name) {
        if (opts.skipErrors) {
          continue
        }
        throw new ServiceError('INVALID', 'Error: company missing name')
      }
      rec.name = rec.name.trim()
      const websites = splitField(rec.website || rec.websites).map((w) => {
        try {
          return normalizeWebsite(w)
        } catch {
          return w
        }
      })
      const phones = splitField(rec.phone || rec.phones).map((ph) => {
        const n = tryNormalizePhone(ph, config.phone.default_country)
        return n || ph
      })
      const tags = splitField(rec.tags)
      const custom: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rec)) {
        if (!COMPANY_FIELDS.has(k) && v) {
          custom[k] = v
        }
      }
      if (opts.dryRun) {
        dryRunLines.push(`[dry-run] ${rec.name}`)
        imported++
        continue
      }
      const id = makeId('co')
      const n = now()
      await db.insert(schema.companies).values({
        id,
        name: rec.name,
        websites: JSON.stringify(websites),
        phones: JSON.stringify(phones),
        tags: JSON.stringify(tags),
        custom_fields: JSON.stringify(custom),
        created_at: n,
        updated_at: n,
      })
      const results = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, id))
      const row = results[0]
      await upsertSearchIndex(db, 'company', id, buildCompanySearch(row))
      imported++
    } catch (e: unknown) {
      if (opts.skipErrors) {
        continue
      }
      throw e
    }
  }
  return { imported, dryRunLines }
}

export interface ImportDealsParams {
  dryRun?: boolean
  records?: Record<string, string>[]
  skipErrors?: boolean
}

export async function importDeals(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ imported: number; dryRunLines: string[] }> {
  const opts = p as ImportDealsParams
  const records = opts.records ?? []
  let imported = 0
  const dryRunLines: string[] = []
  for (const rec of records) {
    try {
      if (!rec.title) {
        if (opts.skipErrors) {
          continue
        }
        throw new ServiceError('INVALID', 'Error: deal missing title')
      }
      rec.title = rec.title.trim()
      const stage = (rec.stage || config.pipeline.stages[0]).trim()
      const value = rec.value ? Number(rec.value) : null
      const tags = splitField(rec.tags)
      const custom: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rec)) {
        if (!DEAL_FIELDS.has(k) && v) {
          custom[k] = v
        }
      }
      if (opts.dryRun) {
        dryRunLines.push(`[dry-run] ${rec.title}`)
        imported++
        continue
      }
      const id = makeId('dl')
      const n = now()
      await db.insert(schema.deals).values({
        id,
        title: rec.title,
        value,
        stage,
        contacts: '[]',
        company: null,
        expected_close: rec.expected_close || null,
        probability: rec.probability ? Number(rec.probability) : null,
        tags: JSON.stringify(tags),
        custom_fields: JSON.stringify(custom),
        created_at: n,
        updated_at: n,
      })
      const results = await db
        .select()
        .from(schema.deals)
        .where(eq(schema.deals.id, id))
      const row = results[0]
      await upsertSearchIndex(db, 'deal', id, buildDealSearch(row))
      imported++
    } catch (e: unknown) {
      if (opts.skipErrors) {
        continue
      }
      throw e
    }
  }
  return { imported, dryRunLines }
}

export async function exportContacts(
  db: DB,
  _config: CRMConfig,
): Promise<{ rows: Record<string, unknown>[] }> {
  const rows = (await db.select().from(schema.contacts)).map((c) =>
    contactToRow(c),
  )
  return { rows }
}

export async function exportCompanies(
  db: DB,
  _config: CRMConfig,
): Promise<{ rows: Record<string, unknown>[] }> {
  const rows = (await db.select().from(schema.companies)).map((c) =>
    companyToRow(c),
  )
  return { rows }
}

export async function exportDeals(
  db: DB,
  _config: CRMConfig,
): Promise<{ rows: Record<string, unknown>[] }> {
  const rows = (await db.select().from(schema.deals)).map((d) => dealToRow(d))
  return { rows }
}

export async function exportAll(
  db: DB,
  _config: CRMConfig,
): Promise<{
  data: {
    contacts: Record<string, unknown>[]
    companies: Record<string, unknown>[]
    deals: Record<string, unknown>[]
    activities: Record<string, unknown>[]
    tasks: Record<string, unknown>[]
  }
}> {
  return {
    data: {
      contacts: (await db.select().from(schema.contacts)).map((c) =>
        contactToRow(c),
      ),
      companies: (await db.select().from(schema.companies)).map((c) =>
        companyToRow(c),
      ),
      deals: (await db.select().from(schema.deals)).map((d) => dealToRow(d)),
      activities: (await db.select().from(schema.activities)).map((a) =>
        activityToRow(a),
      ),
      tasks: (await db.select().from(schema.tasks)).map((t) => taskToRow(t)),
    },
  }
}

/** Parse client-side record lists (csv/json text or stdin) is the client's
 * job; this only handles the shared field-splitting semantics. */
export function splitField(val: string | undefined): string[] {
  if (!val) {
    return []
  }
  if (Array.isArray(val)) {
    return val
  }
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function findContactByEmail(
  db: DB,
  email: string,
): Promise<Contact | null> {
  const all = await db.select().from(schema.contacts)
  for (const c of all) {
    const emails: string[] = safeJSON(c.emails)
    if (emails.some((e: string) => e.toLowerCase() === email.toLowerCase())) {
      return c
    }
  }
  return null
}
