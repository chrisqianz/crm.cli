/**
 * Mode contract (spec/client-repl.md A1) — how `remoteEndpoint()` resolves:
 *  1. CRM_SERVER + CRM_TOKEN env are both set → remote (agent/service pattern)
 *  2. --remote flag or [remote] server in config → remote (explicit opt-in)
 *  3. explicit local intent → local: --db always names a database and beats a
 *     saved session; --local / CRM_LOCAL=1 are an opt-out that additionally
 *     needs a nameable database (from --db, CRM_DB or config [database])
 *  4. a saved session from `crm login` → remote; otherwise a [database] path
 *     the user wrote into their own config → local
 *  5. nothing named a target → fail. There is no implicit local mode and no
 *     database path is ever invented: a data command says NOT_CONNECTED
 *     (`remoteEndpoint`), a host command says NEEDS_DB (`localOnly`,
 *     `dispatchHost`) — spec/client-repl.md A1/A2.
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
import {
  die,
  gConfig,
  gDb,
  gFmt,
  gInsecure,
  gLocal,
  gRemote,
} from '../lib/helpers'
import { RpcClient, RpcError } from '../lib/rpc'
import { loadSession } from '../lib/session'
import { METHODS, type MethodDef } from '../service/registry'

interface RemoteEndpoint {
  insecure: boolean
  server: string
}

/**
 * Fixed error copy — tests assert these strings verbatim (spec/client-repl.md
 * A1/A2). Two distinct failures: a client with nowhere to send the request,
 * and a command that runs where the database lives but cannot name it.
 */
export const NOT_CONNECTED =
  "Error: not connected — run 'crm login <server>' (get the server address from your admin console), or use --local/--db for the server host"
export const NEEDS_DB =
  'Error: server-host command — needs --db or a [database] path in your config'

/**
 * Prefix of the stderr note `dispatch()` prints when local mode wins while a
 * session is live (step 3 beating step 4): the user is about to write a
 * database that is not the one they logged in to. Exported, and asserted by
 * test/enterprise/mode-contract.test.ts, so the sentence lives in exactly one
 * place. The server and username are interpolated after it.
 */
export const LOCAL_MODE_NOTE = 'note: local mode — you are logged in to'

/**
 * Fixed copy for a command that shells out on the database host while the
 * invocation targets a remote server. Lives here next to the other two
 * contract messages so `requireLocalHost()` and `localOnly()` cannot drift.
 */
export const SERVER_HOST_ONLY =
  'Error: this command runs on the server host — SSH into the machine that owns the database and run it there'

/**
 * `resolveEndpoint()` returns a remote endpoint, `null` for local mode, or
 * `'unresolved'` when nothing named a server *or* a database. Which fixed
 * error that last case becomes depends on the class of command asking — A1's
 * NOT_CONNECTED for a data command, A2's NEEDS_DB for a host command — so the
 * error stays in the callers and the resolution order stays in one place.
 */
type Resolution = RemoteEndpoint | 'unresolved' | null

/**
 * The resolution order from the header, shared by `remoteEndpoint` (data
 * commands), `dispatchHost` (dual-mode host commands), `isRemote` and
 * therefore `localOnly`. May die on an inconsistency the user has to resolve
 * (CRM_SERVER vs the logged-in server, --local with nothing to point at).
 */
