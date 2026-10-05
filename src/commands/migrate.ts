import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { Command } from 'commander'

import { loadConfig } from '../config'
import { resolveBackend } from '../db/open'
import { asRows, text } from '../db/rows'
import type { CrmDb } from '../db/seam'
import { die } from '../lib/helpers'
import { isRemote, localOnly, requireLocalHost } from '../remote/dispatch'

/**
 * `crm migrate export` — one-way migration from a local SQLite workspace
 * into the central server (spec/alignment.md AL-1-7).
 *
 * The output is *not* a database dump and not `crm export` output. It is a
 * JSON document whose top-level buckets are named after the RPC that consumes
 * each one (`meta.load`), so the receiving side replays ordinary write paths:
 * `import.companies` / `import.contacts` bulk-load the records verbatim,
 * `deal.add` / `task.add` / `activity.log` re-resolve human references and
 * mint fresh ids. Primary keys are therefore stripped everywhere and every
 * link — a contact's companies, a deal's contacts, a task's contact, an
 * activity's contacts/company/deal — is rendered as a NAME, because the id
 * this database handed out will not exist in the central one.
 *
 * The read path is raw SQL over the whole tables rather than the list
 * services: `task.list` defaults to open tasks, `deal.list` filters by owner,
 * and a migration that quietly skipped either would be a silent data loss.
 */

/** Every table is enumerated with a literal statement — table names cannot be bound. */
const SELECT_COMPANIES =
  'SELECT id, name, websites, phones, tags, custom_fields FROM companies ORDER BY created_at, id'

const SELECT_CONTACTS =
  'SELECT id, name, emails, phones, addresses, companies, linkedin, x, bluesky, telegram, tags, owner, custom_fields FROM contacts ORDER BY created_at, id'

const SELECT_DEALS =
  'SELECT id, title, value, stage, contacts, company, expected_close, probability, tags, owner, custom_fields FROM deals ORDER BY created_at, id'

const SELECT_TASKS =
  'SELECT id, title, due_at, status, owner, contact, deal FROM tasks ORDER BY created_at, id'

const SELECT_ACTIVITIES =
  'SELECT id, type, body, contacts, company, deal, custom_fields, created_at FROM activities ORDER BY created_at, id'

/** Bucket name -> the RPC that loads it. Buckets run in this order. */
const LOAD_RPC = {
  companies: 'import.companies',
  contacts: 'import.contacts',
  deals: 'deal.add',
  tasks: 'task.add',
  activities: 'activity.log',
} as const

const BUCKET_ORDER = [
  'companies',
  'contacts',
  'deals',
  'tasks',
  'activities',
] as const

type Bucket = (typeof BUCKET_ORDER)[number]

/**
 * What a replay through those RPCs cannot carry, stated up front. A migration
 * plan that reads only `meta.counts` still sees these, so nobody discovers
 * later that every record now claims a recent timestamp or that finished
 * tasks came back open.
 */
const NOT_PRESERVED = [
  'contacts/companies/deals: created_at and updated_at (the load path stamps them)',
  'contacts/deals: owner (import and add resolve the caller)',
  'tasks: status (task.add always creates an open task)',
  'tasks: created_at (task.add stamps it)',
]

type Row = Record<string, unknown>

/** JSON TEXT column -> string list; anything unparseable is an empty list. */
function jsonList(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .filter((item) => item.length > 0)
  } catch {
    return []
  }
}

/** JSON TEXT column -> plain object; anything unparseable is empty. */
function jsonMap(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    return { ...(parsed as Record<string, unknown>) }
  } catch {
    return {}
  }
}

/** Custom fields -> the `k=v` list `deal.add` / `activity.log` read as `set`. */
function kvPairs(value: unknown): string[] {
  return Object.entries(jsonMap(value)).map(
    ([key, val]) => `${key}=${String(val)}`,
  )
}

/** Write a field only when it carries something — empty keys invite overwrite. */
function put(row: Row, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return
  }
  if (typeof value === 'string' && value === '') {
    return
  }
  if (Array.isArray(value) && value.length === 0) {
    return
  }
  row[key] = value
}

/** Spread a contact/company custom-fields object onto the record's top level. */
function flattenInto(row: Row, value: unknown): void {
  for (const [key, val] of Object.entries(jsonMap(value))) {
    put(row, key, val)
  }
}

/** Numbers leave as strings: `--value` / `--probability` parse text in. */
function numericToText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return String(value)
}

/**
 * id -> display reference maps. Links live in JSON TEXT columns as ids, so a
 * dump that passed them through would point at rows the central server never
 * created. Unresolvable ids are dropped rather than emitted as a dangling
 * reference — the load path would reject them anyway.
 */
