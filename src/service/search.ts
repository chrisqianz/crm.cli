/**
 * Search service — pure business logic shared by local and remote mode.
 */
import { eq, sql } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { rebuildSearchIndex } from '../db'
import * as schema from '../drizzle-schema'
import { activityToRow, companyToRow, contactToRow, dealToRow } from '../format'

interface FTSRow {
  content: string
  entity_id: string
  entity_type: string
}

async function lookupEntity(
  db: DB,
  entityType: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (entityType === 'contact') {
    const results = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, id))
    const c = results[0]
    if (!c) {
      return null
    }
    return { type: 'contact', ...contactToRow(c) }
  }
  if (entityType === 'company') {
    const results = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, id))
    const c = results[0]
    if (!c) {
      return null
    }
    return { type: 'company', ...companyToRow(c) }
  }
  if (entityType === 'deal') {
    const results = await db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, id))
    const d = results[0]
    if (!d) {
      return null
    }
    return { type: 'deal', ...dealToRow(d) }
  }
  if (entityType === 'activity') {
    const results = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.id, id))
    const a = results[0]
    if (!a) {
      return null
    }
    const row = activityToRow(a)
    return { entity_type: 'activity', ...row }
  }
  return null
}

export interface SearchParams {
  query?: string
  type?: string
}

export async function searchFts(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as SearchParams
  const query = (opts.query ?? '').trim()
  const results: Record<string, unknown>[] = []
  try {
    const ftsRows = (await db.all(
      sql`SELECT * FROM search_index WHERE content MATCH ${query}`,
    )) as FTSRow[]
    for (const fr of ftsRows) {
      if (opts.type && fr.entity_type !== opts.type) {
        continue
      }
      const entity = await lookupEntity(db, fr.entity_type, fr.entity_id)
      if (entity) {
        results.push(entity)
      }
    }
  } catch {
    // FTS5 match can fail on certain queries, fall back to LIKE
    const likeRows = (await db.all(
      sql`SELECT * FROM search_index WHERE content LIKE ${`%${query}%`}`,
    )) as FTSRow[]
    for (const fr of likeRows) {
      if (opts.type && fr.entity_type !== opts.type) {
        continue
      }
      const entity = await lookupEntity(db, fr.entity_type, fr.entity_id)
      if (entity) {
        results.push(entity)
      }
    }
  }
  return { rows: results.slice(0, config.mount.search_limit) }
}

export interface FindParams {
  limit?: string
  query?: string
  threshold?: string
  type?: string
}

export async function findSemantic(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as FindParams
  const query = (opts.query ?? '').trim()
  const queryWords = query.toLowerCase().split(/\s+/)
  const allEntities: (FTSRow & { score: number })[] = []
  const indexRows = (await db.all(sql`SELECT * FROM search_index`)) as FTSRow[]
  for (const row of indexRows) {
    if (opts.type && row.entity_type !== opts.type) {
      continue
    }
    if (row.entity_type === 'activity') {
      continue
    }
    const content = (row.content || '').toLowerCase()
    let score = 0
    for (const w of queryWords) {
      if (content.includes(w)) {
        score += 1
      }
    }
    if (score > 0) {
      const normalized = queryWords.length > 0 ? score / queryWords.length : 0
      allEntities.push({ ...row, score: normalized })
    }
  }
  allEntities.sort((a, b) => b.score - a.score)
  let limited = allEntities
  if (opts.threshold) {
    const t = Number(opts.threshold)
    limited = limited.filter((e) => e.score >= t)
  }
  const maxResults = opts.limit ? Number(opts.limit) : config.mount.search_limit
  limited = limited.slice(0, maxResults)
  const resultPromises = limited.map((r) =>
    lookupEntity(db, r.entity_type, r.entity_id),
  )
  const results = (await Promise.all(resultPromises)).filter(Boolean) as Record<
    string,
    unknown
  >[]
  return { rows: results }
}

export async function indexStatus(
  db: DB,
  _config: CRMConfig,
): Promise<{ lines: string[] }> {
  const countRows = (await db.all(
    sql`SELECT entity_type, COUNT(*) as cnt FROM search_index GROUP BY entity_type`,
  )) as { entity_type: string; cnt: number }[]
  const counts: Record<string, number> = {}
  for (const r of countRows) {
    counts[r.entity_type] = r.cnt
  }
  const contactCount = (
    await db.select({ cnt: sql<number>`COUNT(*)` }).from(schema.contacts)
  )[0]
  const companyCount = (
    await db.select({ cnt: sql<number>`COUNT(*)` }).from(schema.companies)
  )[0]
  const dealCount = (
    await db.select({ cnt: sql<number>`COUNT(*)` }).from(schema.deals)
  )[0]
  return {
    lines: [
      `contacts: ${contactCount.cnt} (indexed: ${counts.contact || 0})`,
      `companies: ${companyCount.cnt} (indexed: ${counts.company || 0})`,
      `deals: ${dealCount.cnt} (indexed: ${counts.deal || 0})`,
    ],
  }
}

export async function indexRebuild(
  db: DB,
  _config: CRMConfig,
): Promise<Record<string, never>> {
  await rebuildSearchIndex(db)
  return {}
}