function resolveEndpoint(): Resolution {
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

  // 3. Explicit local intent beats a saved session (that is what --db has
  //    always done). --db is already merged into config.database.path by
  //    loadConfig, so it names a database by definition; --local/CRM_LOCAL
  //    are a switch, not a target, and fail when nothing names the database.
  if (gDb) {
    return null
  }
  const forcedLocal =
    gLocal || process.env.CRM_LOCAL === '1' || process.env.CRM_LOCAL === 'true'
  if (forcedLocal) {
    if (!config.database.path) {
      die(NOT_CONNECTED)
    }
    return null
  }

  // 4. A saved session implies its server; with no session, local mode means
  //    a [database] path the user declared in their own config.
  const sess = loadSession()
  if (sess?.server && sess.token) {
    if (envServer && envServer !== sess.server) {
      die(
        `Error: CRM_SERVER (${envServer}) does not match the logged-in server (${sess.server}) — log in to ${envServer}, unset CRM_SERVER, or use --local`,
      )
    }
    return {
      server: sess.server,
      insecure: envInsecure || sess.insecure === true,
    }
  }
  if (config.database.path) {
    return null
  }

  // 5. No server, no login, no declared database: there is no implicit local
  //    mode, so the caller reports the failure its command class owes the
  //    user instead of inventing a database to create.
  return 'unresolved'
}

/**
 * Resolve the remote endpoint for a data command, or null for local mode.
 * A data command with nowhere to send the request dies with NOT_CONNECTED
 * (spec/client-repl.md A1, step 5) before any database is opened.
 */
export function remoteEndpoint(): RemoteEndpoint | null {
  const resolved = resolveEndpoint()
  if (resolved === 'unresolved') {
    die(NOT_CONNECTED)
  }
  return resolved
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
  const sess = loadSession()
  if (
    sess?.server &&
    (gLocal ||
      gDb ||
      process.env.CRM_LOCAL === '1' ||
      process.env.CRM_LOCAL === 'true')
  ) {
    console.error(
      `${LOCAL_MODE_NOTE} ${sess.server} as ${sess.username || '(unknown)'}; use --remote (or drop --local) to target the server`,
    )
  }
  try {
    // The before-snapshot resolves the target entity; an ambiguous ref
    // throws CONFLICT here, so it lives inside the same try/catch that
    // maps ServiceError → exit code (exit 3 for conflicts).
    const before = def.write
      ? await auditSnapshot(db, config, method, params, null)
      : null
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
  if (!config.database.path) {
    die(NEEDS_DB)
  }
  const db = await openDB(config.database.path)
  return { config, db, fmt: config.defaults.format }
}

/**
 * The two guards `localOnly()` applies before it runs anything: the invocation
 * must not target a remote server, and the database must be nameable. A
 * command that does work *before* handing over to `localOnly` — `crm backup
 * init --download` fetches a binary — calls this first so a misconfigured host
 * fails with the fixed copy instead of paying for the side effect (A2).
 */
export function requireLocalHost(): void {
  if (isRemote()) {
    die(SERVER_HOST_ONLY)
  }
  const config = loadConfig({ configPath: gConfig, dbPath: gDb, format: gFmt })
  if (!config.database.path) {
    die(NEEDS_DB)
  }
}

/**
 * Run a method exclusively in local mode (no RPC surface). Errors get the
 * same treatment as `dispatch` (ServiceError → die with exit-code mapping).
 */
export async function localOnly<T extends Record<string, unknown>>(
  fn: (db: DB, config: CRMConfig) => Promise<T>,
): Promise<T> {
  requireLocalHost()
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

/**
 * `dispatch` for a dual-mode host command (`backup status` / `backup sync`):
 * an operator holding a server can ask it, someone standing on the database
 * host can run it locally. What neither may get is the client's "not
 * connected" — the question these commands ask is where the database lives,
 * so an unresolvable target is NEEDS_DB (spec/client-repl.md A2).
 */
export async function dispatchHost<
  T extends Record<string, unknown> = Record<string, unknown>,
>(method: string, params: Record<string, unknown>): Promise<T> {
  if (resolveEndpoint() === 'unresolved') {
    die(NEEDS_DB)
  }
  return await dispatch<T>(method, params)
}

/**
 * True when the current invocation targets a remote server. An invocation
 * with no server *and* no nameable database is not remote; it is unresolved,
 * and the caller's own guard (NEEDS_DB in `getLocalCtx`) says why.
 */
export function isRemote(): boolean {
  const resolved = resolveEndpoint()
  return resolved !== null && resolved !== 'unresolved'
}
