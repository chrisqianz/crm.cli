/**
 * B4: audit before/after diff — pure functions over the two JSON
 * snapshots an audit row carries. Shared by the CLI (`crm audit show
 * --diff`) and exercised by tests; the console renders its own JS
 * mirror of the same rules (the console is a self-contained page).
 */

export interface FieldDiff {
  after: string
  /** Display strings; '—' marks the absent side. */
  before: string
  field: string
}

function asDisplay(v: unknown): string {
  if (v === null || v === undefined) {
    return '—'
  }
  if (typeof v === 'string') {
    return v
  }
  return JSON.stringify(v)
}

/** Parse an audit snapshot; null/blank/invalid → {} (row-level event). */
export function parseSnapshot(json: string | null): Record<string, unknown> {
  if (!json) {
    return {}
  }
  try {
    const v: unknown = JSON.parse(json)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return {}
    }
    return v as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Shallow field diff of two snapshots. A field counts as changed when
 * its JSON serialization differs (including one-side-only fields);
 * unchanged fields are omitted. Order: after-snapshot keys first, then
 * fields that only exist in before.
 */
export function diffSnapshots(
  beforeJson: string | null,
  afterJson: string | null,
): FieldDiff[] {
  const before = parseSnapshot(beforeJson)
  const after = parseSnapshot(afterJson)
  const fields = [
    ...Object.keys(after),
    ...Object.keys(before).filter((k) => !(k in after)),
  ]
  const diffs: FieldDiff[] = []
  for (const field of fields) {
    const b = field in before ? before[field] : null
    const a = field in after ? after[field] : null
    if (JSON.stringify(b) === JSON.stringify(a)) {
      continue
    }
    diffs.push({ field, before: asDisplay(b), after: asDisplay(a) })
  }
  return diffs
}

/** Plain-text side-by-side table of the changed fields only. */
export function renderDiff(
  beforeJson: string | null,
  afterJson: string | null,
): string {
  const diffs = diffSnapshots(beforeJson, afterJson)
  if (diffs.length === 0) {
    return 'no field-level changes (row-level event)'
  }
  const fields = diffs.map((d) => d.field)
  const befores = diffs.map((d) => d.before)
  const afters = diffs.map((d) => d.after)
  const wF = Math.max('field'.length, ...fields.map((s) => s.length))
  const wB = Math.max('before'.length, ...befores.map((s) => s.length))
  const wA = Math.max('after'.length, ...afters.map((s) => s.length))
  const line = (f: string, b: string, a: string) =>
    `${f.padEnd(wF)}  ${b.padEnd(wB)}  ${a.padEnd(wA).trimEnd()}`
  const head = line('field', 'before', 'after')
  const body = diffs.map((d) => line(d.field, d.before, d.after)).join('\n')
  return `${head}\n${body}`
}
