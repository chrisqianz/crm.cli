/**
 * Web admin console (plain HTTP, separate port from the TLS RPC server).
 *
 * The console is an operational tool, not a data path: it reuses the exact
 * same auth + RBAC + audit machinery as the RPC surface by calling
 * `handleAuth` / `handleCommand` directly. Every `/api/call` is therefore
 * subject to the same role checks and writes the same audit rows as an RPC
 * write — the browser is just another client.
 *
 * Trust model: plain HTTP by design (an ops tool for a trusted interface,
 * or behind a TLS-terminating proxy). The RPC data port stays TLS. Secrets
 * (LDAP bind password, SMTP password) are never returned — only a
 * "is it set" flag — and the config view is owner/admin-only.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type { CRMConfig } from '../config'
import { resolveBackend } from '../db/open'
import type { CrmDb } from '../db/seam'
import { ServiceError } from '../lib/errors'
import { consoleHtml } from './console'
import {
  handleAuth,
  handleCommand,
  type Identity,
  ServerError,
} from './handlers'

export interface AdminOptions {
  bootstrapCode: string | null
  config: CRMConfig
  db: CrmDb
  host: string
  /**
   * D-A2: what the generated install.sh installs. Empty string = the
   * public `crm.cli` package (fallback).
   */
  installSource?: string
  /** 0 = let the OS assign a free port (used by tests) */
  port: number
  /** Human-readable address of the RPC (TLS) port, for client downloads. */
  rpcHost: string
  /** Whether the RPC connection needs cert-skip (self-signed material). */
  rpcInsecure: boolean
  rpcPort: number
}

const MAX_BODY_BYTES = 1024 * 1024

const HTTP_STATUS: Record<string, number> = {
  INVALID: 400,
  AUTH: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
}

/**
 * Start the admin console HTTP server and resolve to the live server once
 * it is listening (mirrors startServer's READY contract, but on HTTP).
 */
export function startAdminServer(
  opts: AdminOptions,
): Promise<{ port: number; server: http.Server }> {
  const { db, config, bootstrapCode, host, rpcHost, rpcPort, rpcInsecure } =
    opts
  const server = http.createServer((req, res) => {
    handleRequest(req, res, {
      db,
      config,
      bootstrapCode,
      rpcHost,
      rpcPort,
      rpcInsecure,
      installSource: opts.installSource ?? '',
    }).catch((e) => {
      console.error('crm serve: admin request failed:', e)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, host, () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      console.log(`ADMIN ${port}`)
      resolve({ port, server })
    })
  })
}

interface Ctx {
  bootstrapCode: string | null
  config: CRMConfig
  db: CrmDb
  /** D-A2: install source for the generated install.sh ('' = public pkg). */
  installSource: string
  rpcHost: string
  rpcInsecure: boolean
  rpcPort: number
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      throw new ServerError('INVALID', 'request body too large')
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) {
    return h.slice(7).trim() || null
  }
  return null
}

