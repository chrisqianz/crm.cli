import { afterAll, describe, expect, test } from 'bun:test'
import { type AddressInfo, createServer } from 'node:net'

import { bootstrapOwner, connect, freshDb, REPO, startServer } from './helpers'

/**
 * P6: LDAP directory login against a real in-docker OpenLDAP
 * (osixia/openldap). The directory is the password authority: the server
 * binds as the service account, searches for the user under base_dn, then
 * binds as the user to verify the password.
 *
 * The test tree:
 *   alice → cn=crm-admins      → role admin
 *   bob   → cn=crm-writers     → role writer
 *   dave  → no group           → auth.default_role (none → FORBIDDEN)
 *   eve   → local-only account (never in the directory)
 */

const LDAP_IMAGE = 'crm-ldap-test:local'
const ADMIN_PASS = 'admin'
const BASE = 'dc=example,dc=com'
const PEOPLE = `ou=people,${BASE}`
const GROUPS = `ou=groups,${BASE}`

/**
 * Docker availability, probed synchronously at module load: `describe.skipIf`
 * is evaluated during collection and cannot await. The in-test `docker info`
 * check inside `ensureLdap` cannot cover a missing binary — bun throws
 * `Executable not found in $PATH: "docker"` before any exit code exists, so a
 * host without Docker used to report 11 failures instead of skipping. Unlike
 * the postgres helper there is no external-URL escape hatch: this suite needs
 * the container runtime itself.
 */
function dockerUsable(): boolean {
  try {
    return (
      Bun.spawnSync(['docker', 'info'], { env: process.env }).exitCode === 0
    )
  } catch {
    return false
  }
}

const NO_DOCKER = !dockerUsable()

/**
 * Directory-specific environment, scoped to this file on purpose: `crm
 * serve` refuses plain ldap:// without CRM_ALLOW_INSECURE_LDAP, and that
 * refusal is only assertable while the variable is absent elsewhere.
 */
const LDAP_ENV = {
  CRM_ALLOW_INSECURE_LDAP: '1',
  CRM_LDAP_BIND_PASSWORD: 'svc-pw-1',
}

const TEST_LDIF = `dn: ${PEOPLE}
objectClass: organizationalUnit
ou: people

dn: ${GROUPS}
objectClass: organizationalUnit
ou: groups

dn: uid=alice,${PEOPLE}
objectClass: inetOrgPerson
uid: alice
cn: Alice Dir
sn: Dir
mail: alice@example.com
userPassword: alice-pw-1

dn: uid=bob,${PEOPLE}
objectClass: inetOrgPerson
uid: bob
cn: Bob Dir
sn: Dir
mail: bob@example.com
userPassword: bob-pw-1

dn: uid=dave,${PEOPLE}
objectClass: inetOrgPerson
uid: dave
cn: Dave Dir
sn: Dir
mail: dave@example.com
userPassword: dave-pw-1

dn: cn=crm-admins,${GROUPS}
objectClass: groupOfUniqueNames
cn: crm-admins
uniqueMember: uid=alice,${PEOPLE}

dn: cn=crm-writers,${GROUPS}
objectClass: groupOfUniqueNames
cn: crm-writers
uniqueMember: uid=bob,${PEOPLE}

dn: cn=crm-service,${PEOPLE}
objectClass: inetOrgPerson
uid: crm-service
cn: CRM Service
sn: Service
userPassword: svc-pw-1
`

function docker(args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(['docker', ...args], { env: process.env })
  return {
    code: r.exitCode ?? 0,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  }
}

