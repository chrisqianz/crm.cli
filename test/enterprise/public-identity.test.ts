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