async function resolveIdentity(
  db: CrmDb,
  config: CRMConfig,
  ctx: { bootstrapCode: string | null; ip: string },
  token: string | null,
): Promise<Identity> {
  if (!token) {
    throw new ServerError('AUTH', 'missing bearer token')
  }
  const auth = await handleAuth(db, config, ctx, 'auth.token', { token })
  return auth.identity
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Ctx,
): Promise<void> {
  const ip = req.socket.remoteAddress ?? 'unknown'
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  const send = (status: number, type: string, body: string) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }
  const sendJson = (status: number, obj: unknown) =>
    send(status, 'application/json', JSON.stringify(obj))

  try {
    if (method === 'GET' && (path === '/' || path === '/console.html')) {
      return send(200, 'text/html; charset=utf-8', consoleHtml(ctx))
    }
    if (method === 'GET' && path === '/healthz') {
      return sendJson(200, { ok: true, admin: true })
    }
    if (method === 'POST' && path === '/api/login') {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      const auth = await handleAuth(
        ctx.db,
        ctx.config,
        { bootstrapCode: ctx.bootstrapCode, ip },
        'auth.login',
        {
          username: typeof body.username === 'string' ? body.username : '',
          password: typeof body.password === 'string' ? body.password : '',
        },
      )
      // result already carries { token, user } for both local and LDAP
      // logins; the bootstrap path carries the same shape.
      return sendJson(200, auth.result)
    }
    if (method === 'GET' && path === '/api/me') {
      const identity = await resolveIdentity(
        ctx.db,
        ctx.config,
        { bootstrapCode: ctx.bootstrapCode, ip },
        bearer(req),
      )
      return sendJson(200, {
        id: identity.id,
        username: identity.username,
        role: identity.role,
      })
    }
    if (method === 'GET' && path === '/api/config') {
      const identity = await resolveIdentity(
        ctx.db,
        ctx.config,
        { bootstrapCode: ctx.bootstrapCode, ip },
        bearer(req),
      )
      if (identity.role !== 'owner' && identity.role !== 'admin') {
        throw new ServerError(
          'FORBIDDEN',
          `role "${identity.role}" cannot view server config`,
        )
      }
      return sendJson(200, configView(ctx))
    }
    if (method === 'GET' && path === '/download/crm.toml') {
      return send(200, 'text/plain; charset=utf-8', clientConfig(ctx))
    }
    if (method === 'GET' && path === '/download/install.sh') {
      return send(200, 'text/plain; charset=utf-8', installScript(ctx))
    }
    if (method === 'POST' && path === '/api/call') {
      const identity = await resolveIdentity(
        ctx.db,
        ctx.config,
        { bootstrapCode: ctx.bootstrapCode, ip },
        bearer(req),
      )
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      if (typeof body.method !== 'string') {
        throw new ServerError('INVALID', 'missing "method"')
      }
      const params =
        body.params && typeof body.params === 'object'
          ? (body.params as Record<string, unknown>)
          : {}
      const result = await handleCommand(
        ctx.db,
        ctx.config,
        { ip },
        identity,
        body.method,
        params,
      )
      return sendJson(200, { result })
    }

    return sendJson(404, {
      error: { code: 'NOT_FOUND', message: 'no such route' },
    })
  } catch (e) {
    const code =
      e instanceof ServerError || e instanceof ServiceError
        ? e.code
        : 'INTERNAL'
    const status = HTTP_STATUS[code] ?? 500
    return sendJson(status, {
      error: {
        code,
        message: e instanceof Error ? e.message : String(e),
      },
    })
  }
}

/** Sanitized config view — no secrets, only "is it set" flags. */
function configView(ctx: Ctx): Record<string, unknown> {
  const c = ctx.config
  return {
    // D-B: which file the operator actually edits ("" = pure defaults).
    path: c.config_meta.path || '(defaults)',
    // D-B: the effective config as copyable TOML, secrets stripped.
    toml: renderSanitizedToml(c),
    serve: {
      host: c.serve.host,
      rpc_host: ctx.rpcHost,
      rpc_port: ctx.rpcPort,
      install_source: c.serve.install_source,
    },
    database: {
      path: c.database.path,
      // Which server holds the data, and whether a url is configured — the url
      // itself is a credential and never crosses the wire (`*_set` precedent:
      // mail.password_set, ldap.bind_password_set).
      backend: resolveBackend(c),
      url_set: c.database.url !== undefined,
    },
    backup: { destination: c.backup.destination },
    activity: { types: c.activity.types },
    pipeline: {
      stages: c.pipeline.stages,
      won_stage: c.pipeline.won_stage,
      lost_stage: c.pipeline.lost_stage,
    },
    auth: {
      default_role: c.auth.default_role,
      lockout_threshold: c.auth.lockout_threshold,
      lockout_minutes: c.auth.lockout_minutes,
      password_min_length: c.auth.password_min_length,
      password_max_age_days: c.auth.password_max_age_days,
      login_rate_per_minute: c.auth.login_rate_per_minute,
      login_user_rate_per_minute: c.auth.login_user_rate_per_minute,
    },
    ldap: {
      enabled: c.ldap.enabled,
      url: c.ldap.url,
      starttls: c.ldap.starttls,
      base_dn: c.ldap.base_dn,
      bind_dn: c.ldap.bind_dn,
      bind_password_env: c.ldap.bind_password_env,
      bind_password_set:
        c.ldap.bind_password_env !== '' &&
        process.env[c.ldap.bind_password_env] !== undefined,
      user_filter: c.ldap.user_filter,
      group_base_dn: c.ldap.group_base_dn,
      roles: c.ldap.roles,
      tls_ca_file: c.ldap.tls_ca_file,
      tls_skip_verify: c.ldap.tls_skip_verify,
      timeout_ms: c.ldap.timeout_ms,
    },
    mail: {
      configured: c.mail.host !== '',
      host: c.mail.host,
      port: c.mail.port,
      user: c.mail.user,
      from: c.mail.from,
      secure: c.mail.secure,
      password_set: process.env.CRM_SMTP_PASSWORD !== undefined,
    },
  }
}