async function waitFor(
  fn: () => Promise<unknown>,
  tries: number,
  delayMs: number,
): Promise<void> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      await fn()
      return
    } catch (e) {
      last = e
      await Bun.sleep(delayMs)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/** Run a docker-exec command, piping `input` to its stdin. */
/** Run a docker-exec command, piping `input` to its stdin. */
async function runLdapStream(
  container: string,
  cmd: string[],
  input: string,
): Promise<void> {
  await new Promise<void>((resolveP, rejectP) => {
    const proc = Bun.spawn(['docker', 'exec', '-i', container, ...cmd], {
      env: process.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const sink = proc.stdin as unknown as {
      write: (s: string) => void
      close: () => void
    }
    sink?.write(input)
    sink?.close()
    let err = ''
    let pump: Promise<void> | null = null
    const stream = proc.stderr as unknown as
      | ReadableStream<Uint8Array>
      | undefined
    const reader = stream?.getReader?.()
    if (reader) {
      const dec = new TextDecoder()
      pump = (async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          err += dec.decode(value, { stream: true })
        }
      })()
    }
    proc.exited.then(async (code) => {
      if (pump) {
        await pump
      }
      if (code === 0) {
        resolveP()
      } else {
        rejectP(
          new Error(`${cmd[0]} failed (exit ${code}): ${err.slice(0, 300)}`),
        )
      }
    })
  })
}

interface LdapServer {
  baseDn: string
  bindDn: string
  bindPassword: string
  container: string
  groupBaseDn: string
  stop: () => Promise<void>
  url: string
}

async function startLdap(): Promise<LdapServer> {
  // Build the test directory image on first use (cached after that):
  // osixia/openldap + an ACL granting the CRM service account read
  // access to the tree (the default ACL is self-read only).
  const build = await docker([
    'build',
    '-q',
    '-t',
    LDAP_IMAGE,
    `${REPO}/deploy/ldap-test`,
  ])
  if (build.code !== 0) {
    throw new Error(`docker build failed: ${build.err.slice(0, 300)}`)
  }
  const container = `crm-ldap-${Date.now().toString(36)}`
  const port = 10_389 + Math.floor(Math.random() * 100)
  const stop = async (): Promise<void> => {
    await docker(['rm', '-f', container])
  }
  const up = await docker([
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `${port}:389`,
    '-e',
    `LDAP_ADMIN_PASSWORD=${ADMIN_PASS}`,
    '-e',
    'LDAP_TLS=0',
    '-e',
    'LDAP_ORGANISATION=Example Inc',
    '-e',
    'LDAP_DOMAIN=example.com',
    LDAP_IMAGE,
  ])
  if (up.code !== 0) {
    throw new Error(`docker run failed: ${up.err.slice(0, 300)}`)
  }
  try {
    await waitFor(
      async () => {
        const r = await docker([
          'exec',
          container,
          'ldapwhoami',
          '-x',
          '-H',
          'ldap://localhost',
        ])
        if (r.code !== 0) {
          throw new Error('ldap not ready yet')
        }
      },
      30,
      1000,
    )
    // load the test tree as the container admin
    await runLdapStream(
      container,
      [
        'ldapadd',
        '-x',
        '-H',
        'ldap://localhost',
        '-D',
        `cn=admin,${BASE}`,
        '-w',
        ADMIN_PASS,
      ],
      TEST_LDIF,
    )
    // wait until the service account can actually bind — the directory
    // accepts anonymous queries slightly before the ACLs and entries
    // needed by the CRM service account are fully usable
    await waitFor(
      async () => {
        const r = await docker([
          'exec',
          container,
          'ldapwhoami',
          '-x',
          '-H',
          'ldap://localhost',
          '-D',
          'cn=crm-service,ou=people,dc=example,dc=com',
          '-w',
          'svc-pw-1',
        ])
        if (r.code !== 0) {
          throw new Error('service account not ready yet')
        }
      },
      20,
      500,
    )
    return {
      bindDn: `cn=crm-service,${PEOPLE}`,
      bindPassword: 'svc-pw-1',
      baseDn: PEOPLE,
      container,
      groupBaseDn: GROUPS,
      url: `ldap://127.0.0.1:${port}`,
      stop,
    }
  } catch (e) {
    await stop()
    throw e
  }
}

/** Server config with LDAP wired to the test container. */
function ldapConfig(dbPath: string, ldap: LdapServer, extra = ''): string {
  return `[database]
path = "${dbPath}"

[auth]
default_role = "none"

[ldap]
enabled = true
url = "${ldap.url}"
starttls = false
base_dn = "${ldap.baseDn}"
bind_dn = "${ldap.bindDn}"
bind_password_env = "CRM_LDAP_BIND_PASSWORD"
user_filter = "(uid={username})"
group_base_dn = "${ldap.groupBaseDn}"

[ldap.roles]
"cn=crm-admins,${ldap.groupBaseDn}" = "admin"
"cn=crm-writers,${ldap.groupBaseDn}" = "writer"

${extra}
`
}

/** Call auth.login directly (a failed login is a normal RPC error). */
async function attemptLogin(
  port: number,
  username: string,
  password: string,
): Promise<{
  code?: string
  message?: string
  role?: string
  token?: string
}> {
  const c = await connect(port)
  try {
    const res = await c.call<{
      token: string
      user: { role: string; username: string }
    }>('auth.login', { username, password })
    return { role: res.user.role, token: res.token }
  } catch (e) {
    return {
      code: (e as { code?: string }).code,
      message: (e as Error).message,
    }
  } finally {
    c.close()
  }
}

describe.skipIf(NO_DOCKER)('P6 LDAP: directory login', () => {
  let ldap: LdapServer | null = null
  let starting: Promise<LdapServer> | null = null

  /**
   * Lazy container start: the first test to need it boots the LDAP
   * container. Test bodies carry explicit 90s timeouts, which cover the
   * pull + boot (beforeAll would only get bun's 5s default).
   */
  function ensureLdap(): Promise<LdapServer> {
    if (ldap) {
      return Promise.resolve(ldap)
    }
    if (!starting) {
      const info = Bun.spawnSync(['docker', 'info'], { env: process.env })
      if (info.exitCode !== 0) {
        throw new Error('docker daemon not running — start Docker Desktop')
      }
      starting = (async () => {
        try {
          const l = await startLdap()
          ldap = l
          return l
        } finally {
          starting = null
        }
      })()
    }
    return starting
  }

  /** ldapmodify as the directory admin (root of the test container). */
  async function ldapModify(ldif: string): Promise<void> {
    await runLdapStream(
      (await ensureLdap()).container,
      [
        'ldapmodify',
        '-x',
        '-H',
        'ldap://localhost',
        '-D',
        `cn=admin,${BASE}`,
        '-w',
        ADMIN_PASS,
      ],
      ldif,
    )
  }

  /** LDIF moving bob into (or out of) the CRM admin group. */
  function bobInAdmins(operation: 'add' | 'delete'): string {
    return `dn: cn=crm-admins,${GROUPS}\nchangetype: modify\n${operation}: uniqueMember\nuniqueMember: uid=bob,${PEOPLE}\n`
  }

  afterAll(async () => {
    await starting?.catch(() => undefined)
    if (ldap) {
      await ldap.stop()
    }
  })

  test('directory user with mapped group JIT-provisions with the group role', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        // no owner bootstrap needed for a pure-ldap server, but the
        // users table starts empty → login still works (JIT)
        const res = await attemptLogin(server.port, 'alice', 'alice-pw-1')
        expect(res.code, res.message).toBeUndefined()
        expect(res.role).toBe('admin')

        // the JIT row is visible to the server: token authenticates
        const c = await connect(server.port, res.token ?? '')
        const rows = await c.call<{ rows: Record<string, unknown>[] }>(
          'contact.list',
          {},
        )
        expect(Array.isArray(rows.rows)).toBe(true)
        c.close()
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('wrong password → AUTH error, no fallback to local account of same name', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        const owner = await bootstrapOwner(server)
        const c = await connect(server.port, owner.token)
        // a LOCAL account with the SAME username — the directory must
        // win, so the local password is never consulted
        await c.call('admin.user.create', {
          username: 'bob',
          role: 'writer',
        })
        c.close()

        const bad = await attemptLogin(server.port, 'bob', 'wrong-password')
        expect(bad.code).toBe('AUTH')
        expect(bad.message).not.toMatch(/local/i)
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('directory user in no mapped group gets default_role none → FORBIDDEN', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        const res = await attemptLogin(server.port, 'dave', 'dave-pw-1')
        expect(res.code, res.message).toBeUndefined()
        expect(res.role).toBe('none')
        // token authenticates but every data method is FORBIDDEN
        const c = await connect(server.port, res.token ?? '')
        let forbidden = ''
        try {
          await c.call('contact.list', {})
        } catch (e) {
          forbidden = (e as { code?: string }).code ?? ''
        }
        expect(forbidden).toBe('FORBIDDEN')
        c.close()
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('injection-style username is rejected cleanly, no row created', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        const res = await attemptLogin(
          server.port,
          'x)(uid=*)(uid=',
          'anything',
        )
        expect(res.code).toBe('AUTH')
        expect(res.message ?? '').not.toMatch(/ldapts|InvalidFilter/i)
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('unreachable directory → clean AUTH error, no local fallback', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      // ldap on a closed port; local account with same username exists
      const l = await ensureLdap()
      const body = ldapConfig(dbPath, l).replace(
        `url = "${l.url}"`,
        'url = "ldap://127.0.0.1:1"',
      )
      const server = await startServer(dbPath, {
        configBody: body,
        env: LDAP_ENV,
      })
      try {
        const owner = await bootstrapOwner(server)
        const c = await connect(server.port, owner.token)
        await c.call('admin.user.create', {
          username: 'alice',
          role: 'writer',
        })
        c.close()
        const res = await attemptLogin(
          server.port,
          'alice',
          'local-fallback-pw',
        )
        expect(res.code).toBe('AUTH')
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('username not in the directory falls back to local password auth', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        const owner = await bootstrapOwner(server)
        const c = await connect(server.port, owner.token)
        const created = await c.call<{ initial_password: string }>(
          'admin.user.create',
          {
            username: 'eve',
            role: 'writer',
          },
        )
        c.close()
        const res = await attemptLogin(
          server.port,
          'eve',
          created.initial_password,
        )
        expect(res.code, res.message).toBeUndefined()
        expect(res.role).toBe('writer')
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('group membership change is picked up on the next login', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        // undo a promotion an earlier aborted run may have left behind:
        // ldapmodify refuses to add a value that is already there (68),
        // and every test here shares one directory container
        await ldapModify(bobInAdmins('delete')).catch(() => undefined)
        const first = await attemptLogin(server.port, 'bob', 'bob-pw-1')
        expect(first.role).toBe('writer')
        await ldapModify(bobInAdmins('add'))
        const second = await attemptLogin(server.port, 'bob', 'bob-pw-1')
        expect(second.role).toBe('admin')
        // put the directory back: a permanent promotion here leaks role
        // state into whichever test runs next
        await ldapModify(bobInAdmins('delete'))
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 120_000)

  test('disabled directory user is rejected even with a valid password', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        // bootstrap first, while the users table is still empty
        const owner = await bootstrapOwner(server)
        const ok = await attemptLogin(server.port, 'alice', 'alice-pw-1')
        expect(ok.code).toBeUndefined()
        // disable the JIT row locally (incident response)
        const c = await connect(server.port, owner.token)
        await c.call('admin.user.disable', { username: 'alice' })
        c.close()
        const denied = await attemptLogin(server.port, 'alice', 'alice-pw-1')
        expect(denied.code).toBe('AUTH')
        expect(denied.message).toMatch(/disabled/)

        // the directory matches uids case-insensitively (caseIgnoreMatch),
        // so a differently-cased login must land on the same CRM row — a
        // second row would sidestep disabled_at entirely
        const variant = await attemptLogin(server.port, 'ALICE', 'alice-pw-1')
        expect(variant.code).toBe('AUTH')
        expect(variant.message).toMatch(/disabled/)
        expect(variant.token).toBeUndefined()

        const c2 = await connect(server.port, owner.token)
        const users = await c2.call<{ users: { username: string }[] }>(
          'admin.user.list',
          {},
        )
        c2.close()
        expect(
          users.users.filter((u) => u.username.toLowerCase() === 'alice'),
        ).toHaveLength(1)
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('a username matching several directory entries is refused', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      // a filter that several test users satisfy — picking "the first
      // entry" here would hand out whichever identity the directory
      // happened to return
      const body = ldapConfig(dbPath, l).replace(
        'user_filter = "(uid={username})"',
        'user_filter = "(mail=*@example.com)"',
      )
      const server = await startServer(dbPath, {
        configBody: body,
        env: LDAP_ENV,
      })
      try {
        const res = await attemptLogin(server.port, 'alice', 'alice-pw-1')
        expect(res.code).toBe('AUTH')
        expect(res.message ?? '').toMatch(/ambiguous/i)
        expect(res.token).toBeUndefined()
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)

  test('a directory that accepts but never answers fails in seconds', async () => {
    const { dbPath, cleanup } = freshDb()
    // a TCP sink: the connect succeeds, nothing ever answers. Without a
    // request timeout the login promise never settles and the socket
    // leaks with it.
    const hung: import('node:net').Socket[] = []
    const sink = createServer((sock) => {
      hung.push(sock)
      sock.on('data', () => undefined)
    })
    await new Promise<void>((resolveP) => sink.listen(0, '127.0.0.1', resolveP))
    const sinkPort = (sink.address() as AddressInfo).port
    try {
      const l = await ensureLdap()
      const body = ldapConfig(dbPath, l)
        .replace(`url = "${l.url}"`, `url = "ldap://127.0.0.1:${sinkPort}"`)
        .replace('starttls = false', 'starttls = false\ntimeout_ms = 1500')
      const server = await startServer(dbPath, {
        configBody: body,
        env: LDAP_ENV,
      })
      try {
        const started = Date.now()
        const res = await attemptLogin(server.port, 'alice', 'alice-pw-1')
        const elapsed = Date.now() - started
        expect(res.code).toBe('AUTH')
        expect(res.message ?? '').toMatch(/unreachable/i)
        // the client's own deadline is 10s; the server must fail first
        expect(elapsed).toBeLessThan(9000)
      } finally {
        await server.close()
      }
    } finally {
      for (const s of hung) {
        s.destroy()
      }
      sink.close()
      cleanup()
    }
  }, 90_000)

  test("a directory user's role follows groups, not set-role", async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const l = await ensureLdap()
      const server = await startServer(dbPath, {
        configBody: ldapConfig(dbPath, l),
        env: LDAP_ENV,
      })
      try {
        const owner = await bootstrapOwner(server)
        const jit = await attemptLogin(server.port, 'bob', 'bob-pw-1')
        expect(jit.role).toBe('writer')
        const c = await connect(server.port, owner.token)
        let message = ''
        let code = ''
        try {
          await c.call('admin.user.set-role', {
            username: 'bob',
            role: 'reader',
          })
        } catch (e) {
          code = (e as { code?: string }).code ?? ''
          message = (e as Error).message
        }
        c.close()
        // silently reverting on the next login would be the worse failure
        expect(code).toBe('INVALID')
        expect(message).toMatch(/group/)
        const again = await attemptLogin(server.port, 'bob', 'bob-pw-1')
        expect(again.role).toBe('writer')
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 90_000)
})
