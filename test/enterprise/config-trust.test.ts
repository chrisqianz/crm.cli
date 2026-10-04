import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bootstrapOwner, CRM, freshDb, startServer } from './helpers'

/**
 * Config trust boundary (spec/enterprise.md, "Config discovery").
 *
 * `crm` finds a config by walking up from the cwd, so a `crm.toml` checked
 * into some directory you happened to run a command from is *discovered*
 * config — semi-trusted, like `[hooks]`. `[auth]` and `[ldap]` are
 * different from `[phone]`: they decide who is allowed to log in and with
 * what role, so a discovered config may not supply them.
 */

const tempDirs: string[] = []

function tempProject(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crm-trust-proj-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'nested'), { recursive: true })
  writeFileSync(join(dir, 'crm.toml'), config)
  return dir
}

interface Boot {
  code: number | null
  err: string
  out: string
  port: number | null
}

/**
 * Start `crm serve` with a given cwd and no CRM_CONFIG, and report either
 * the exit code (refused) or the port it became ready on (accepted).
 */
async function bootServe(
  cwd: string,
  env: Record<string, string> = {},
): Promise<Boot> {
  // freshDb's temp dir is registered for teardown by path, so the
  // returned cleanup is intentionally not held here
  const { dbPath } = freshDb()
  tempDirs.push(join(dbPath, '..'))
  const proc = Bun.spawn(['bun', 'run', CRM, 'serve', '--port', '0'], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CRM_DB: dbPath,
      // so that a config which *isn't* refused would genuinely get as far
      // as starting (a missing bind password fails for a different reason)
      CRM_ALLOW_INSECURE_LDAP: '1',
      CRM_LDAP_BIND_PASSWORD: 'x',
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let out = ''
  let err = ''
  const drain = async (
    stream: ReadableStream<Uint8Array> | null,
    append: (s: string) => void,
  ): Promise<void> => {
    if (!stream) {
      return
    }
    const reader = stream.getReader()
    const dec = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      append(dec.decode(value, { stream: true }))
    }
  }
  const readers = [
    drain(proc.stdout, (s) => {
      out += s
    }),
    drain(proc.stderr, (s) => {
      err += s
    }),
  ]
  const state = { code: null as number | null }
  const exited = proc.exited.then((c) => {
    state.code = c
  })

  const deadline = Date.now() + 20_000
  while (state.code === null && Date.now() < deadline) {
    if (/READY\s+\d+/.test(out + err)) {
      break
    }
    await Bun.sleep(50)
  }
  const portMatch = /READY\s+(\d+)/.exec(out + err)
  const port = portMatch ? Number(portMatch[1]) : null
  if (port !== null) {
    proc.kill('SIGKILL')
  }
  await Promise.race([exited, Bun.sleep(3000)])
  await Promise.race([Promise.allSettled(readers), Bun.sleep(1000)])

  return { code: state.code, err, out, port }
}

/** `[ldap]` as written by an operator — valid in every way except where it lives. */
const LDAP_BLOCK = `[ldap]
enabled = true
url = "ldap://127.0.0.1:1389"
starttls = false
base_dn = "ou=people,dc=example,dc=com"
bind_dn = "cn=crm-service,ou=people,dc=example,dc=com"
bind_password_env = "CRM_LDAP_BIND_PASSWORD"
user_filter = "(uid={username})"

[ldap.roles]
"cn=crm-admins,ou=groups,dc=example,dc=com" = "admin"
`

describe('config trust: discovered configs cannot define authentication', () => {
  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('serve refuses [ldap] from a project-discovered config', async () => {
    const cwd = tempProject(`[phone]
display = "national"

${LDAP_BLOCK}`)
    const booted = await bootServe(cwd)
    expect(booted.port).toBeNull()
    expect(booted.code).not.toBe(0)
    const combined = booted.out + booted.err
    expect(combined).toMatch(/refusing to start/i)
    expect(combined).toMatch(/project-discovered config/)
    expect(combined).toMatch(/\[ldap\]/)
  }, 30_000)

  test('serve refuses [auth] from a project-discovered config', async () => {
    const cwd = tempProject(`[auth]
default_role = "admin"
`)
    const booted = await bootServe(cwd)
    expect(booted.port).toBeNull()
    expect(booted.code).not.toBe(0)
    const combined = booted.out + booted.err
    expect(combined).toMatch(/refusing to start/i)
    expect(combined).toMatch(/\[auth\]/)
  }, 30_000)

  test('discovery walks up, so a nested cwd is still refused', async () => {
    const cwd = tempProject(LDAP_BLOCK)
    const booted = await bootServe(join(cwd, 'nested'))
    expect(booted.port).toBeNull()
    expect(booted.code).not.toBe(0)
    expect(booted.out + booted.err).toMatch(/refusing to start/i)
  }, 30_000)

  test('the identical [ldap] is accepted from an explicit config', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      // Same content, explicitly selected (CRM_CONFIG): a trusted source.
      const server = await startServer(dbPath, {
        configBody: `[database]
path = "${dbPath}"

[auth]
default_role = "none"

${LDAP_BLOCK}`,
        env: {
          // transport refusal is asserted elsewhere; here the point is
          // that an explicitly selected config is trusted
          CRM_ALLOW_INSECURE_LDAP: '1',
          CRM_LDAP_BIND_PASSWORD: 'x',
        },
      })
      try {
        const owner = await bootstrapOwner(server)
        expect(owner.token.length).toBeGreaterThan(10)
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
    }
  }, 30_000)

  test('an ordinary project config still starts serve', async () => {
    const cwd = tempProject(`[phone]
default_country = "US"

[pipeline]
stages = ["lead", "closed-won"]
`)
    const booted = await bootServe(cwd)
    expect(booted.err).toMatch(/^$/)
    expect(booted.port).not.toBeNull()
  }, 30_000)

  test('non-serve commands warn about it instead of refusing', async () => {
    const cwd = tempProject(LDAP_BLOCK)
    const { dbPath, cleanup } = freshDb()
    // A saved ~/.crm/credentials on the host would flip this command to
    // remote mode and read a different database — isolate HOME so the
    // test proves the local-mode contract no matter who ran it last.
    const home = mkdtempSync(join(tmpdir(), 'crm-config-trust-home-'))
    try {
      const proc = Bun.spawn(['bun', 'run', CRM, 'contact', 'list'], {
        cwd,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CRM_DB: dbPath,
          HOME: home,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code).toBe(0)
      // the command ran normally — it just lost the sections it must not
      // have been given (default format prints nothing for an empty list)
      expect(out).toMatch(/^\s*$/)
      expect(err).toMatch(/ignoring \[auth\]\/\[ldap\]/i)
      expect(err).toMatch(/project-discovered config/)
    } finally {
      cleanup()
    }
  }, 30_000)
})
