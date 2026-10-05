/**
 * Report service — pure business logic shared by local and remote mode.
 */
import { eq } from 'drizzle-orm'

import type { CRMConfig } from '../config'
import type { CrmDb } from '../db/seam'
import { safeJSON } from '../format'
import {
  computeConversion,
  computeForecast,
  computeLost,
  computePipeline,
  computeStale,
  computeVelocity,
  computeWon,
} from '../reports'

function periodToDate(period: string): string | null {
  const m = period.match(/^(\d+)d$/)
  if (m) {
    return new Date(Date.now() - Number(m[1]) * 86_400_000).toISOString()
  }
  return null
}

export async function reportPipeline(
  db: CrmDb,
  config: CRMConfig,
): Promise<{ rows: Record<string, unknown>[] }> {
  const schema = db.$crm.schema

  const deals = await db.select().from(schema.deals)
  const summary = computePipeline(deals, config.pipeline.stages)
  const total = {
    stage: 'Total',
    count: deals.length,
    value: deals.reduce((s, d) => s + (d.value || 0), 0),
  }
  return { rows: [...summary, total] }
}

export interface ReportActivityParams {
  by?: string
  period?: string
}

export async function reportActivity(
  db: CrmDb,
  _config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const schema = db.$crm.schema

  const opts = p as ReportActivityParams
  let activities = await db.select().from(schema.activities)
  if (opts.period) {
    const cutoff = periodToDate(opts.period)
    if (cutoff) {
      activities = activities.filter((a) => a.created_at >= cutoff)
    }
  }
  const groupBy = opts.by || 'type'
  const groups: Record<string, number> = {}
  for (const a of activities) {
    if (groupBy === 'contact') {
      const contacts: string[] = safeJSON(a.contacts)
      if (contacts.length === 0) {
        groups.none = (groups.none || 0) + 1
      } else {
        for (const cid of contacts) {
          groups[cid] = (groups[cid] || 0) + 1
        }
      }
    } else {
      groups[a.type] = (groups[a.type] || 0) + 1
    }
  }
  let data: Record<string, unknown>[]
  if (groupBy === 'contact') {
    const dataPromises = Object.entries(groups).map(
      async ([contact, count]) => {
        if (contact === 'none') {
          return { contact: '(none)', count }
        }
        const results = await db
          .select({ name: schema.contacts.name })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, contact))
        const ct = results[0]
        return { contact: ct?.name || contact, count }
      },
    )
    data = await Promise.all(dataPromises)
  } else {
    data = Object.entries(groups).map(([type, count]) => ({ type, count }))
  }
  return { rows: data }
}

export interface ReportStaleParams {
  days?: string
  type?: string
}

export async function reportStale(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const opts = p as ReportStaleParams
  const days = Number(opts.days)
  let results = await computeStale(db, config, days)
  if (opts.type) {
    results = results.filter((r) => r.type === opts.type)
  }
  return { rows: results }
}

export async function reportConversion(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const since = p.since as string | undefined
  const data = await computeConversion(db, config.pipeline.stages, since)
  return { rows: data }
}

export async function reportVelocity(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const wonOnly = p.wonOnly as boolean | undefined
  const wonStage = wonOnly ? config.pipeline.won_stage : undefined
  const data = await computeVelocity(db, config.pipeline.stages, wonStage)
  return { rows: data as Record<string, unknown>[] }
}

export async function reportForecast(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const period = p.period as string | undefined
  let data = await computeForecast(db, config)
  if (period) {
    if (period.match(/^\d{4}-\d{2}$/)) {
      data = data.filter((d) => d.expected_close?.startsWith(period))
    } else {
      const cutoff = periodToDate(period)
      if (cutoff) {
        data = data.filter(
          (d) => d.expected_close && d.expected_close >= cutoff,
        )
      }
    }
  }
  return { rows: data }
}

export async function reportWon(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const period = p.period as string | undefined
  let data = await computeWon(db, config)
  if (period) {
    const cutoff = periodToDate(period)
    if (cutoff) {
      data = data.filter((d) => (d.updated_at as string) >= cutoff)
    }
  }
  return { rows: data }
}

export async function reportLost(
  db: CrmDb,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[] }> {
  const period = p.period as string | undefined
  let data = await computeLost(db, config)
  if (period) {
    const cutoff = periodToDate(period)
    if (cutoff) {
      data = data.filter((d) => (d.updated_at as string) >= cutoff)
    }
  }
  return { rows: data }
}
