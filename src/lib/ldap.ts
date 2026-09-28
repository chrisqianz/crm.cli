/**
 * P6: LDAP directory integration (spec/enterprise.md).
 *
 * The directory is the password authority. Flow: bind as the service
 * account → search for the user under base_dn (escaped filter — no
 * hand-built LDAP strings) → bind as the found entry to verify the
 * password. Group membership is read from the group base (AD-style
 * `member` attribute) and mapped to CRM roles via `[ldap.roles]`.
 */
import {
  Client,
  type Entry,
  escapeFilter,
  InvalidCredentialsError,
} from 'ldapts'

import type { CRMConfig } from '../config'

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
 * Validate an enabled `[ldap]` config. Refused at boot:
 *  - plain `ldap://` without `starttls` (passwords in the clear)
 *  - missing url / base_dn / bind_dn
 *  - missing bind_password_env, or an env var that is unset/empty
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
  return null
}

function attr(entry: Entry, name: string): string {
  const v = entry[name]
  if (Array.isArray(v)) {
    return v.length > 0 ? String(v[0]) : ''
  }
  return typeof v === 'string' ? v : ''
}

/**
 * Connection-layer retry for transient directory hiccups (TCP reset,
 * server briefly overloaded). Authentication failures are NOT retried —
 * they are a signal, not a transient state, and retrying them would
 * amplify brute-force traffic and delay lockout.
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
  const bindPassword = process.env[config.ldap.bind_password_env] ?? ''

  async function service<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    // Note: passing tlsOptions makes ldapts treat the connection as
    // secure at connect time — so it is only passed for ldaps://. Plain
    // ldap:// upgrades via startTLS() (which connects itself first).
    const isLdaps = config.ldap.url.toLowerCase().startsWith('ldaps://')
    return await withRetry(async () => {
      const c = new Client({
        url: config.ldap.url,
        ...(isLdaps ? { tlsOptions: { rejectUnauthorized: false } } : {}),
      })
      try {
        if (config.ldap.starttls && !isLdaps) {
          await c.startTLS({ rejectUnauthorized: false })
        }
        await c.bind(config.ldap.bind_dn, bindPassword)
        return await fn(c)
      } finally {
        await c.unbind().catch(() => undefined)
      }
    })
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
      const found = r.searchEntries[0]
      const uid = attr(found, 'uid') || attr(found, 'sAMAccountName')
      return {
        dn: found.dn,
        username: uid || username,
        displayName: attr(found, 'cn') || attr(found, 'displayName'),
        email: attr(found, 'mail'),
      }
    },
    async verifyPassword(dn, password): Promise<boolean> {
      try {
        await service(async (c) => {
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
 * `auth.default_role`.
 */
export function roleForGroups(config: CRMConfig, groupDns: string[]): string {
  const norm = new Map<string, string>()
  for (const [groupDn, role] of Object.entries(config.ldap.roles)) {
    norm.set(groupDn.toLowerCase(), role)
  }
  const RANK: Record<string, number> = {
    none: 0,
    reader: 1,
    writer: 2,
    admin: 3,
    owner: 4,
  }
  let best = config.auth.default_role || 'none'
  let bestRank = RANK[best] ?? 0
  for (const dn of groupDns) {
    const role = norm.get(dn.toLowerCase())
    if (!role) {
      continue
    }
    const rank = RANK[role] ?? 0
    if (rank > bestRank) {
      best = role
      bestRank = rank
    }
  }
  return best
}
