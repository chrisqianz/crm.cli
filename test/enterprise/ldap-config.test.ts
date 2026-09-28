import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CRMConfig, loadConfig } from '../../src/config'
import {
  ldapTimeouts,
  ldapTlsOptions,
  roleForGroups,
  validateLdapConfig,
} from '../../src/lib/ldap'
import { roleRank } from '../../src/service/registry'

/**
 * Unit contracts for the `[ldap]` config surface. These run without a
 * directory: they pin down what `crm serve` refuses to boot with, which is
 * the layer that turns a typo into a silent privilege grant.
 */

const tempDirs: string[] = []
const ENV_KEYS = ['CRM_ALLOW_INSECURE_LDAP', 'CRM_LDAP_TEST_PW']
const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) {
  savedEnv[k] = process.env[k]
}

afterEach(() => {
  // the insecure-transport escape hatch must never leak between tests:
  // it is what the plain-ldap refusal is asserted against
  process.env.CRM_ALLOW_INSECURE_LDAP = ''
  process.env.CRM_LDAP_TEST_PW = 'test-svc-pw'
})

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
})

function config(
  ldap: Partial<CRMConfig['ldap']> = {},
  auth: Partial<CRMConfig['auth']> = {},
): CRMConfig {
  const base = loadConfig({ configPath: '/dev/null' })
  base.ldap = {
    ...base.ldap,
    enabled: true,
    url: 'ldaps://dc.example.com',
    base_dn: 'ou=people,dc=example,dc=com',
    bind_dn: 'cn=crm-service,dc=example,dc=com',
    bind_password_env: 'CRM_LDAP_TEST_PW',
    ...ldap,
  }
  base.auth = { ...base.auth, ...auth }
  return base
}

function caFile(
  pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
): string {
  const dir = mkdtempSync(join(tmpdir(), 'crm-ldap-ca-'))
  tempDirs.push(dir)
  const path = join(dir, 'ca.pem')
  writeFileSync(path, pem)
  return path
}