interface RefMaps {
  companyName: Map<string, string>
  contactName: Map<string, string>
  dealTitle: Map<string, string>
}

function refName(map: Map<string, string>, id: string): string | null {
  return map.get(id) ?? null
}

function refNames(map: Map<string, string>, ids: string[]): string[] {
  const names: string[] = []
  for (const id of ids) {
    const name = map.get(id)
    if (name) {
      names.push(name)
    }
  }
  return names
}

function buildMaps(
  companyRows: Row[],
  contactRows: Row[],
  dealRows: Row[],
): RefMaps {
  const companyName = new Map<string, string>()
  for (const row of companyRows) {
    const id = text(row.id)
    const name = text(row.name)
    if (id && name) {
      companyName.set(id, name)
    }
  }
  const contactName = new Map<string, string>()
  for (const row of contactRows) {
    const id = text(row.id)
    const name = text(row.name)
    if (id && name) {
      contactName.set(id, name)
    }
  }
  const dealTitle = new Map<string, string>()
  for (const row of dealRows) {
    const id = text(row.id)
    const title = text(row.title)
    if (id && title) {
      dealTitle.set(id, title)
    }
  }
  return { contactName, companyName, dealTitle }
}

function exportCompanies(rows: Row[]): Row[] {
  return rows.map((r) => {
    const rec: Row = {}
    put(rec, 'name', text(r.name))
    put(rec, 'websites', jsonList(r.websites))
    put(rec, 'phones', jsonList(r.phones))
    put(rec, 'tags', jsonList(r.tags))
    flattenInto(rec, r.custom_fields)
    return rec
  })
}

function exportContacts(rows: Row[]): Row[] {
  return rows.map((r) => {
    const rec: Row = {}
    put(rec, 'name', text(r.name))
    put(rec, 'emails', jsonList(r.emails))
    put(rec, 'phones', jsonList(r.phones))
    put(rec, 'addresses', jsonList(r.addresses))
    // companies holds company ids; the load path resolves names.
    put(rec, 'companies', jsonList(r.companies))
    put(rec, 'linkedin', text(r.linkedin))
    put(rec, 'x', text(r.x))
    put(rec, 'bluesky', text(r.bluesky))
    put(rec, 'telegram', text(r.telegram))
    put(rec, 'tags', jsonList(r.tags))
    put(rec, 'owner', text(r.owner))
    flattenInto(rec, r.custom_fields)
    return rec
  })
}

function exportDeals(rows: Row[], maps: RefMaps): Row[] {
  return rows.map((r) => {
    const rec: Row = {}
    put(rec, 'title', text(r.title))
    put(rec, 'value', numericToText(r.value))
    put(rec, 'stage', text(r.stage))
    // Key names here are exactly what deal.add reads: singular `contact`,
    // camelCase `expectedClose`.
    put(rec, 'contact', refNames(maps.contactName, jsonList(r.contacts)))
    put(rec, 'company', refName(maps.companyName, text(r.company) ?? ''))
    put(rec, 'expectedClose', text(r.expected_close))
    put(rec, 'probability', numericToText(r.probability))
    put(rec, 'tag', jsonList(r.tags))
    put(rec, 'set', kvPairs(r.custom_fields))
    put(rec, 'owner', text(r.owner))
    return rec
  })
}

function exportTasks(rows: Row[], maps: RefMaps): Row[] {
  return rows.map((r) => {
    const rec: Row = {}
    put(rec, 'title', text(r.title))
    put(rec, 'due', text(r.due_at))
    put(rec, 'contact', refName(maps.contactName, text(r.contact) ?? ''))
    put(rec, 'deal', refName(maps.dealTitle, text(r.deal) ?? ''))
    put(rec, 'owner', text(r.owner))
    return rec
  })
}

function exportActivities(rows: Row[], maps: RefMaps): Row[] {
  return rows.map((r) => {
    const rec: Row = {}
    put(rec, 'type', text(r.type))
    put(rec, 'body', text(r.body))
    put(rec, 'contact', refNames(maps.contactName, jsonList(r.contacts)))
    put(rec, 'company', refName(maps.companyName, text(r.company) ?? ''))
    put(rec, 'deal', refName(maps.dealTitle, text(r.deal) ?? ''))
    // activity.log accepts an explicit timestamp, so history keeps its shape.
    put(rec, 'at', text(r.created_at))
    put(rec, 'set', kvPairs(r.custom_fields))
    return rec
  })
}

