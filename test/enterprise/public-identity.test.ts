/**
 * D-A: server public identity. The advertised client address
 * (`[serve] public_host` / `public_port`) flows through every
 * onboarding surface: startup hint, console Clients tab,
 * /download/crm.toml, /download/install.sh, and the config view.
 * Absent fields reproduce the bind-derived behavior exactly.
 */
import { describe, expect, test } from 'bun:test'

import {
  bootstrapOwner,
  freshDb,
  startServer,
  type TestServer,
} from './helpers'

async function withServer<T>(
  configBody: string | undefined,
  fn: (
    server: TestServer,
    owner: { username: string; password: string },
  ) => Promise<T>,
): Promise<T> {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath, {
    configBody,
    args: ['--admin-port', '0'],
  })
  try {
    const owner = await bootstrapOwner(server)
    return await fn(server, owner)
  } finally {
    await server.close()
    cleanup()
  }
}

async function download(base: string, path: string): Promise<string> {
  const res = await fetch(`${base}${path}`)
  if (res.status !== 200) {
    throw new Error(`GET ${path} → HTTP ${res.status}`)
  }
  return res.text()
}

describe('server public identity (D-A)', () => {
  test('public_host + public_port: every onboarding surface advertises the public address', async () => {
    await withServer(
      `[serve]
public_host = "crm.corp.example"
public_port = 443
`,
      async (server) => {
        const base = `http://127.0.0.1:${server.adminPort}`

        // startup hint
        expect(server.log()).toContain(
          'clients: crm login crm.corp.example:443',
        )

        // preconfigured config download
        const toml = await download(base, '/download/crm.toml')
        expect(toml).toContain('server = "crm.corp.example:443"')

        // install script
        const sh = await download(base, '/download/install.sh')
        expect(sh).toContain('crm.corp.example:443')

        // the Clients tab renders from the same /api surfaces:
        // the page must carry the advertised address
        const page = await (await fetch(`${base}/`)).text()
        expect(page).toContain('crm.corp.example:443')
      },
    )
  }, 60_000)

  test('public_host alone keeps the real bound port', async () => {
    await withServer(
      `[serve]
public_host = "crm.corp.example"
`,
      async (server) => {
        const toml = await download(
          `http://127.0.0.1:${server.adminPort}`,
          '/download/crm.toml',
        )
        expect(toml).toContain(`server = "crm.corp.example:${server.port}"`)
      },
    )
  }, 60_000)

  test('absent public identity: bind-derived address, exactly as before', async () => {
    await withServer(undefined, async (server) => {
      const toml = await download(
        `http://127.0.0.1:${server.adminPort}`,
        '/download/crm.toml',
      )
      // the test server binds the loopback default
      expect(toml).toContain(`server = "127.0.0.1:${server.port}"`)
    })
  })

  test('install.sh actually installs crm and re-checks PATH', async () => {
    // Live-testing regression: the script used `bunx crm.cli --version`,
    // which runs the package once and never puts `crm` on PATH — the
    // final `crm login` step then failed with "command not found".
    await withServer(undefined, async (server) => {
      const sh = await download(
        `http://127.0.0.1:${server.adminPort}`,
        '/download/install.sh',
      )
      // a real global install, not a one-shot runner
      expect(sh).toContain('bun install -g crm.cli')
      expect(sh).not.toContain('bunx')
      // the script must not declare success while `crm` is missing:
      // a final PATH check with an actionable warning
      expect(sh).toContain('still not on PATH')
      expect(sh).toContain('bun pm bin -g')
    })
  })

  test('config view surfaces the advertised address (or bind-derived)', async () => {
    await withServer(
      `[serve]
public_host = "crm.corp.example"
public_port = 443
`,
      async (server, owner) => {
        const base = `http://127.0.0.1:${server.adminPort}`
        // /api/config requires auth; log in over the console surface
        const login = await fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: owner.username,
            password: owner.password,
          }),
        }).then((r) => r.json() as Promise<{ token: string }>)
        const cfg = await fetch(`${base}/api/config`, {
          headers: { authorization: `Bearer ${login.token}` },
        }).then(
          (r) =>
            r.json() as Promise<{
              serve: { rpc_host: string; rpc_port: number }
            }>,
        )
        expect(cfg.serve.rpc_host).toBe('crm.corp.example')
        expect(cfg.serve.rpc_port).toBe(443)
      },
    )
  }, 60_000)
})

