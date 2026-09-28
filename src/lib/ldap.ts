/**
 * P6: LDAP directory integration (spec/enterprise.md).
 *
 * The directory is the password authority. Flow: bind as the service
 * account → search for the user under base_dn (escaped filter — no
 * hand-built LDAP strings) → bind as the found entry to verify the
 * password. Group membership is read from the group base (AD-style
 * `member` attribute) and mapped to CRM roles via `[ldap.roles]`.
 *
 * Transport rules: certificate verification is ON unless
 * `tls_skip_verify` says otherwise, and every bind/search carries a
 * deadline — ldapts defaults to *no* timeout, so a directory that accepts
 * the TCP connection and then stalls would hold a login open forever.
 */
import { readFileSync } from 'node:fs'

import {
  Client,
  type Entry,
  escapeFilter,
  InvalidCredentialsError,
} from 'ldapts'

import type { CRMConfig } from '../config'
import { roleRank, VALID_ROLE_NAMES } from '../service/registry'

/** A directory entry found by the service-account search. */
export interface LdapUser {
  displayName: string
  dn: string
  email: string
  username: string
}

export interface LdapDirectory {
  close(): Promise<void>
  /** DNs of every group entry that lists the member as a member. */
  groupDns(memberDn: string): Promise<string[]>
  /** null when the username does not resolve in the directory. */
  lookupUser(username: string): Promise<LdapUser | null>
  /** true when the password verifies against the directory. */
  verifyPassword(dn: string, password: string): Promise<boolean>
}

/**
 * Raised when a username resolves to more than one entry. Taking the
 * first match would authenticate one person as another, so it is an
 * error rather than a tie-break; the search is capped at
 * `SEARCH_SIZE_LIMIT` entries so this is detected without paging a
 * whole department into memory.
 */
export class AmbiguousIdentityError extends Error {}

const SEARCH_SIZE_LIMIT = 2

export interface LdapTlsOptions {
  ca?: string
  rejectUnauthorized: boolean
}

/** true when the url asks for LDAPS (TLS at connect) rather than StartTLS. */
export function ldapIsLdaps(config: CRMConfig): boolean {
  return config.ldap.url.toLowerCase().startsWith('ldaps://')
}

/**
 * TLS options for both transports (LDAPS and StartTLS). Verification is
 * on by default; `tls_skip_verify` is the only thing that turns it off,
 * and `tls_ca_file` replaces the trust anchors instead of disabling the
 * check.
 */
export function ldapTlsOptions(config: CRMConfig): LdapTlsOptions {
  const options: LdapTlsOptions = {
    rejectUnauthorized: config.ldap.tls_skip_verify !== true,
  }
  if (config.ldap.tls_ca_file) {
    // a CA file that disappears mid-run throws, which surfaces as
    // "directory is unreachable" — failing closed, as it should
    options.ca = readFileSync(config.ldap.tls_ca_file, 'utf-8')
  }
  return options
}

/** Finite deadlines for one directory operation. */
export function ldapTimeouts(config: CRMConfig): {
  connectTimeout: number
  timeout: number
} {
  const configured = config.ldap.timeout_ms
  const timeout =
    Number.isFinite(configured) && configured > 0 ? configured : 5000
  const configuredConnect = config.ldap.connect_timeout_ms
  const connect =
    Number.isFinite(configuredConnect) && configuredConnect > 0
      ? configuredConnect
      : Math.min(3000, timeout)
  return { connectTimeout: Math.min(connect, timeout), timeout }
}

/**
 * Non-fatal things an operator should see at boot. `tls_skip_verify` is
 * legitimate in a lab and dangerous in production, so it is allowed but
 * never quiet.
 */
export function ldapWarnings(config: CRMConfig): string[] {
  if (!config.ldap.enabled) {
    return []
  }
  const warnings: string[] = []
  if (config.ldap.tls_skip_verify) {
    warnings.push(
      '[ldap] tls_skip_verify = true — certificate verification is OFF. Anyone on the network path to the directory can capture user and service-account passwords. Point tls_ca_file at the issuing CA and remove this for production.',
    )
  }
  if (config.ldap.timeout_ms > 30_000) {
    warnings.push(
      `[ldap] timeout_ms = ${config.ldap.timeout_ms} is long: a stalled directory will hold that many login requests open for that long.`,
    )
  }
  return warnings
}

