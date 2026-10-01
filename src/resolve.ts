import { eq } from 'drizzle-orm'

import type { CRMConfig } from './config'
import type { DB } from './db'
import type { Company, Contact, Deal, Task } from './drizzle-schema'
import * as schema from './drizzle-schema'
import { safeJSON } from './format.ts'
import { ServiceError } from './lib/errors'
import {
  extractPhoneDigits,
  phoneMatchesByDigits,
  tryExtractSocialHandle,
  tryNormalizePhone,
  tryNormalizeWebsite,
} from './normalize.ts'

/**
 * Name-based ref lookup: case-insensitive EXACT match only.
 * One match wins; several matches throw CONFLICT (CLI exit 3) listing the
 * candidates, because silently picking one of two 张三 would be worse than
 * asking. A prefix of another name is NOT a match.
 */
function nameCandidates<T extends { id: string }>(
  kind: 'contact' | 'company' | 'deal' | 'task',
  rows: T[],
  ref: string,
  getName: (row: T) => string,
  extra?: (row: T) => string,
): T | null {
  const q = ref.trim().toLowerCase()
  if (!q) {
    return null
  }
  const exact = rows.filter((r) => getName(r).trim().toLowerCase() === q)
  if (exact.length === 1) {
    return exact[0]
  }
  if (exact.length > 1) {
    const plural = kind === 'deal' ? 'deals' : `${kind}s`
    const lines = exact
      .slice(0, 10)
      .map(
        (r) => `  ${r.id}  ${getName(r)}${extra ? ` ${extra(r)}`.trim() : ''}`,
      )
    throw new ServiceError(
      'CONFLICT',
      `Error: multiple ${plural} match "${ref}":\n${lines.join('\n')}\n${
        kind === 'contact'
          ? 'Use the id (or email) to disambiguate'
          : 'Use the id to disambiguate'
      }`,
    )
  }
  return null
}

export async function resolveContact(
  db: DB,
  rawRef: string,
  config?: CRMConfig,
): Promise<Contact | null> {
  const ref = rawRef.trim()
  // By ID
  if (ref.startsWith('ct_')) {
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, ref))
    return results[0] || null
  }

  // By name (case-insensitive exact; ambiguity → exit 3)
  {
    const all = await db.select().from(schema.contacts)
    const hit = nameCandidates(
      'contact',
      all,
      ref,
      (c) => c.name,
      (c) => {
        const emails: string[] = safeJSON(c.emails)
        return emails.length > 0 ? `<${emails[0]}>` : ''
      },
    )
    if (hit) {
      return hit
    }
  }

  // By email
  if (ref.includes('@') && !ref.includes('/')) {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    // First try as email
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      const emails: string[] = safeJSON(c.emails)
      if (emails.some((e) => e.toLowerCase() === ref.toLowerCase())) {
        return c
      }
    }
    // Try as social handle with @ prefix
    for (const c of all) {
      if (
        c.linkedin === handle ||
        c.x === handle ||
        c.bluesky === handle ||
        c.telegram === handle
      ) {
        return c
      }
    }
    return null
  }

  // Try social URL extraction
  const extracted = tryExtractSocialHandle(ref)
  if (extracted) {
    const col = extracted.platform as 'linkedin' | 'x' | 'bluesky' | 'telegram'
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts[col], extracted.handle))
    if (results[0]) {
      return results[0]
    }
  }

  // Try phone normalization
  const phoneNorm = tryNormalizePhone(ref, config?.phone?.default_country)
  if (phoneNorm) {
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      const phones: string[] = safeJSON(c.phones)
      if (phones.includes(phoneNorm)) {
        return c
      }
    }
  }

  // Try digit-based phone matching
  const digits = extractPhoneDigits(ref)
  if (digits.length >= 7) {
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      const phones: string[] = safeJSON(c.phones)
      for (const p of phones) {
        if (phoneMatchesByDigits(p, digits)) {
          return c
        }
      }
    }
  }

  // Try as social handle (raw or with dots like bsky handles)
  {
    const handle = ref.startsWith('@') ? ref.slice(1) : ref
    const all = await db.select().from(schema.contacts)
    for (const c of all) {
      if (
        c.linkedin === handle ||
        c.x === handle ||
        c.bluesky === handle ||
        c.telegram === handle
      ) {
        return c
      }
    }
  }

  return null
}

