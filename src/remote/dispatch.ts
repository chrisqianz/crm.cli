/**
 * Thin-client dispatch: routes a command either to the local service layer
 * (direct db access) or to a remote `crm serve` (RPC over TLS).
 *
 * Remote mode is enabled when any of:
 *  1. CRM_SERVER + CRM_TOKEN env are both set (agent/service pattern)
 *  2. --remote flag or [remote] server in config (human/team pattern)
 *
 * In remote mode no local database is ever opened: the CLI renders the
 * server's response locally.
 */
import type { CRMConfig } from '../config'
import { loadConfig } from '../config'
import type { DB } from '../db'
import { openDB } from '../db'
import { auditMeta, auditSnapshot, osUserName, recordAudit } from '../lib/audit'
import { ServiceError } from '../lib/errors'
import { die, gConfig, gDb, gFmt, gInsecure, gRemote } from '../lib/helpers'
import { RpcClient, RpcError } from '../lib/rpc'
import { loadSession } from '../lib/session'
import { METHODS, type MethodDef } from '../service/registry'

interface RemoteEndpoint {
  insecure: boolean
  server: string
}

/** Resolve the remote endpoint, or null for local mode. */
export function remoteEndpoint(): RemoteEndpoint | null {
  const envServer = process.env.CRM_SERVER
  const envToken = process.env.CRM_TOKEN
  const envInsecure =
    process.env.CRM_INSECURE === '1' || process.env.CRM_INSECURE === 'true'

  // 1. Agent pattern: both env vars set → remote, token from env.
  if (envServer && envToken) {
    return { server: envServer, insecure: envInsecure }
  }

  // 2. Explicit opt-in: --remote flag or [remote] server in config.
  const config = loadConfig({ configPath: gConfig, dbPath: gDb, format: gFmt })
  if (gRemote || config.remote.server) {
    const server = envServer || config.remote.server
    if (!server) {
      die(
        'Error: remote mode needs a server address — set [remote] server in config or the CRM_SERVER env var',
      )
    }
    return {
      server,
      insecure: gInsecure || config.remote.insecure || envInsecure,
    }
  }

  // 3. Local mode.
  return null
}

let client: RpcClient | null = null

/** Parse "host:port" (port optional, defaults to 8443). */
function parseServerAddr(server: string): { host: string; port: number } {
  const lastColon = server.lastIndexOf(':')
  if (lastColon === -1) {
    return { host: server, port: 8443 }
  }
  const port = Number(server.slice(lastColon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    die(`Error: invalid server address "${server}" (expected host:port)`)
  }
  return { host: server.slice(0, lastColon), port }
}

async function getRemoteClient(ep: RemoteEndpoint): Promise<RpcClient> {
  if (client) {
    return client
  }
  const { host, port } = parseServerAddr(ep.server)
  const c = await RpcClient.connect(port, host, {
    insecure: ep.insecure,
  })
  const token = process.env.CRM_TOKEN || loadSession()?.token || undefined
  if (!token) {
    c.close()
    die('Error: no token for remote session — run `crm login` or set CRM_TOKEN')
  }
  await c.call('auth.token', { token })
  client = c
  return c
}

/**
 * Run a registry method locally or remotely and return its plain-data
 * result. Errors from either path are printed and exit 1, byte-identical to
 * the legacy `die()` behavior.
 */
export async function dispatch<
  T extends Record<string, unknown> = Record<string, unknown>,
>(method: string, params: Record<string, unknown>): Promise<T> {
  const ep = remoteEndpoint()
  if (ep) {
    const c = await getRemoteClient(ep)
    try {
      return await c.call<T>(method, params)
    } catch (e) {
      if (e instanceof RpcError) {
        // exit 3 = conflict: recoverable, expected in a shared environment
        die(e.message, e.code === 'CONFLICT' ? 3 : 1)
      }
      throw e
    } finally {
      // CLI processes run one command per invocation — release the TLS
      // socket so the event loop can drain and the process exits cleanly.
      c.close()
      client = null
    }
  }

  const { db, config } = await getLocalCtx()
  const def: MethodDef | undefined = METHODS[method]
  if (!def) {
    die(`Error: unknown method "${method}"`)
  }
  // P4: local mode writes to the same audit hash chain (source=cli-local,
  // actor=OS user) with before/after snapshots where the target entity
  // is known.
  const before = def.write
    ? await auditSnapshot(db, config, method, params, null)
    : null
  try {
    const result = (await def.fn(db, config, params)) as T
    if (def.write) {
      const after = await auditSnapshot(db, config, method, params, result)
      const meta = await auditMeta(db, config, method, params, result)
      try {
        await recordAudit(db, {
          action: method,
          actor_id: 'local',
          actor_name: osUserName(),
          source: 'cli-local',
          entity_type: meta.entity_type,
          entity_id: meta.entity_id,
          before_json: before,
          after_json: after,
        })
      } catch {
        // an audit failure must not fail the data write
      }
    }
    return result
  } catch (e) {
    if (e instanceof ServiceError) {
      // exit 3 = conflict: recoverable, expected in a shared environment
      die(e.message, e.code === 'CONFLICT' ? 3 : 1)
    }
    throw e
  }
}

async function getLocalCtx() {
  const config = loadConfig({ configPath: gConfig, dbPath: gDb, format: gFmt })
  const db = await openDB(config.database.path)
  return { config, db, fmt: config.defaults.format }
}

/**
 * Run a method exclusively in local mode (no RPC surface). Errors get the
 * same treatment as `dispatch` (ServiceError → die with exit-code mapping).
 */
export async function localOnly<T extends Record<string, unknown>>(
  fn: (db: DB, config: CRMConfig) => Promise<T>,
): Promise<T> {
  if (isRemote()) {
    die(
      'Error: this command runs on the server host — SSH into the machine that owns the database and run it there',
    )
  }
  const { db, config } = await getLocalCtx()
  try {
    return await fn(db, config)
  } catch (e) {
    if (e instanceof ServiceError) {
      die(e.message, e.code === 'CONFLICT' ? 3 : 1)
    }
    throw e
  }
}

/** Local-mode ctx for commands that still need fmt/config for rendering. */
export function renderCtx() {
  const config = loadConfig({ configPath: gConfig, dbPath: gDb, format: gFmt })
  return { config, fmt: config.defaults.format }
}

/** True when the current invocation targets a remote server. */
export function isRemote(): boolean {
  return remoteEndpoint() !== null
}
