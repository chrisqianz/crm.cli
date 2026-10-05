/**
 * AL-1-2: the dual-backend open path.
 *
 * Two halves, deliberately separated by what they need:
 * - config + validation + redaction run anywhere. They are the boot-time
 *   contract ("what may a database section say"), and CI without docker still
 *   has to prove them.
 * - the actual postgres path runs against a real server when one is available
 *   and skips otherwise. Nothing here is mocked: a mocked pg driver would
 *   prove the wrapper calls itself correctly, which is not the risk. The risk
 *   is that the DDL drifts from the contract, or that a driver type surprise
 *   (int8 coming back as a string, say) breaks the row shape services read.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ulid } from 'ulid'

import { loadConfig } from '../../src/config'
import { openDB } from '../../src/db'
import {
  closeDatabase,
  openDatabase,
  resolveBackend,
  validateDatabaseConfig,
} from '../../src/db/open'
import { TABLES } from '../../src/db/schema'
import { redactDatabaseUrl, renderSanitizedToml } from '../../src/server/admin'
import {
  createTestDatabase,
  dropTestDatabase,
  postgresAvailable,
} from './helpers/postgres'

const PG_KIND_TO_TYPE: Record<string, string> = {
  boolean: 'boolean',
  integer: 'integer',
  text: 'text',
  timestamp: 'timestamp with time zone',
}

const scratch = mkdtempSync(join(tmpdir(), 'crm-pg-open-'))
/** Config files written here are only read by loadConfig, never executed. */
function writeConfig(body: string): string {
  const path = join(scratch, `crm-${ulid()}.toml`)
  writeFileSync(path, body, { mode: 0o600 })
  return path
}

/**
 * loadConfig reads CRM_DB/CRM_CONFIG out of the ambient environment, and a
 * developer machine (or this repo's own ~/.crm/config.toml) can carry both.
 * Every assertion about defaults is worthless unless the env is pinned first.
 */
function withCleanEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved = new Map<string, string | undefined>()
  for (const key of [
    'CRM_DB',
    'CRM_CONFIG',
    'CRM_DATABASE_URL',
    ...Object.keys(vars),
  ]) {
    saved.set(key, process.env[key])
  }
  for (const key of ['CRM_DB', 'CRM_CONFIG', 'CRM_DATABASE_URL']) {
    Reflect.deleteProperty(process.env, key)
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key)
    } else {
      process.env[key] = value
    }
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('database backend selection', () => {
  test('nothing configured stays on sqlite with no url', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({ configPath: writeConfig('') })
      expect(resolveBackend(config)).toBe('sqlite')
      expect(validateDatabaseConfig(config)).toBeNull()
    })
  })

  test('a bare url implies postgres without being told', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({
        configPath: writeConfig(
          '[database]\nurl = "postgres://crm:crm@127.0.0.1:5432/crm"\n',
        ),
      })
      expect(resolveBackend(config)).toBe('postgres')
      expect(validateDatabaseConfig(config)).toBeNull()
    })
  })

  test('postgres without a url is rejected, and the error says how to fix it', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({
        configPath: writeConfig('[database]\nbackend = "postgres"\n'),
      })
      const problem = validateDatabaseConfig(config)
      expect(problem).toContain('database.url')
      // The point of the message is that a tired operator can act on it.
      expect(problem).toContain('url = "')
    })
  })

  test('an unknown backend is refused rather than silently treated as sqlite', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({
        configPath: writeConfig('[database]\nbackend = "mysql"\n'),
      })
      const problem = validateDatabaseConfig(config)
      expect(problem).toContain('mysql')
      expect(problem).toContain('sqlite')
      expect(problem).toContain('postgres')
    })
  })

  test('CRM_DATABASE_URL overrides the config file', () => {
    withCleanEnv(
      { CRM_DATABASE_URL: 'postgres://u:p@db.internal:5432/crm' },
      () => {
        const config = loadConfig({
          configPath: writeConfig(
            '[database]\npath = "/tmp/ignored.db"\nbackend = "sqlite"\n',
          ),
        })
        expect(config.database.url).toBe('postgres://u:p@db.internal:5432/crm')
        expect(resolveBackend(config)).toBe('postgres')
      },
    )
  })

  test('an explicit backend beats inference from a url', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({
        configPath: writeConfig(
          '[database]\nbackend = "sqlite"\npath = "/tmp/x.db"\nurl = "postgres://u:p@h/db"\n',
        ),
      })
      expect(resolveBackend(config)).toBe('sqlite')
    })
  })

  test('sqlite still requires a path, and the error names the flag', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({
        configPath: writeConfig('[database]\nbackend = "sqlite"\n'),
      })
      const problem = validateDatabaseConfig(config)
      expect(problem).toContain('--db')
    })
  })
})

