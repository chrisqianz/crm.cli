import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RpcClient } from '../../src/lib/rpc.ts'

export const REPO = join(import.meta.dir, '..', '..')
export const CRM = join(REPO, 'src', 'cli.ts')

export interface TestServer {
  close: () => Promise<void>
  /** Absolute path of the server-side database file */
  dbPath: string
  /** Full stdout+stderr captured from the server process */
  log: () => string
  port: number
  proc: ChildProcess
}

/**
 * Spawn `crm serve` on an auto-assigned port and wait for the READY line.
 * The server prints `READY <port>` to stdout once the TLS listener is up,
 * and `BOOTSTRAP-CODE=<code>` when the users table is empty.
 */
export interface StartServerOptions {
  /** TOML written to a temp file and passed as CRM_CONFIG (trusted config). */
  configBody?: string
  /** Existing config file to pass as CRM_CONFIG (trusted config). */
  configPath?: string
  /**
   * Run the server with this cwd and leave CRM_CONFIG unset, so the server
   * resolves its config by walking up from `cwd` — the semi-trusted
   * project-config path (see test/enterprise/config-trust.test.ts).
   */
  cwd?: string
  /** Extra environment for the server process (merged over process.env). */
  env?: Record<string, string>
}

export async function startServer(
  dbPath: string,
  opts?: StartServerOptions,
): Promise<TestServer> {
  let configPath = opts?.configPath
  if (opts?.configBody !== undefined) {
    configPath = join(
      mkdtempSync(join(tmpdir(), 'crm-serve-cfg-')),
      'server.toml',
    )
    writeFileSync(configPath, opts.configBody)
  }
  const { CRM_CONFIG: _explicitConfig, ...baseEnv } = process.env
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    NO_COLOR: '1',
    ...(opts?.env ?? {}),
  }
  if (!opts?.cwd) {
    // /dev/null-ish: an unset path would let the server pick up whatever
    // crm.toml sits above the repo (or create ~/.crm/config.toml). With a
    // cwd given, CRM_CONFIG must stay *absent* — project-config discovery
    // only happens when nothing explicitly selects a file.
    env.CRM_CONFIG = configPath ?? ''
  }
  const proc = spawn(
    'bun',
    ['run', CRM, 'serve', '--port', '0', '--db', dbPath],
    {
      cwd: opts?.cwd ?? REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  )
  let out = ''
  let err = ''
  proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
  proc.stderr?.on('data', (c: Buffer) => (err += c.toString()))

  const port = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000)
    const tick = setInterval(() => {
      const m = out.match(/READY\s+(\d+)/)
      if (m) {
        clearInterval(tick)
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    }, 50)
    proc.on('exit', () => {
      clearInterval(tick)
      clearTimeout(timer)
      resolve(null)
    })
  })
  if (port === null) {
    proc.kill()
    throw new Error(
      `serve did not become ready.\nstdout: ${out}\nstderr: ${err}`,
    )
  }

  return {
    port,
    proc,
    dbPath,
    log: () => out + err,
    close: async () => {
      proc.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((r) => {
          proc.on('exit', () => r())
        }),
        new Promise<void>((r) => setTimeout(() => r(), 3000)),
      ])
      try {
        proc.kill('SIGKILL')
      } catch {
        // already dead
      }
    },
  }
}

export function bootstrapCodeOf(server: TestServer): string {
  const m = server.log().match(/BOOTSTRAP-CODE=(\S+)/)
  if (!m) {
    throw new Error(`no bootstrap code in server log:\n${server.log()}`)
  }
  return m[1]
}

export interface Owner {
  password: string
  token: string
  username: string
}

/** Connect and run auth.bootstrap to create the owner. Returns credentials. */
export async function bootstrapOwner(
  server: TestServer,
  username = 'admin',
): Promise<Owner> {
  const code = bootstrapCodeOf(server)
  const client = await RpcClient.connect(server.port, '127.0.0.1', {
    insecure: true,
  })
  try {
    const { token, user } = await client.call<{
      token: string
      user: { username: string; role: string }
    }>('auth.bootstrap', {
      code,
      username,
      password: 'Owner-pass-123',
      display_name: 'Admin',
    })
    if (user.role !== 'owner') {
      throw new Error(`bootstrap user role is ${user.role}, expected owner`)
    }
    return { token, username, password: 'Owner-pass-123' }
  } finally {
    client.close()
  }
}

export async function connect(
  port: number,
  token?: string,
): Promise<RpcClient> {
  // Tests talk to a server with the auto-generated self-signed cert, so
  // verification is skipped (production clients use CA certs or --insecure).
  const client = await RpcClient.connect(port, '127.0.0.1', { insecure: true })
  if (token) {
    await client.call('auth.token', { token })
  }
  return client
}

/**
 * Fresh temp dir holding a database file. Returns the db path and a cleanup.
 */
export function freshDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'crm-serve-test-'))
  const dbPath = join(dir, 'serve.db')
  return {
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
