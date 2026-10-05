/**
 * Search service — pure business logic shared by local and remote mode.
 */
import type { CRMConfig } from '../config'
import { rebuildSearchIndex } from '../db'
import { asRows } from '../db/rows'
import type { Activity, Company, Contact, Deal } from '../db/schema-sqlite'
import type { CrmDb } from '../db/seam'
import { activityToRow, companyToRow, contactToRow, dealToRow } from '../format'

/** One row of `search_index`, limited to the columns both dialects expose. */
interface FTSRow {
  content: string
  entity_id: string
  entity_type: string
}

/**
 * Resolve a search hit into the row shape the CLI prints.
 *
 * `SELECT *` is deliberate: the `*ToRow` formatter on the other side of each
 * branch takes a whole table row, and the drizzle call these branches replace
 * (`db.select().from(t)`) compiles to the same read. `asRows` carries the shape
 * assertion once, with its reason, instead of an unchecked cast at each branch.
 *
 * The `activity` branch returns `entity_type` where the other three return
 * `type`. That inconsistency is the published shape of `crm search` output and
 * is preserved on purpose, not overlooked here.
 */
async function lookupEntity(
  db: CrmDb,
  entityType: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const raw = db.$crm.raw
  if (entityType === 'contact') {
    const [c] = asRows<Contact>(
      await raw.query('SELECT * FROM contacts WHERE id = ?', [id]),
    )
    return c ? { type: 'contact', ...contactToRow(c) } : null
  }
  if (entityType === 'company') {
    const [co] = asRows<Company>(
      await raw.query('SELECT * FROM companies WHERE id = ?', [id]),
    )
    return co ? { type: 'company', ...companyToRow(co) } : null
  }
  if (entityType === 'deal') {
    const [d] = asRows<Deal>(
      await raw.query('SELECT * FROM deals WHERE id = ?', [id]),
    )
    return d ? { type: 'deal', ...dealToRow(d) } : null
  }
  if (entityType === 'activity') {
    const [a] = asRows<Activity>(
      await raw.query('SELECT * FROM activities WHERE id = ?', [id]),
    )
    return a ? { entity_type: 'activity', ...activityToRow(a) } : null
  }
  return null
}

export interface SearchParams {
  query?: string
  type?: string
}

/** Three ways to read the index; only the first two know about dialects. */
const FULL_TEXT_SQL = {
  postgres:
    "SELECT entity_type, entity_id, content FROM search_index WHERE tsv @@ plainto_tsquery('simple', ?)",
  sqlite:
    'SELECT entity_type, entity_id, content FROM search_index WHERE content MATCH ?',
} as const

const SUBSTRING_SQL = {
  postgres:
    'SELECT entity_type, entity_id, content FROM search_index WHERE content ILIKE ?',
  sqlite:
    'SELECT entity_type, entity_id, content FROM search_index WHERE content LIKE ?',
} as const

/**
 * No query at all: every indexed row, in a stable order.
 *
 * sqlite reaches this result by accident. `MATCH ''` is a syntax error, so the
 * substring fallback runs, and `LIKE '%%'` matches everything. Postgres never
 * reaches the fallback for the same input: `plainto_tsquery('simple', '')`
 * produces no lexemes, the predicate is false, and the answer is nothing. A
 * disagreement on the one query neither engine can answer the same way is not
 * something callers can work around, so the empty query is handled here rather
 * than translated twice.
 */
const EVERY_ROW_SQL =
  'SELECT entity_type, entity_id, content FROM search_index ORDER BY entity_type, entity_id'

/** Table totals for `crm index status`. A table name cannot be a bind parameter. */
const COUNT_CONTACTS_SQL = 'SELECT COUNT(*) as cnt FROM contacts'
const COUNT_COMPANIES_SQL = 'SELECT COUNT(*) as cnt FROM companies'
const COUNT_DEALS_SQL = 'SELECT COUNT(*) as cnt FROM deals'

/**
 * Indexed rows matching `query`.
 *
 * The full-text predicate is tried first and the substring scan is the
 * fallback, which is what the command has always done: FTS5 rejects queries it
 * cannot parse (`&`, `|`, an unterminated `"`) rather than treating them as
 * text. On Postgres the same class of input is accepted — `plainto_tsquery`
 * discards punctuation — so the fallback is reached less often, and the
 * difference is invisible as long as both dialects return the same rows for the
 * queries that do reach it.
 *
 * Order is not comparable across the three paths (bm25, ts_rank, and an
 * unordered scan each rank differently), so callers get relevance only in the
 * sense that the scan is the least precise answer.
 */
async function searchIndexRows(db: CrmDb, query: string): Promise<FTSRow[]> {
  const raw = db.$crm.raw
  if (query === '') {
    return asRows<FTSRow>(await raw.query(EVERY_ROW_SQL))
  }
  const dialect = db.$crm.dialect
  try {
    return asRows<FTSRow>(await raw.query(FULL_TEXT_SQL[dialect], [query]))
  } catch {
    // Full-text search can reject a query it cannot parse — fall back to text.
    return asRows<FTSRow>(
      await raw.query(SUBSTRING_SQL[dialect], [`%${query}%`]),
    )
  }
}

export async function searchFts(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as SearchParams
  const query = (opts.query ?? '').trim()
  const hits = (await searchIndexRows(db, query)).filter(
    (row) => !opts.type || row.entity_type === opts.type,
  )
  const results: Record<string, unknown>[] = []
  for (const hit of hits) {
    const entity = await lookupEntity(db, hit.entity_type, hit.entity_id)
    if (entity) {
      results.push(entity)
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
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as FindParams
  const query = (opts.query ?? '').trim()
  const queryWords = query.toLowerCase().split(/\s+/)
  const allEntities: (FTSRow & { score: number })[] = []
  const indexRows = asRows<FTSRow>(await db.$crm.raw.query(EVERY_ROW_SQL))
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

/**
 * Row counts against indexed counts, so drift is visible without a rebuild.
 *
 * `COUNT(*)` is read with `Number()` because Postgres answers aggregate
 * functions with a string while sqlite answers with a number — the same
 * divergence the audit chain documents for `seq`. Interpolated into the line
 * unchanged it would still print correctly here, and be wrong the moment
 * anybody compared the two numbers in JavaScript.
 */
export async function indexStatus(
  db: CrmDb,
  _config: CRMConfig,
): Promise<{ lines: string[] }> {
  const countRows = await db.$crm.raw.query(
    'SELECT entity_type, COUNT(*) as cnt FROM search_index GROUP BY entity_type',
  )
  const counts: Record<string, number> = {}
  for (const r of countRows) {
    counts[String(r.entity_type)] = Number(r.cnt)
  }
  const total = async (sql: string): Promise<number> => {
    const [row] = await db.$crm.raw.query(sql)
    return Number(row?.cnt ?? 0)
  }
  return {
    lines: [
      `contacts: ${await total(COUNT_CONTACTS_SQL)} (indexed: ${counts.contact || 0})`,
      `companies: ${await total(COUNT_COMPANIES_SQL)} (indexed: ${counts.company || 0})`,
      `deals: ${await total(COUNT_DEALS_SQL)} (indexed: ${counts.deal || 0})`,
    ],
  }
}

export async function indexRebuild(
  db: CrmDb,
  _config: CRMConfig,
): Promise<Record<string, never>> {
  await rebuildSearchIndex(db)
  return {}
}