/**
 * Validate an enabled `[ldap]` config. Refused at boot:
 *  - plain `ldap://` without `starttls` (passwords in the clear)
 *  - missing url / base_dn / bind_dn
 *  - missing bind_password_env, or an env var that is unset/empty
 *  - a role name in `[ldap.roles]` / `[auth] default_role` that does not
 *    exist (a typo must not silently degrade to "no privileges")
 *  - an unreadable `tls_ca_file`, or timeouts that are not positive
 */
export function validateLdapConfig(config: CRMConfig): string | null {
  const l = config.ldap
  if (!l.enabled) {
    return null
  }
  if (!l.url) {
    return '[ldap] url is required when ldap is enabled'
  }
  const scheme = l.url.split(':', 1)[0].toLowerCase()
  if (scheme !== 'ldap' && scheme !== 'ldaps') {
    return `[ldap] url must be ldap:// or ldaps:// (got "${l.url}")`
  }
  if (
    scheme === 'ldap' &&
    !l.starttls &&
    process.env.CRM_ALLOW_INSECURE_LDAP !== '1'
  ) {
    // Local development / in-docker test directories may not have TLS
    // material; the escape hatch must be explicit, never the default.
    return 'plain ldap:// without starttls is refused — use ldaps:// or set starttls = true'
  }
  if (!l.base_dn) {
    return '[ldap] base_dn is required when ldap is enabled'
  }
  if (!l.bind_dn) {
    return '[ldap] bind_dn is required when ldap is enabled'
  }
  if (!l.bind_password_env) {
    return '[ldap] bind_password_env is required when ldap is enabled (the service-account password must come from the environment, never the config)'
  }
  const bindPassword = process.env[l.bind_password_env]
  if (!bindPassword) {
    return `[ldap] environment variable ${l.bind_password_env} is not set`
  }
  const roleNames = VALID_ROLE_NAMES.join(', ')
  for (const [groupDn, role] of Object.entries(l.roles ?? {})) {
    if (roleRank(role) < 0) {
      return `[ldap.roles] "${groupDn}" = "${role}" is not a role (expected one of: ${roleNames})`
    }
  }
  if (roleRank(config.auth.default_role) < 0) {
    return `[auth] default_role "${config.auth.default_role}" is not a role (expected one of: ${roleNames})`
  }
  if (l.tls_ca_file) {
    try {
      readFileSync(l.tls_ca_file, 'utf-8')
    } catch {
      return `[ldap] tls_ca_file "${l.tls_ca_file}" cannot be read`
    }
  }
  const finitePositive = (v: number): boolean => Number.isFinite(v) && v > 0
  if (!finitePositive(l.timeout_ms)) {
    return '[ldap] timeout_ms must be a positive number of milliseconds (0 means "no timeout" in ldapts, which is refused)'
  }
  if (!finitePositive(l.connect_timeout_ms)) {
    return '[ldap] connect_timeout_ms must be a positive number of milliseconds'
  }
  return null
}

type LdapAttr = Buffer | Buffer[] | string | string[] | undefined

function attrText(value: LdapAttr): string {
  if (value === undefined) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? attrText(value[0] as LdapAttr) : ''
  }
  // binary-valued attributes arrive as Buffer; a lone Buffer is not a
  // string and String(buffer) would yield "[object Object]"-ish junk
  return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value)
}

function attr(entry: Entry, name: string): string {
  return attrText(entry[name] as LdapAttr)
}

