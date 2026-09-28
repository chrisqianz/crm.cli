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
import { loadConfig } from '../config'
import { openDB } from '../db'
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
  try {
    return (await def.fn(db, config, params)) as T
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

/** Local-mode ctx for commands that still need fmt/config for rendering. */
export function renderCtx() {
  const config = loadConfig({ configPath: gConfig, dbPath: gDb, format: gFmt })
  return { config, fmt: config.defaults.format }
}

/** True when the current invocation targets a remote server. */
export function isRemote(): boolean {
  return remoteEndpoint() !== null
}