/**
 * The bind-password line for the sanitized TOML: which environment
 * variable carries it, and whether that variable is actually set on
 * this host. The value itself never crosses the wire.
 */
function ldapBindPasswordNote(ldap: CRMConfig['ldap']): string {
  if (ldap.bind_password_env === '') {
    return 'unset'
  }
  if (process.env[ldap.bind_password_env] === undefined) {
    return `${ldap.bind_password_env} (NOT SET)`
  }
  return `${ldap.bind_password_env} (set)`
}

/**
 * The effective config as TOML, ready to copy into a crm.toml on a
 * fresh machine. Sanitized by construction: password material never
 * appears — secrets are environment variables on the DB host, and the
 * rendered text only reports whether the expected variable is set.
 */
export function renderSanitizedToml(c: CRMConfig): string {
  const lines: string[] = [
    '# Effective crm.cli server configuration (sanitized — no secrets)',
    '# Changes take effect after a server restart.',
    '',
    '[serve]',
    `host = "${c.serve.host}"`,
    `port = ${c.serve.port}`,
  ]
  if (c.serve.public_host !== '') {
    lines.push(`public_host = "${c.serve.public_host}"`)
  }
  if (c.serve.public_port !== 0) {
    lines.push(`public_port = ${c.serve.public_port}`)
  }
  if (c.serve.install_source !== '') {
    lines.push(`install_source = "${c.serve.install_source}"`)
  }
  const tlsNote =
    c.serve.cert || c.serve.key
      ? `custom material (${c.serve.cert || c.serve.key})`
      : 'default self-signed'
  lines.push(
    `# TLS: ${tlsNote}`,
    '',
    '[database]',
    ...databaseToml(c),
    '',
    '[auth]',
    `lockout_threshold = ${c.auth.lockout_threshold}`,
    `lockout_minutes = ${c.auth.lockout_minutes}`,
    `password_min_length = ${c.auth.password_min_length}`,
    `password_max_age_days = ${c.auth.password_max_age_days}`,
    `default_role = "${c.auth.default_role}"`,
    `login_rate_per_minute = ${c.auth.login_rate_per_minute}`,
    `login_user_rate_per_minute = ${c.auth.login_user_rate_per_minute}`,
    '',
    '[backup]',
    `destination = "${c.backup.destination}"`,
    '',
    '[activity]',
    `types = [${c.activity.types.map((t) => `"${t}"`).join(', ')}]`,
    '',
    '[pipeline]',
    `stages = [${c.pipeline.stages.map((s) => `"${s}"`).join(', ')}]`,
    `won_stage = "${c.pipeline.won_stage}"`,
    `lost_stage = "${c.pipeline.lost_stage}"`,
  )
  if (c.mail.host !== '') {
    lines.push(
      '',
      '[mail]',
      `host = "${c.mail.host}"`,
      `port = ${c.mail.port}`,
      `user = "${c.mail.user}"`,
      `from = "${c.mail.from}"`,
      `secure = ${c.mail.secure}`,
      `# password: env ${
        process.env.CRM_SMTP_PASSWORD === undefined
          ? 'CRM_SMTP_PASSWORD (NOT SET)'
          : 'CRM_SMTP_PASSWORD (set)'
      }`,
    )
  }
  if (c.ldap.enabled) {
    lines.push(
      '',
      '[ldap]',
      'enabled = true',
      `url = "${c.ldap.url}"`,
      `starttls = ${c.ldap.starttls}`,
      `base_dn = "${c.ldap.base_dn}"`,
      `bind_dn = "${c.ldap.bind_dn}"`,
      `# bind password: env ${ldapBindPasswordNote(c.ldap)}`,
      `user_filter = "${c.ldap.user_filter}"`,
      `group_base_dn = "${c.ldap.group_base_dn}"`,
      `# group→role: ${JSON.stringify(c.ldap.roles)}`,
      `tls_skip_verify = ${c.ldap.tls_skip_verify}`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * `[database]` lines for the sanitized render.
 *
 * An unconfigured section renders exactly what it did before backends existed
 * — the copyable config stays what the operator would have written themselves.
 * Postgres renders the backend plus a REDACTED url: the console is plain HTTP,
 * so a connection string with a password in it is not display content.
 */
function databaseToml(c: CRMConfig): string[] {
  if (resolveBackend(c) === 'postgres') {
    return [
      'backend = "postgres"',
      `url = "${redactDatabaseUrl(c.database.url ?? '')}"`,
    ]
  }
  return [`path = "${c.database.path}"`]
}

/**
 * Drop the password from a connection url, keep everything that identifies
 * WHICH server it is (user, host, port, database).
 *
 * A url that will not parse collapses to a constant: an operator pasting a
 * console screenshot into a ticket must never be pasting a credential, and
 * "we could not parse it" is not a license to echo the raw string.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password !== '') {
      parsed.password = '***'
    }
    return parsed.toString()
  } catch {
    return '***'
  }
}

/**
 * Preconfigured client config: point a colleague's crm.cli at THIS server
 * so they never type `--server` / `--insecure`. The token still comes from
 * `crm login` (a session artifact), which is the intended flow.
 */
function clientConfig(ctx: Ctx): string {
  return `# Generated by crm.cli console — ${ctx.rpcHost}:${ctx.rpcPort}
# Install at ~/.crm/config.toml, then run:  crm login
[remote]
server = "${ctx.rpcHost}:${ctx.rpcPort}"
insecure = ${ctx.rpcInsecure}
`
}

/**
 * One-liner bootstrap for a fresh machine: install crm.cli (if needed),
 * write the preconfigured config, and prompt for the first login.
 */
function installScript(ctx: Ctx): string {
  // D-A2: the server decides what gets installed. crm.cli is published
  // under the scoped name @dzhng/crm.cli — an enterprise deployment
  // configures its own mirror/git source; the fallback is the public
  // package by its real (scoped) name.
  const source = ctx.installSource === '' ? '@dzhng/crm.cli' : ctx.installSource
  const sourceHint =
    ctx.installSource === ''
      ? '      The package may not be published on your registry. Set [serve]\n      install_source = "<internal-mirror-or-git-url>" on the server and re-download.'
      : '      Verify the configured [serve] install_source on the server is reachable.'
  return `#!/usr/bin/env bash
# crm.cli client bootstrap for ${ctx.rpcHost}:${ctx.rpcPort}
# Generated by the server console. Safe to re-run (idempotent).
set -euo pipefail

CFG_DIR="\${HOME}/.crm"
CFG="\${CFG_DIR}/config.toml"
mkdir -p "$CFG_DIR"

if command -v crm >/dev/null 2>&1; then
  echo "crm.cli already installed: $(command -v crm)"
elif command -v bun >/dev/null 2>&1; then
  echo "Installing crm.cli via bun…"
  # --trust: bun blocks package lifecycle scripts by default, and git
  # installs need the postinstall guard to build dist/cli.js.
  if ! bun install -g ${source} --trust; then
    echo "WARN: bun install failed (offline? private registry?)." >&2
${sourceHint}
  fi
else
  echo "Neither crm nor bun found — install crm.cli (bun install -g ${source} --trust) first."
fi

cat > "$CFG" <<TOML
# Generated by crm.cli console — ${ctx.rpcHost}:${ctx.rpcPort}
[remote]
server = "${ctx.rpcHost}:${ctx.rpcPort}"
insecure = ${ctx.rpcInsecure}
TOML

echo "Wrote $CFG"
if command -v crm >/dev/null 2>&1; then
  echo "Installed: $(command -v crm)"
  echo "Next: run  crm login   (username + password), then  crm contact list"
else
  echo "WARN: 'crm' is still not on PATH after the install attempt." >&2
  echo "      On bun, global installs land in $(bun pm bin -g) — make sure that directory is on your PATH, e.g.:" >&2
  echo '      Add to your shell profile:  echo "export PATH=$(bun pm bin -g):$PATH" >> ~/.profile' >&2
fi
`
}
