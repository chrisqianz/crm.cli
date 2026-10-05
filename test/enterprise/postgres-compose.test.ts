/**
 * AL-1-8: the compose stack is the documented way to run a central server.
 *
 * These are static assertions, not an integration run. `docker compose up`
 * needs a daemon, a base-image pull and a minute of boot time — too slow and
 * too host-dependent for a gate, and it proves nothing the parsed config
 * cannot: that the file is valid, that the database is the version we support,
 * that the server is told to talk to it, and that something watches the
 * database before the server is allowed to start.
 *
 * The wire between the two services is what deserves the noise. A compose file
 * that boots happily with the server on a SQLite file is exactly the failure
 * AL-1 exists to remove: it looks healthy and quietly runs the wrong database.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const COMPOSE_FILE = join(ROOT, 'docker-compose.yml')

/** Connection string the server must be handed to reach the compose database. */
const DATABASE_URL = 'postgres://crm:crm@postgres:5432/crm'

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/**
 * `docker compose config` is the validator: it parses, interpolates and merges,
 * and refuses a malformed file. It needs the CLI plugin but not a running
 * daemon, so the skip condition probes the plugin.
 */
function composeCliUsable(): boolean {
  const probe = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
  })
  return (probe.status ?? -1) === 0
}

const NO_COMPOSE_CLI = !composeCliUsable()

function composeConfig(): { code: number; out: string; err: string } {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'config'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return {
    code: r.status ?? -1,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
  }
}

describe('compose stack', () => {
  test('the compose file exists', () => {
    expect(existsSync(COMPOSE_FILE)).toBe(true)
  })

  test.skipIf(NO_COMPOSE_CLI)('docker compose config accepts the file', () => {
    const { code, err } = composeConfig()
    // The parser's own message is the diagnosis; a bare non-zero exit is not.
    expect({ code, err: err.trim().slice(0, 400) }).toEqual({
      code: 0,
      err: '',
    })
  })

  test.skipIf(NO_COMPOSE_CLI)('the database is postgres:16', () => {
    const { out } = composeConfig()
    expect(out).toMatch(/image: '?postgres:16'?/)
    // Pinned to a major, not `latest`: an unpinned central database is a
    // surprise upgrade of the one component that cannot be replayed.
    expect(out).not.toMatch(/image: '?postgres:latest'?/)
  })

  test.skipIf(NO_COMPOSE_CLI)('the server is told to use that database', () => {
    const { out } = composeConfig()
    expect(out).toContain(`CRM_DATABASE_URL: ${DATABASE_URL}`)
  })

  test.skipIf(NO_COMPOSE_CLI)(
    'the server waits for a real readiness probe',
    () => {
      const { out } = composeConfig()
      expect(out).toMatch(/healthcheck:/)
      expect(out).toMatch(/pg_isready/)
      // Waiting on a healthcheck, not on "the container started": postgres
      // answers connections briefly before it can actually serve them.
      expect(out).toMatch(/condition: service_healthy/)
    },
  )

  test('the stack builds from this checkout', () => {
    const src = read('docker-compose.yml')
    expect(src).toMatch(/^ {4}build: \.$/m)
    // The image alone is not the release: the console and both health routes
    // need the admin port, so the stack starts it explicitly.
    expect(src).toMatch(/--admin-port/)
  })

  test('both public surfaces are published', () => {
    const src = read('docker-compose.yml')
    // 8443 is the TLS RPC port clients dial; 8580 is the admin console, which
    // is plaintext by design and therefore stays on loopback.
    expect(src).toMatch(/- "?8443:8443"?/)
    expect(src).toMatch(/- "?127\.0\.0\.1:8580:8580"?/)
  })

  test('the database keeps its data in a named volume', () => {
    const src = read('docker-compose.yml')
    expect(src).toMatch(/crm-pgdata:\/var\/lib\/postgresql\/data/)
    expect(src).toMatch(/^volumes:$/m)
    // The dev/offline SQLite path stays mounted too, so the same file works
    // when [database] is switched back to a file.
    expect(src).toMatch(/crm-data:\/data/)
  })

  test('outbound mail is opt-in behind a profile', () => {
    const src = read('docker-compose.yml')
    // A stack that silently starts a relay nobody configured is a surprise
    // SMTP server; a profile means `--profile mail` is a deliberate act.
    expect(src).toMatch(/mailpit:[^\n]*\n(?:.*\n){0,4}\s*profiles: \["mail"\]/)
    // Reachable by the server by name on the compose network, which is the
    // whole point of putting it in the file rather than telling people to run
    // it separately.
    expect(src).toMatch(/mailpit:1025/)
    // ...and its UI, which retains every message it accepted, stays loopback.
    expect(src).toMatch(/127\.0\.0\.1:8025:8025/)
  })

  test('no backup destination is configured for the postgres backend', () => {
    // Litestream copies SQLite files and a pg dump tool is AL-8, so a compose
    // stack that set [backup] destination would refuse to boot at all.
    const src = read('docker-compose.yml')
    expect(src).not.toMatch(/destination/)
    expect(src).not.toMatch(/litestream/i)
  })

  test('the docs point at the stack', () => {
    expect(read('README.md')).toMatch(/docker compose up/)
    expect(read('spec/enterprise.md')).toMatch(/docker-compose\.yml/)
    expect(read('Dockerfile')).toMatch(/CRM_DATABASE_URL/)
  })

  test('the systemd unit is labelled as the single-node path', () => {
    // AL-1 made Postgres the centre; the unit is still valid, just not the
    // centre any more. The comment is what stops someone reading it as advice.
    expect(read('deploy/crm.service')).toMatch(/dev|offline|single-node/i)
    expect(read('deploy/crm.service')).toMatch(/postgres/i)
  })
})