/** stdout carries either the document or the summary — never both. */
function emit(
  json: string,
  outPath: string | undefined,
  summary: string,
): void {
  if (outPath) {
    try {
      writeFileSync(outPath, `${json}\n`)
    } catch (e) {
      die(`migrate export: cannot write ${outPath} — ${(e as Error).message}`)
    }
    console.log(summary)
    return
  }
  process.stdout.write(`${json}\n`)
  console.error(summary)
}

function summary(
  source: string,
  counts: Record<Bucket, number>,
  outPath: string | undefined,
): string {
  const lines = [
    `migrate export — source: ${source}`,
    `  companies:   ${counts.companies}  -> import.companies`,
    `  contacts:    ${counts.contacts}  -> import.contacts`,
    `  deals:       ${counts.deals}  -> deal.add`,
    `  tasks:       ${counts.tasks}  -> task.add`,
    `  activities:  ${counts.activities}  -> activity.log`,
    'not preserved by the load path:',
    ...NOT_PRESERVED.map((line) => `  - ${line}`),
  ]
  if (outPath) {
    lines.push(`written: ${outPath}`)
  } else {
    lines.push('stdout carries the JSON document only; pipe it to a file.')
  }
  return lines.join('\n')
}

/**
 * Migration is a local-SQLite read. Asserted in this order: a remote target
 * has no local database to dump; a server wired to Postgres must not be
 * quietly migrated out of the SQLite file `localOnly()` would open; and only
 * then does the ordinary local-host guard run.
 */
function assertLocalSqlite(): string {
  if (isRemote()) {
    die(
      'migrate export runs against the local SQLite database — log out, or run it on the migration source machine.',
    )
  }
  const config = loadConfig({})
  if (resolveBackend(config) !== 'sqlite') {
    die(
      'migrate export reads the local SQLite workspace and cannot run against a Postgres backend (set [database] backend = "sqlite" on the source machine).',
    )
  }
  requireLocalHost()
  return config.database.path ?? ''
}

async function buildPayload(db: CrmDb, source: string) {
  const raw = db.$crm.raw
  const companyRows = asRows<Row>(await raw.query(SELECT_COMPANIES))
  const contactRows = asRows<Row>(await raw.query(SELECT_CONTACTS))
  const dealRows = asRows<Row>(await raw.query(SELECT_DEALS))
  const taskRows = asRows<Row>(await raw.query(SELECT_TASKS))
  const activityRows = asRows<Row>(await raw.query(SELECT_ACTIVITIES))

  const maps = buildMaps(companyRows, contactRows, dealRows)
  const companies = exportCompanies(companyRows)
  const contacts = exportContacts(contactRows)
  const deals = exportDeals(dealRows, maps)
  const tasks = exportTasks(taskRows, maps)
  const activities = exportActivities(activityRows, maps)

  const counts: Record<Bucket, number> = {
    companies: companies.length,
    contacts: contacts.length,
    deals: deals.length,
    tasks: tasks.length,
    activities: activities.length,
  }

  return {
    meta: {
      source: `sqlite:${source}`,
      counts,
      not_preserved: NOT_PRESERVED,
      load: { ...LOAD_RPC },
    },
    companies,
    contacts,
    deals,
    tasks,
    activities,
  }
}

export function registerMigrateCommand(program: Command): void {
  const migrate = program
    .command('migrate')
    .description('move a local SQLite workspace into the central server')

  migrate
    .command('export')
    .description('export local data as JSON the central server can load')
    .option('--out <file>', 'write the document here instead of stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  crm migrate export --out crm-export.json',
        '  crm migrate export | ssh central ' +
          '"bun run src/cli.ts rpc import.contacts -"',
        '',
        'Records are grouped per loading RPC (see meta.load). Ids are stripped',
        'and links are written as names, because the central server mints new',
        'ids. What the load path cannot carry is listed in meta.not_preserved:',
        'created_at/updated_at on records (activity timestamps do survive),',
        'owner, and task status.',
      ].join('\n'),
    )
    .action(async (opts: { out?: string }) => {
      const source = assertLocalSqlite()
      const payload = await localOnly(
        async (db) => await buildPayload(db, source),
      )
      const outPath = opts.out ? resolve(opts.out) : undefined
      if (outPath) {
        try {
          mkdirSync(dirname(outPath), { recursive: true })
        } catch (e) {
          die(
            `migrate export: cannot create ${dirname(outPath)} — ${(e as Error).message}`,
          )
        }
      }
      emit(
        JSON.stringify(payload, null, 2),
        outPath,
        summary(source, payload.meta.counts, outPath),
      )
    })
}