describe('server-controlled client install source (D-A2)', () => {
  test('install_source is injected into install.sh as the install command', async () => {
    // crm.cli is not (yet) on public npm — an enterprise server must be
    // able to point the bootstrap at its own mirror or git host.
    await withServer(
      `[serve]
install_source = "git+ssh://git@corp.internal/crm/crm-cli.git"
`,
      async (server) => {
        const sh = await download(
          `http://127.0.0.1:${server.adminPort}`,
          '/download/install.sh',
        )
        expect(sh).toContain(
          'bun install -g git+ssh://git@corp.internal/crm/crm-cli.git',
        )
        // the default package name must not compete with the configured
        // source
        expect(sh).not.toContain('bun install -g crm.cli')
      },
    )
  }, 60_000)

  test('absent install_source falls back to the public package and names the fix', async () => {
    await withServer(undefined, async (server) => {
      const sh = await download(
        `http://127.0.0.1:${server.adminPort}`,
        '/download/install.sh',
      )
      expect(sh).toContain('bun install -g crm.cli')
      // the failure branch must tell the operator how to fix it server-side
      expect(sh).toContain('install_source')
    })
  })

  test('config view surfaces install_source', async () => {
    await withServer(
      `[serve]
install_source = "git+https://git.corp.internal/crm/crm-cli.git"
`,
      async (server, owner) => {
        const base = `http://127.0.0.1:${server.adminPort}`
        const login = await fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: owner.username,
            password: owner.password,
          }),
        }).then((r) => r.json() as Promise<{ token: string }>)
        const cfg = await fetch(`${base}/api/config`, {
          headers: { authorization: `Bearer ${login.token}` },
        }).then((r) => r.json() as Promise<{ serve: Record<string, unknown> }>)
        expect(cfg.serve.install_source).toBe(
          'git+https://git.corp.internal/crm/crm-cli.git',
        )
      },
    )
  }, 60_000)
})

describe('config surface completion (D-B)', () => {
  const CONFIG = `[serve]
public_host = "crm.corp.example"

[backup]
destination = "file:///tmp/crm-backup-test"

[activity]
types = ["call", "email", "wechat"]

[pipeline]
stages = ["lead", "qualified", "won"]
won_stage = "won"
lost_stage = "lost"
`

  async function loginToken(
    base: string,
    owner: { username: string; password: string },
  ): Promise<string> {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: owner.username,
        password: owner.password,
      }),
    }).then((r) => r.json() as Promise<{ token: string }>)
    return login.token
  }

  test('config view gains database/backup/activity/pipeline + the file path', async () => {
    await withServer(CONFIG, async (server, owner) => {
      const base = `http://127.0.0.1:${server.adminPort}`
      const token = await loginToken(base, owner)
      const cfg = await fetch(`${base}/api/config`, {
        headers: { authorization: `Bearer ${token}` },
      }).then(
        (r) =>
          r.json() as Promise<{
            path: string
            database: { path: string }
            backup: { destination: string }
            activity: { types: string[] }
            pipeline: { stages: string[]; won_stage: string }
          }>,
      )
      expect(cfg.database.path).toBe(server.dbPath)
      expect(cfg.backup.destination).toBe('file:///tmp/crm-backup-test')
      expect(cfg.activity.types).toEqual(['call', 'email', 'wechat'])
      expect(cfg.pipeline.stages).toEqual(['lead', 'qualified', 'won'])
      // the resolved file, not a guess — the operator needs to know
      // which crm.toml to edit
      expect(cfg.path).not.toMatch(/\(defaults\)/)
      expect(cfg.path).toMatch(/server\.toml$/)
    })
  }, 60_000)

  test('config view carries a sanitized TOML with no secret material', async () => {
    await withServer(CONFIG, async (server, owner) => {
      const base = `http://127.0.0.1:${server.adminPort}`
      const token = await loginToken(base, owner)
      const cfg = await fetch(`${base}/api/config`, {
        headers: { authorization: `Bearer ${token}` },
      }).then(
        (r) =>
          r.json() as Promise<{
            toml: string
            mail: { password_set: boolean }
          }>,
      )
      const toml = cfg.toml
      // effective values are present, ready to copy into a new crm.toml
      expect(toml).toContain('[backup]')
      expect(toml).toContain('destination = "file:///tmp/crm-backup-test"')
      expect(toml).toContain('[pipeline]')
      // secrets never cross the wire: not the SMTP password and not
      // any bind password, in neither the TOML nor the raw view
      expect(toml).not.toContain('smtp-secret-pw')
      expect(JSON.stringify(cfg)).not.toContain('smtp-secret-pw')
      expect(cfg.mail.password_set).toBe(false)
    })
  }, 60_000)

  test('console page renders the config path, copyable TOML, and restart note', async () => {
    await withServer(CONFIG, async (server) => {
      const page = await (
        await fetch(`http://127.0.0.1:${server.adminPort}/`)
      ).text()
      // the Config tab must expose the TOML block and tell the
      // operator that changes need a restart
      expect(page).toContain('id="cfgTOML"')
      expect(page).toMatch(/restart/i)
    })
  }, 60_000)
})