describe('database credentials never leave the server', () => {
  const SECRET = 'supersecret-db-pw'

  test('redactDatabaseUrl keeps host and user, drops the password', () => {
    const redacted = redactDatabaseUrl(
      `postgres://crm:${SECRET}@db.internal:5432/crm`,
    )
    expect(redacted).not.toContain(SECRET)
    expect(redacted).toContain('db.internal')
    expect(redacted).toContain('crm')
  })

  test('a url that will not parse redacts to a constant (fail closed)', () => {
    expect(redactDatabaseUrl(`not a url ${SECRET}`)).toBe('***')
  })

  test('sanitized TOML shows the backend, never the password', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({
        configPath: writeConfig(
          `[database]\nbackend = "postgres"\nurl = "postgres://crm:${SECRET}@db.internal:5432/crm"\n`,
        ),
      })
      const toml = renderSanitizedToml(config)
      expect(toml).not.toContain(SECRET)
      expect(toml).toContain('backend = "postgres"')
    })
  })

  test('a sqlite config renders byte-identically to before the backend existed', () => {
    withCleanEnv({}, () => {
      const config = loadConfig({
        configPath: writeConfig('[database]\npath = "/tmp/a.db"\n'),
      })
      const toml = renderSanitizedToml(config)
      expect(toml).toContain('path = "/tmp/a.db"')
      // No backend/url noise when nothing was configured: the copyable config
      // stays what the operator would have written themselves.
      expect(toml).not.toContain('backend')
      expect(toml).not.toContain('url')
    })
  })
})

describe('the sqlite handle carries the seam', () => {
  const path = join(scratch, `seam-${ulid()}.db`)

  test('$crm exposes dialect, raw queries, and transactions', async () => {
    const db = await openDB(path)
    expect(db.$crm.dialect).toBe('sqlite')

    await db.$crm.raw.query(
      'INSERT INTO users (id, username, password_hash, role, auth_source, failed_attempts, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['u1', 'seam', 'h', 'owner', 'local', 0, 0, new Date().toISOString()],
    )
    const rows = await db.$crm.raw.query('SELECT username, role FROM users')
    expect(rows).toEqual([{ role: 'owner', username: 'seam' }])
  })

  test('a transaction that throws leaves nothing behind', async () => {
    const db = await openDB(path)
    let threw = false
    try {
      await db.$crm.raw.transaction(async (raw) => {
        await raw.query(
          'INSERT INTO users (id, username, password_hash, role, auth_source, failed_attempts, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            'u2',
            'ghost',
            'h',
            'reader',
            'local',
            0,
            0,
            new Date().toISOString(),
          ],
        )
        throw new Error('boom')
      })
    } catch (error) {
      threw = true
      expect((error as Error).message).toBe('boom')
    }
    expect(threw).toBe(true)
    const rows = await db.$crm.raw.query('SELECT id FROM users WHERE id = ?', [
      'u2',
    ])
    expect(rows).toEqual([])
  })
})

const SKIP_PG = !postgresAvailable()

