/**
 * Task 5 — transport reconnect-once. A TCP proxy that kills the *first*
 * connection emulates a dead cached TLS socket in a long-lived process:
 * dispatch() must reconnect and retry exactly once — never loop.
 *
 * The proxy runs as its own process (see helpers/dying-proxy.ts): the test
 * sandbox stalls a local TLS chain when one process both listens and
 * connects through that listener, which is not a property of the product.
 */

import { expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  closeDispatchClient,
  dispatch,
  setDispatchKeepAlive,
} from '../../src/remote/dispatch'
import { bootstrapOwner, freshDb, startServer } from './helpers'

const PROXY_SCRIPT = join(import.meta.dir, 'helpers', 'dying-proxy.ts')

interface ProxyHandle {
  kill: () => Promise<void>
  port: number
  /** wait until the proxy has written fresh log lines (or ~800ms) */
  settle: () => Promise<void>
  /** parse the most recent ACCEPT line for {accepts, forwarded} */
  stats: () => { accepts: number; forwarded: number }
}

/** Spawn the dying proxy against `targetPort`; resolve once it reports its port. */
async function spawnDyingProxy(
  targetPort: number,
  env: Record<string, string> = {},
): Promise<ProxyHandle> {
  const p = Bun.spawn(['bun', PROXY_SCRIPT, String(targetPort)], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CRM_TEST_NO_EXIT_GUARD: '1', ...env },
  })
  const decode = new TextDecoder()
  let buf = ''
  // ONE persistent reader for the whole lifetime: re-acquiring the stream
  // reader later would hit a Bun ReadableStream that is already locked.
  const reading = (async () => {
    const r = p.stdout.getReader()
    try {
      for (;;) {
        const { value, done } = await r.read()
        if (done) {
          break
        }
        buf += decode.decode(value, { stream: true })
      }
    } catch {
      /* process killed */
    }
  })().catch(() => undefined)
  const deadline = Date.now() + 10_000
  while (!buf.includes('PROXY_READY') && Date.now() < deadline) {
    await Bun.sleep(50)
  }
  const m = buf.match(/PROXY_READY (\d+)/)
  if (!m) {
    p.kill()
    throw new Error('proxy exited before reporting a port')
  }
  const settle = async (): Promise<void> => {
    // give the relay a beat to flush its ACCEPT lines after a call
    const target = buf
    const t0 = Date.now()
    while (buf === target && Date.now() - t0 < 800) {
      await Bun.sleep(50)
    }
  }
  return {
    port: Number(m[1]),
    stats: () => {
      const lines = buf.split('\n').filter((l) => l.startsWith('ACCEPT '))
      const last = lines.at(-1)
      if (!last) {
        return { accepts: 0, forwarded: 0 }
      }
      return JSON.parse(
        last.slice('ACCEPT '.length).replace(/ KILLED$/, ''),
      ) as {
        accepts: number
        forwarded: number
      }
    },
    settle,
    kill: async () => {
      p.kill()
      await reading
    },
  }
}

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
}

test('dispatch reconnects exactly once after a transport failure', async () => {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  const saved: Record<string, string | undefined> = {}
  for (const k of ['CRM_SERVER', 'CRM_TOKEN', 'CRM_INSECURE']) {
    saved[k] = process.env[k]
  }
  try {
    const owner = await bootstrapOwner(server, 'owner')
    const proxy = await spawnDyingProxy(server.port)
    setEnv({
      CRM_SERVER: `127.0.0.1:${proxy.port}`,
      CRM_TOKEN: owner.token,
      CRM_INSECURE: '1',
    })
    setDispatchKeepAlive(true) // the REPL's long-lived-socket mode
    try {
      // The proxy kills connection #1; the cached-client path means the
      // transport death happens inside dispatch, which must reconnect and
      // retry EXACTLY once — never a third connection.
      const res = await dispatch<{ rows: unknown[] }>('contact.list', {
        limit: '5',
      })
      expect(res.rows).toEqual([])
      await proxy.settle()
      // the dead first connection + exactly one retry — never a third
      expect(proxy.stats()).toEqual({ accepts: 2, forwarded: 1 })
    } finally {
      closeDispatchClient()
      setDispatchKeepAlive(false)
      await proxy.kill()
    }
  } finally {
    setEnv(saved)
    await server.close()
    cleanup()
  }
}, 60_000)

test('two dead connections in a row fail the call instead of retrying again', async () => {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  const saved: Record<string, string | undefined> = {}
  for (const k of ['CRM_SERVER', 'CRM_TOKEN', 'CRM_INSECURE']) {
    saved[k] = process.env[k]
  }
  try {
    const owner = await bootstrapOwner(server, 'owner')
    // KILL_N=2: the retry is also killed. Exactly-once means the call
    // gives up there — a retry-until-success loop would open a third
    // connection and come back with rows instead of an error.
    const proxy = await spawnDyingProxy(server.port, { KILL_N: '2' })
    setEnv({
      CRM_SERVER: `127.0.0.1:${proxy.port}`,
      CRM_TOKEN: owner.token,
      CRM_INSECURE: '1',
    })
    setDispatchKeepAlive(true)
    try {
      let threw = false
      try {
        await dispatch('contact.list', { limit: '5' })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      await proxy.settle()
      expect(proxy.stats()).toEqual({ accepts: 2, forwarded: 0 })
    } finally {
      closeDispatchClient()
      setDispatchKeepAlive(false)
      await proxy.kill()
    }
  } finally {
    setEnv(saved)
    await server.close()
    cleanup()
  }
}, 60_000)

test('keepAlive caches one TLS client per server and a server switch drops it', async () => {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  const saved: Record<string, string | undefined> = {}
  for (const k of ['CRM_SERVER', 'CRM_TOKEN', 'CRM_INSECURE']) {
    saved[k] = process.env[k]
  }
  try {
    const owner = await bootstrapOwner(server, 'owner')
    const a = await spawnDyingProxy(server.port)
    const b = await spawnDyingProxy(server.port)
    setEnv({ CRM_TOKEN: owner.token, CRM_INSECURE: '1' })
    setDispatchKeepAlive(true)
    try {
      process.env.CRM_SERVER = `127.0.0.1:${a.port}`
      await dispatch('contact.list', { limit: '1' })
      await dispatch('contact.list', { limit: '1' })
      // a's first connection is killed by design, the retry succeeds, and
      // the second call must ride the cached client — accepts stays at 2
      await a.settle()
      expect(a.stats()).toEqual({ accepts: 2, forwarded: 1 })
      // a different server must not reuse the cached connection
      process.env.CRM_SERVER = `127.0.0.1:${b.port}`
      await dispatch('contact.list', { limit: '1' })
      await b.settle()
      expect(b.stats()).toEqual({ accepts: 2, forwarded: 1 })
    } finally {
      closeDispatchClient()
      setDispatchKeepAlive(false)
      await a.kill()
      await b.kill()
    }
  } finally {
    setEnv(saved)
    await server.close()
    cleanup()
  }
}, 60_000)
