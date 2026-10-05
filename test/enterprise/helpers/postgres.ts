/**
 * Postgres test infrastructure (AL-1, spec/alignment.md §3).
 *
 * A single long-lived `postgres:16` container is shared by every test file:
 * pulling and booting the image per file would dominate the suite's runtime,
 * and the data inside is throwaway. Isolation happens one level up — each
 * test gets its OWN database inside that container, created and dropped
 * around the test, so no test can see another's rows (or a previous run's).
 *
 * Two escape hatches:
 * - `CRM_TEST_PG_URL` points at an externally managed server. The helper then
 *   does NOT touch docker at all; it still creates a per-test database there.
 * - No docker and no `CRM_TEST_PG_URL` → `postgresAvailable()` is false and
 *   the pg suite skips cleanly (CI must not go red because a laptop has no
 *   docker daemon; the docker-free parity gate in schema-parity.test.ts is
 *   what actually protects the schema).
 */
import { spawnSync } from 'node:child_process'

import { Client } from 'pg'
import { ulid } from 'ulid'

const CONTAINER = 'crm-test-pg'
/** Admin database the helper connects to in order to CREATE/DROP DATABASE. */
const ADMIN_DB = 'crm_test'
const PG_USER = 'crm'
const PG_PASSWORD = 'crm'
const PG_PORT = 54_321

/** Operator-provided server; when set, docker is never consulted. */
const EXTERNAL_URL = process.env.CRM_TEST_PG_URL

export const PG_TEST_URL_BASE = EXTERNAL_URL
  ? new URL(EXTERNAL_URL)
  : new URL(
      `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${ADMIN_DB}`,
    )

function docker(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  return {
    code: r.status ?? -1,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
  }
}

function dockerUsable(): boolean {
  if (EXTERNAL_URL) {
    return true
  }
  const probe = docker(['version', '--format', '{{.Server.Version}}'])
  return probe.code === 0
}

/**
 * Cached at module load: `describe.skipIf` evaluates its condition while the
 * file is being collected, so the probe cannot be async.
 */
let available: boolean | null = null

export function postgresAvailable(): boolean {
  if (available === null) {
    available = dockerUsable()
  }
  return available
}

function containerRunning(): boolean {
  const r = docker([
    'inspect',
    '-f',
    '{{.State.Running}}',
    '-f',
    '{{.State.Status}}',
    CONTAINER,
  ])
  return r.code === 0 && r.out.includes('true') && r.out.includes('running')
}

function waitForReady(timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // -d matters: without it pg_isready dials the database named after the
    // user, which does not exist here, so the probe reports the server down
    // while it is up (and fills the postmaster log with FATAL noise).
    const r = docker([
      'exec',
      CONTAINER,
      'pg_isready',
      '-U',
      PG_USER,
      '-d',
      ADMIN_DB,
      '-q',
    ])
    if (r.code === 0) {
      return true
    }
    spawnSync('sleep', ['0.5'])
  }
  return false
}

/**
 * Start the shared container if needed. Called from inside tests (not module
 * scope) so a cold first run gets the test's own generous timeout rather than
 * bun's 5s default.
 */
export function ensurePostgres(): void {
  if (!postgresAvailable()) {
    throw new Error(
      'postgres tests need docker (or set CRM_TEST_PG_URL to a postgres server)',
    )
  }
  if (EXTERNAL_URL) {
    return
  }
  if (containerRunning()) {
    if (!waitForReady(60_000)) {
      throw new Error(
        `postgres container ${CONTAINER} is not accepting queries`,
      )
    }
    return
  }
  // The container exists but is stopped: Docker Desktop on macOS reaps idle
  // containers, and the volume survives that. Start it again rather than
  // tearing it down — `rm -f` would throw away the data directory and turn a
  // two-second restart into a full initdb on every run.
  if (docker(['inspect', CONTAINER]).code === 0) {
    if (docker(['start', CONTAINER]).code === 0 && waitForReady(60_000)) {
      return
    }
    // A container that will not come back is usually one built from an older
    // image or a broken config; recreate it so the suite is not wedged.
    docker(['rm', '-f', CONTAINER])
  }
  // No container at all (or the one we had is unrecoverable): create it so
  // `docker run` does not fail on a name collision.
  const run = docker([
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-e',
    `POSTGRES_USER=${PG_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${ADMIN_DB}`,
    '-p',
    `127.0.0.1:${PG_PORT}:5432`,
    'postgres:16',
  ])
  if (run.code !== 0) {
    throw new Error(`docker run failed: ${run.err.slice(0, 300)}`)
  }
  // A cold image pull happens inside `docker run` and can take minutes; this
  // is why the first test in the file carries a large timeout.
  if (!waitForReady(240_000)) {
    throw new Error(`postgres container ${CONTAINER} never became ready`)
  }
}

/**
 * CREATE/DROP DATABASE takes an identifier, and identifiers cannot be bind
 * parameters, so the name is validated against a strict shape instead of
 * quoted-and-hoped. Only this function's own ulid-derived names pass, which
 * also means the helper can never be pointed at a database it does not own.
 */
function databaseIdentifier(value: string): string {
  if (!/^crm_t_[0-9a-z]{1,40}$/.test(value)) {
    throw new Error(
      `refusing to run DDL against unsafe database name: ${value}`,
    )
  }
  return value
}

/**
 * A fresh, empty database for one test. Distinct databases are what make the
 * DDL-bootstrap and memoization tests meaningful — reusing a database would
 * let a leftover schema hide a missing CREATE TABLE.
 */
export async function createTestDatabase(): Promise<string> {
  ensurePostgres()
  const name = databaseIdentifier(`crm_t_${ulid().toLowerCase()}`)
  const base = PG_TEST_URL_BASE
  const admin = new Client({
    host: base.hostname,
    port: base.port ? Number(base.port) : 5432,
    user: decodeURIComponent(base.username),
    password: decodeURIComponent(base.password ?? ''),
    database: base.pathname.slice(1) || ADMIN_DB,
  })
  await admin.connect()
  try {
    // CREATE/DROP DATABASE cannot run inside a transaction.
    const statement = `CREATE DATABASE ${name}`
    await admin.query(statement)
  } finally {
    await admin.end()
  }
  const url = new URL(base.toString())
  url.pathname = `/${name}`
  return url.toString()
}

/**
 * DROP refuses while a connection is open, and every pool the test created is
 * a connection — so backends are terminated first. The caller is expected to
 * have released its own pools (`closeDatabase`); this catches the rest.
 */
export async function dropTestDatabase(url: string): Promise<void> {
  const target = new URL(url)
  const name = databaseIdentifier(target.pathname.slice(1))
  const admin = new Client({
    host: target.hostname,
    port: target.port ? Number(target.port) : 5432,
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password ?? ''),
    database: PG_TEST_URL_BASE.pathname.slice(1) || ADMIN_DB,
  })
  await admin.connect()
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    )
    const statement = `DROP DATABASE IF EXISTS ${name}`
    await admin.query(statement)
  } finally {
    await admin.end()
  }
}
