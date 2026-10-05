/**
 * Tag service — pure business logic shared by local and remote mode.
 */
import { eq, sql } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { CrmDb } from '../db/seam'
import { safeJSON } from '../format'
import { ServiceError } from '../lib/errors'
import { now } from '../lib/helpers'
import { resolveEntity } from '../resolve'

async function setTags(
  db: CrmDb,
  entityType: string,
  entityId: string,
  tags: string[],
): Promise<void> {
  const schema = db.$crm.schema

  if (entityType === 'contact') {
    await db
      .update(schema.contacts)
      .set({
        tags: JSON.stringify(tags),
        updated_at: now(),
        version: sql`${schema.contacts.version} + 1`,
      })
      .where(eq(schema.contacts.id, entityId))
  } else if (entityType === 'company') {
    await db
      .update(schema.companies)
      .set({
        tags: JSON.stringify(tags),
        updated_at: now(),
        version: sql`${schema.companies.version} + 1`,
      })
      .where(eq(schema.companies.id, entityId))
  } else {
    await db
      .update(schema.deals)
      .set({
        tags: JSON.stringify(tags),
        updated_at: now(),
        version: sql`${schema.deals.version} + 1`,
      })
      .where(eq(schema.deals.id, entityId))
  }
}

export async function tagEntity(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<Record<string, never>> {
  const ref = ((p.ref as string) ?? '').trim()
  const tags = ((p.tags as string[]) ?? []).map((t) => t.trim())
  const resolved = await resolveEntity(db, ref, config)
  if (!resolved) {
    throw new ServiceError('NOT_FOUND', `Error: entity not found: ${ref}`)
  }
  const { type, entity } = resolved
  const existing: string[] = safeJSON(entity.tags)
  for (const t of tags) {
    if (!existing.includes(t)) {
      existing.push(t)
    }
  }
  await setTags(db, type, entity.id, existing)
  return {}
}

export async function untagEntity(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<Record<string, never>> {
  const ref = ((p.ref as string) ?? '').trim()
  const tags = ((p.tags as string[]) ?? []).map((t) => t.trim())
  const resolved = await resolveEntity(db, ref, config)
  if (!resolved) {
    throw new ServiceError('NOT_FOUND', `Error: entity not found: ${ref}`)
  }
  const { type, entity } = resolved
  let existing: string[] = safeJSON(entity.tags)
  for (const t of tags) {
    existing = existing.filter((v) => v !== t)
  }
  await setTags(db, type, entity.id, existing)
  return {}
}

export async function tagList(
  db: CrmDb,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const schema = db.$crm.schema

  const type = p.type as string | undefined
  const tagMap: Record<string, number> = {}
  if (!type || type === 'contact') {
    const rows = await db
      .select({ tags: schema.contacts.tags })
      .from(schema.contacts)
    for (const r of rows) {
      const tags: string[] = safeJSON(r.tags)
      for (const tag of tags) {
        tagMap[tag] = (tagMap[tag] || 0) + 1
      }
    }
  }
  if (!type || type === 'company') {
    const rows = await db
      .select({ tags: schema.companies.tags })
      .from(schema.companies)
    for (const r of rows) {
      const tags: string[] = safeJSON(r.tags)
      for (const tag of tags) {
        tagMap[tag] = (tagMap[tag] || 0) + 1
      }
    }
  }
  if (!type || type === 'deal') {
    const rows = await db.select({ tags: schema.deals.tags }).from(schema.deals)
    for (const r of rows) {
      const tags: string[] = safeJSON(r.tags)
      for (const tag of tags) {
        tagMap[tag] = (tagMap[tag] || 0) + 1
      }
    }
  }
  return {
    rows: Object.entries(tagMap).map(([tag, count]) => ({ tag, count })),
  }
}