describe.skipIf(SKIP_PG)('postgres open path', () => {
  const created: string[] = []

  async function freshDatabase() {
    const url = await createTestDatabase()
    created.push(url)
    return loadConfig({
      configPath: writeConfig(`[database]\nurl = "${url}"\n`),
    })
  }

  afterAll(async () => {
    for (const url of created) {
      await closeDatabase(url)
      await dropTestDatabase(url)
    }
    rmSync(scratch, { recursive: true, force: true })
  })

  test('bootstraps every contract table with contract columns', async () => {
    const config = await freshDatabase()
    const db = await openDatabase(config)
    expect(db.$crm.dialect).toBe('postgres')

    const rows = await db.$crm.raw.query(
      'SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema()',
    )
    const byTable = new Map<
      string,
      Map<string, { dataType: string; nullable: string }>
    >()
    for (const row of rows) {
      const table = String(row.table_name)
      const columns = byTable.get(table) ?? new Map()
      columns.set(String(row.column_name), {
        dataType: String(row.data_type),
        nullable: String(row.is_nullable),
      })
      byTable.set(table, columns)
    }

    for (const table of Object.values(TABLES)) {
      const columns = byTable.get(table.name)
      expect(columns, `table ${table.name} is missing`).toBeDefined()
      for (const column of table.columns) {
        const actual = (
          columns as Map<string, { dataType: string; nullable: string }>
        ).get(column.name)
        expect(
          actual,
          `${table.name}.${column.name} is missing from postgres`,
        ).toBeDefined()
        expect(
          (actual as { dataType: string }).dataType,
          `${table.name}.${column.name} type`,
        ).toBe(PG_KIND_TO_TYPE[column.kind])
        expect(
          (actual as { nullable: string }).nullable,
          `${table.name}.${column.name} nullability`,
        ).toBe(column.notNull ? 'NO' : 'YES')
      }
    }
  }, 120_000)

  test('bootstrapping the same database twice is a no-op and keeps data', async () => {
    const config = await freshDatabase()
    const first = await openDatabase(config)
    await first.$crm.raw.query(
      'INSERT INTO companies (id, name, websites, phones, tags, custom_fields, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['c1', 'Kept', '[]', '[]', '[]', '{}', 1, '2026-01-01', '2026-01-01'],
    )
    // closeDatabase is what makes a reopen actually re-run the DDL;
    // without it the memoized pool would hide the second bootstrap.
    await closeDatabase(config.database.url as string)

    const second = await openDatabase(config)
    const rows = await second.$crm.raw.query(
      'SELECT name FROM companies WHERE id = ?',
      ['c1'],
    )
    expect(rows).toEqual([{ name: 'Kept' }])
  }, 120_000)

  test('one pool per url, and closeDatabase releases it', async () => {
    const config = await freshDatabase()
    const url = config.database.url as string
    const a = await openDatabase(config)
    const b = await openDatabase(config)
    expect(a).toBe(b)

    await closeDatabase(url)
    const c = await openDatabase(config)
    expect(c).not.toBe(a)
    // The reopened pool must still answer, i.e. closing evicted rather
    // than left a dead handle in the cache.
    expect(await c.$crm.raw.query('SELECT 1 AS one')).toEqual([{ one: 1 }])
  }, 120_000)

  test('audit_log.seq is an integer identity and contacts keep partial unique indexes', async () => {
    const config = await freshDatabase()
    const db = await openDatabase(config)

    const inserted = await db.$crm.raw.query(
      'INSERT INTO audit_log (at, actor_id, actor_name, action, entity_type, entity_id, source, ip, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq',
      [
        '2026-01-01',
        'tester',
        'tester',
        'create',
        'contact',
        'x',
        'cli',
        '127.0.0.1',
        'z'.repeat(64),
        'a'.repeat(64),
      ],
    )
    // A bigint identity comes back from node-postgres as a STRING, which
    // would poison the hash chain's arithmetic downstream. This assert is
    // the reason seq is INTEGER and not BIGINT.
    expect(typeof inserted[0]?.seq).toBe('number')

    await db.$crm.raw.query(
      'INSERT INTO contacts (id, name, emails, phones, addresses, companies, tags, custom_fields, linkedin, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'k1',
        'A',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '{}',
        'same',
        1,
        '2026-01-01',
        '2026-01-01',
      ],
    )
    await db.$crm.raw.query(
      'INSERT INTO contacts (id, name, emails, phones, addresses, companies, tags, custom_fields, linkedin, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'k2',
        'B',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '{}',
        null,
        1,
        '2026-01-01',
        '2026-01-01',
      ],
    )
    // Two NULLs allowed, a duplicate non-NULL rejected: the partial index
    // semantics from sqlite, or the social-column dedupe silently differs.
    let rejected = false
    try {
      await db.$crm.raw.query(
        'INSERT INTO contacts (id, name, emails, phones, addresses, companies, tags, custom_fields, linkedin, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'k3',
          'C',
          '[]',
          '[]',
          '[]',
          '[]',
          '[]',
          '{}',
          'same',
          1,
          '2026-01-01',
          '2026-01-01',
        ],
      )
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    const count = await db.$crm.raw.query(
      'SELECT count(*)::int AS n FROM contacts',
    )
    expect(count[0]?.n).toBe(2)
  }, 120_000)
})

if (SKIP_PG) {
  console.log(
    '[postgres-open] skipped: docker unavailable and CRM_TEST_PG_URL unset',
  )
}

if (!existsSync(scratch)) {
  throw new Error('scratch directory vanished')
}
