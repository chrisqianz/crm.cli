/**
 * Schema upgrades from pre-P9 databases. The migrateSchema fast path must
 * key on schema SHAPE, not emptiness: an old database whose tables happen
 * to be empty still needs the new-column ALTERs. The previous "no rows
 * anywhere → skip" heuristic left such databases without `contacts.owner`,
 * so the very first `crm contact add` after upgrading crashed on an
 * unknown column.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createClient } from '@libsql/client'

import { createTestContext } from './helpers.ts'

const OLD_SCHEMA = readFileSync(
  join(import.meta.dir, 'fixtures', 'schema-pre-p9.sql'),
  'utf8',
)

/** Create the db file with the previous release's exact schema. */
async function seedPreP9(dbPath: string, seedContact = false): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    for (const stmt of OLD_SCHEMA.split(';')) {
      if (stmt.trim() !== '') {
        await client.execute(stmt)
      }
    }
    if (seedContact) {
      await client.execute(
        `INSERT INTO contacts (id, name, created_at, updated_at)
         VALUES ('ct_pregen', 'Legacy Row', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
    }
  } finally {
    client.close()
  }
}

async function columns(dbPath: string, table: string): Promise<string[]> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const r = await client.execute(`PRAGMA table_info(${table})`)
    const idx = r.columns.indexOf('name')
    return r.rows.map((row) => String((row as unknown as unknown[])[idx]))
  } finally {
    client.close()
  }
}

describe('pre-P9 schema upgrade', () => {
  test('an empty pre-P9 db gains owner and accepts its first writes', async () => {
    const ctx = createTestContext()
    await seedPreP9(ctx.dbPath)

    // Before the fix these crash: the migrateSchema emptiness fast path
    // skips the owner ALTER because the old tables contain no rows.
    ctx.runOK('contact', 'add', '--name', 'First', '--email', 'first@upg.test')
    ctx.runOK('deal', 'add', 'After upgrade', '--stage', 'qualified')
    ctx.runOK('task', 'add', 'Post-upgrade follow-up')

    expect(await columns(ctx.dbPath, 'contacts')).toContain('owner')
    expect(await columns(ctx.dbPath, 'deals')).toContain('owner')
    const listed = ctx.runJSON<Record<string, unknown>[]>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(listed.length).toBe(1)
  })

  test('a populated pre-P9 db keeps its rows and gains owner', async () => {
    const ctx = createTestContext()
    await seedPreP9(ctx.dbPath, true)

    const listed = ctx.runJSON<Record<string, unknown>[]>(
      'contact',
      'list',
      '--format',
      'json',
    )
    expect(listed.length).toBe(1)
    expect(listed[0].name).toBe('Legacy Row')

    ctx.runOK('contact', 'edit', 'Legacy Row', '--owner', 'lin')
    const shown = ctx.runJSON<Record<string, unknown>>(
      'contact',
      'show',
      'Legacy Row',
      '--format',
      'json',
    )
    expect(shown.owner).toBe('lin')
  })
})