describe('[ldap] config validation', () => {
  test('a disabled ldap section is not validated', () => {
    const c = config({ enabled: false, url: '' })
    c.ldap.enabled = false
    expect(validateLdapConfig(c)).toBeNull()
  })

  test('plain ldap:// without starttls is refused', () => {
    const err = validateLdapConfig(config({ url: 'ldap://dc.example.com' }))
    expect(err).toContain('plain ldap://')
    expect(err).toContain('starttls')
  })

  test('the insecure escape hatch is honoured when explicit', () => {
    process.env.CRM_ALLOW_INSECURE_LDAP = '1'
    expect(
      validateLdapConfig(config({ url: 'ldap://dc.example.com' })),
    ).toBeNull()
  })

  test('starttls over ldap:// is accepted', () => {
    expect(
      validateLdapConfig(
        config({ url: 'ldap://dc.example.com', starttls: true }),
      ),
    ).toBeNull()
  })

  test('ldaps:// is accepted', () => {
    expect(validateLdapConfig(config())).toBeNull()
  })

  test('a non-ldap url scheme is refused', () => {
    expect(
      validateLdapConfig(config({ url: 'https://dc.example.com' })),
    ).toMatch(/ldap:\/\/ or ldaps:\/\//)
  })

  test('missing url, base_dn, bind_dn and bind_password_env are each refused', () => {
    expect(validateLdapConfig(config({ url: '' }))).toMatch(/url is required/)
    expect(validateLdapConfig(config({ base_dn: '' }))).toMatch(
      /base_dn is required/,
    )
    expect(validateLdapConfig(config({ bind_dn: '' }))).toMatch(
      /bind_dn is required/,
    )
    expect(validateLdapConfig(config({ bind_password_env: '' }))).toMatch(
      /bind_password_env is required/,
    )
  })

  test('an unset bind password env var is refused by name', () => {
    process.env.CRM_LDAP_TEST_PW = ''
    expect(validateLdapConfig(config())).toMatch(/CRM_LDAP_TEST_PW is not set/)
  })

  test('a typo in a [ldap.roles] role is refused, not ignored', () => {
    const err = validateLdapConfig(
      config({ roles: { 'cn=crm-admins,dc=example,dc=com': 'superuser' } }),
    )
    expect(err).toMatch(/cn=crm-admins/)
    expect(err).toMatch(/superuser/)
  })

  test('a typo in auth.default_role is refused', () => {
    expect(validateLdapConfig(config({}, { default_role: 'root' }))).toMatch(
      /default_role/,
    )
  })

  test('a group may map to owner (a directory admin group is legitimate)', () => {
    expect(
      validateLdapConfig(
        config({ roles: { 'cn=it-admins,dc=example,dc=com': 'owner' } }),
      ),
    ).toBeNull()
  })

  test('a tls_ca_file that cannot be read is refused', () => {
    expect(
      validateLdapConfig(config({ tls_ca_file: '/nonexistent/dir/ca.pem' })),
    ).toMatch(/tls_ca_file/)
  })

  test('a readable tls_ca_file is accepted', () => {
    expect(validateLdapConfig(config({ tls_ca_file: caFile() }))).toBeNull()
  })

  test('non-positive timeouts are refused', () => {
    expect(validateLdapConfig(config({ timeout_ms: 0 - 5 }))).toMatch(
      /timeout_ms/,
    )
    expect(validateLdapConfig(config({ connect_timeout_ms: 0 - 1 }))).toMatch(
      /connect_timeout_ms/,
    )
  })
})

describe('[ldap] TLS verification defaults to on', () => {
  test('certificate verification is on unless asked otherwise', () => {
    expect(ldapTlsOptions(config()).rejectUnauthorized).toBe(true)
  })

  test('tls_skip_verify = true is what turns it off', () => {
    expect(
      ldapTlsOptions(config({ tls_skip_verify: true })).rejectUnauthorized,
    ).toBe(false)
  })

  test('tls_ca_file is loaded into the trust anchors', () => {
    const opts = ldapTlsOptions(config({ tls_ca_file: caFile() }))
    expect(typeof opts.ca).toBe('string')
    expect(opts.ca as string).toContain('BEGIN CERTIFICATE')
  })

  test('without a ca file the system roots are used', () => {
    expect(ldapTlsOptions(config()).ca).toBeUndefined()
  })

  test('skipping verification still honours an explicit ca file', () => {
    const opts = ldapTlsOptions(
      config({ tls_skip_verify: true, tls_ca_file: caFile() }),
    )
    expect(opts.rejectUnauthorized).toBe(false)
    expect(opts.ca as string).toContain('BEGIN CERTIFICATE')
  })
})

describe('[ldap] timeouts are finite', () => {
  test('defaults are bounded', () => {
    const t = ldapTimeouts(config())
    expect(t.timeout).toBeGreaterThan(0)
    expect(t.timeout).toBeLessThanOrEqual(60_000)
    expect(t.connectTimeout).toBeGreaterThan(0)
    expect(t.connectTimeout).toBeLessThanOrEqual(t.timeout)
  })

  test('configured values are used verbatim', () => {
    const t = ldapTimeouts(
      config({ timeout_ms: 1234, connect_timeout_ms: 456 }),
    )
    expect(t.timeout).toBe(1234)
    expect(t.connectTimeout).toBe(456)
  })
})

describe('group → role mapping', () => {
  test('the highest ranked mapped group wins', () => {
    const c = config({
      roles: {
        'cn=crm-readers,dc=example,dc=com': 'reader',
        'cn=crm-admins,dc=example,dc=com': 'admin',
        'cn=crm-writers,dc=example,dc=com': 'writer',
      },
    })
    expect(
      roleForGroups(c, [
        'cn=crm-readers,dc=example,dc=com',
        'cn=crm-admins,dc=example,dc=com',
      ]),
    ).toBe('admin')
  })

  test('group DN matching ignores case, role names are not invented', () => {
    const c = config({
      roles: { 'CN=CRM-Admins,DC=Example,DC=com': 'admin' },
    })
    expect(roleForGroups(c, ['cn=crm-admins,dc=example,dc=com'])).toBe('admin')
  })

  test('unmapped groups fall back to auth.default_role', () => {
    const c = config(
      { roles: { 'cn=other,dc=example,dc=com': 'admin' } },
      { default_role: 'reader' },
    )
    expect(roleForGroups(c, ['cn=unmapped,dc=example,dc=com'])).toBe('reader')
  })

  test('"none" really means nothing: no group, no elevation', () => {
    const c = config({ roles: {} }, { default_role: 'none' })
    expect(roleForGroups(c, ['cn=whatever,dc=example,dc=com'])).toBe('none')
  })

  test('default_role outranks nothing, a mapped group outranks it', () => {
    const c = config(
      { roles: { 'cn=g,dc=example,dc=com': 'writer' } },
      { default_role: 'reader' },
    )
    expect(roleForGroups(c, [])).toBe('reader')
    expect(roleForGroups(c, ['cn=g,dc=example,dc=com'])).toBe('writer')
  })
})

describe('role ranking is defined once', () => {
  test('the ladder is ordered and unknown names rank below everything', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'))
    expect(roleRank('admin')).toBeGreaterThan(roleRank('writer'))
    expect(roleRank('writer')).toBeGreaterThan(roleRank('reader'))
    expect(roleRank('reader')).toBeGreaterThan(roleRank('none'))
    expect(roleRank('superuser')).toBeLessThan(roleRank('none'))
  })

  test('every role name the config accepts is on the ladder', async () => {
    const { VALID_ROLE_NAMES } = await import('../../src/service/registry')
    for (const name of VALID_ROLE_NAMES) {
      expect(roleRank(name)).toBeGreaterThanOrEqual(0)
    }
    expect(VALID_ROLE_NAMES).toContain('none')
  })
})