export async function resolveCompany(
  db: DB,
  rawRef: string,
  config?: CRMConfig,
): Promise<Company | null> {
  const ref = rawRef.trim()
  // By ID
  if (ref.startsWith('co_')) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, ref))
    return results[0] || null
  }

  // By website (normalize and check)
  const all = await db.select().from(schema.companies)
  const normalizedWeb = tryNormalizeWebsite(ref)
  if (normalizedWeb) {
    for (const co of all) {
      const websites: string[] = safeJSON(co.websites)
      if (websites.some((w) => w === normalizedWeb)) {
        return co
      }
    }
  }

  // By phone
  const phoneNorm = tryNormalizePhone(ref, config?.phone?.default_country)
  if (phoneNorm) {
    for (const co of all) {
      const phones: string[] = safeJSON(co.phones)
      if (phones.includes(phoneNorm)) {
        return co
      }
    }
  }

  // By digit matching
  const digits = extractPhoneDigits(ref)
  if (digits.length >= 7) {
    for (const co of all) {
      const phones: string[] = safeJSON(co.phones)
      for (const p of phones) {
        if (phoneMatchesByDigits(p, digits)) {
          return co
        }
      }
    }
  }

  // By name (case-insensitive exact; ambiguity → exit 3)
  {
    const hit = nameCandidates('company', all, ref, (c) => c.name)
    if (hit) {
      return hit
    }
  }

  return null
}

export async function resolveDeal(
  db: DB,
  rawRef: string,
): Promise<Deal | null> {
  const ref = rawRef.trim()
  if (ref.startsWith('dl_')) {
    const results = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, ref))
    return results[0] || null
  }
  // By title (case-insensitive exact; ambiguity → exit 3)
  const all = await db.select().from(schema.deals)
  const hit = nameCandidates('deal', all, ref, (d) => d.title)
  if (hit) {
    return hit
  }
  return null
}

export async function resolveTask(
  db: DB,
  rawRef: string,
): Promise<Task | null> {
  const ref = rawRef.trim()
  if (ref.startsWith('tk_')) {
    const results = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ref))
    return results[0] || null
  }
  // By title (case-insensitive exact; ambiguity → exit 3)
  const all = await db.select().from(schema.tasks)
  const hit = nameCandidates('task', all, ref, (t) => t.title)
  if (hit) {
    return hit
  }
  return null
}

export async function resolveEntity(
  db: DB,
  rawRef: string,
  config?: CRMConfig,
): Promise<{ type: string; entity: Contact | Company | Deal } | null> {
  const ref = rawRef.trim()
  // Try contact first
  const contact = await resolveContact(db, ref, config)
  if (contact) {
    return { type: 'contact', entity: contact }
  }

  // Try company
  const company = await resolveCompany(db, ref, config)
  if (company) {
    return { type: 'company', entity: company }
  }

  // Try deal
  const deal = await resolveDeal(db, ref)
  if (deal) {
    return { type: 'deal', entity: deal }
  }

  return null
}

export async function resolveCompanyForLink(
  db: DB,
  rawRef: string,
): Promise<Company | null> {
  const ref = rawRef.trim()
  // Try by ID
  if (ref.startsWith('co_')) {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, ref))
    return results[0] || null
  }

  // Try by website
  const all = await db.select().from(schema.companies)
  const normalizedWeb = tryNormalizeWebsite(ref)
  if (normalizedWeb) {
    for (const co of all) {
      const websites: string[] = safeJSON(co.websites)
      if (websites.some((w) => w === normalizedWeb)) {
        return co
      }
    }
  }

  // By name (case-insensitive exact; ambiguity → exit 3)
  {
    const hit = nameCandidates('company', all, ref, (c) => c.name)
    if (hit) {
      return hit
    }
  }

  return null
}