/**
 * Connection-layer retry for transient directory hiccups (TCP reset,
 * server briefly overloaded). Used only for service-account operations:
 * a *user's* wrong password can surface as a generic LDAP error on some
 * directories, and retrying that would send the directory three bind
 * attempts for one login — brute-force amplification and lockout delay.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof InvalidCredentialsError) {
        throw e
      }
      last = e
      if (i < attempts - 1) {
        await Bun.sleep(150 * (i + 1))
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/** The default (ldapts-backed) directory implementation. */
export function openDirectory(config: CRMConfig): LdapDirectory {
  async function once<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    // read per call, so rotating the service-account password only needs
    // a new process environment for the next login
    const bindPassword = process.env[config.ldap.bind_password_env] ?? ''
    const { connectTimeout, timeout } = ldapTimeouts(config)
    // Note: passing tlsOptions makes ldapts treat the connection as
    // secure at connect time — so it is only passed for ldaps://. Plain
    // ldap:// upgrades via startTLS() (which connects itself first).
    const isLdaps = ldapIsLdaps(config)
    const client = new Client({
      url: config.ldap.url,
      timeout,
      connectTimeout,
      ...(isLdaps ? { tlsOptions: ldapTlsOptions(config) } : {}),
    })
    try {
      if (config.ldap.starttls && !isLdaps) {
        await client.startTLS(ldapTlsOptions(config))
      }
      await client.bind(config.ldap.bind_dn, bindPassword)
      return await fn(client)
    } finally {
      await client.unbind().catch(() => undefined)
    }
  }

  /** Service-account operation, with connection-layer retries. */
  async function service<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    return await withRetry(() => once(fn))
  }

  return {
    async lookupUser(username): Promise<LdapUser | null> {
      // escapeFilter is a tagged template: substitutions are escaped,
      // so injection-style usernames can never break out of the filter
      const escaped = escapeFilter`${username}`
      const filter = config.ldap.user_filter.split('{username}').join(escaped)
      const r = await service((c) =>
        c.search(config.ldap.base_dn, {
          scope: 'sub',
          filter,
          sizeLimit: SEARCH_SIZE_LIMIT,
          attributes: [
            'dn',
            'uid',
            'sAMAccountName',
            'cn',
            'displayName',
            'mail',
          ],
        }),
      )
      if (r.searchEntries.length === 0) {
        return null
      }
      if (r.searchEntries.length > 1) {
        throw new AmbiguousIdentityError(
          `"${username}" matches more than one directory entry`,
        )
      }
      const found = r.searchEntries[0]
      const uid = attr(found, 'uid') || attr(found, 'sAMAccountName')
      return {
        dn: found.dn,
        // the directory's own id is the identity: a filter on mail (or
        // any other attribute) must not provision a CRM user under
        // whatever the caller typed
        username: uid || username,
        displayName: attr(found, 'cn') || attr(found, 'displayName'),
        email: attr(found, 'mail'),
      }
    },
    async verifyPassword(dn, password): Promise<boolean> {
      try {
        // no retry here: one login attempt is exactly one bind
        await once(async (c) => {
          await c.bind(dn, password)
        })
        return true
      } catch (e) {
        if (e instanceof InvalidCredentialsError) {
          return false
        }
        throw e
      }
    },
    async groupDns(memberDn): Promise<string[]> {
      const escaped = escapeFilter`${memberDn}`
      const base = config.ldap.group_base_dn || config.ldap.base_dn
      const r = await service((c) =>
        c.search(base, {
          scope: 'sub',
          filter: `(|(member=${escaped})(uniqueMember=${escaped}))`,
          attributes: ['dn'],
        }),
      )
      return r.searchEntries.map((e) => e.dn)
    },
    async close(): Promise<void> {
      // connections are per-operation; nothing to close
    },
  }
}

/**
 * Resolve the CRM role for a JIT-provisioned directory user: the highest
 * ranked role among the mapped groups the user belongs to, else
 * `auth.default_role`. Rankings come from the same ladder RBAC uses.
 */
export function roleForGroups(config: CRMConfig, groupDns: string[]): string {
  const byGroup = new Map<string, string>()
  for (const [groupDn, role] of Object.entries(config.ldap.roles)) {
    byGroup.set(groupDn.toLowerCase(), role)
  }
  let best =
    roleRank(config.auth.default_role) >= 0 ? config.auth.default_role : 'none'
  for (const dn of groupDns) {
    const role = byGroup.get(dn.toLowerCase())
    if (role === undefined || roleRank(role) < 0) {
      continue
    }
    if (roleRank(role) > roleRank(best)) {
      best = role
    }
  }
  return best
}
