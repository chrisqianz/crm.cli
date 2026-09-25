import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import tls, { type TLSSocket } from 'node:tls'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { certsDir, ensurePrivateDir } from '../lib/paths'
import { handleAuth, handleCommand, recordAudit, ServerError } from './handlers'

export interface ServeOptions {
  /** Present only while the users table is empty at boot. */
  bootstrapCode: string | null
  certOverride?: string
  config: CRMConfig
  db: DB
  host: string
  keyOverride?: string
  /** 0 = let the OS assign a free port (used by tests) */
  port: number
}

export const MAX_CONNECTIONS = 100
const MAX_MESSAGE_BYTES = 1024 * 1024
const IDLE_TIMEOUT_MS = 5 * 60_000

/**
 * Resolve TLS material. When no cert/key is configured (or the files are
 * missing), a self-signed pair is generated once with the system openssl
 * into ~/.crm/certs (0700). Production deployments should point [serve]
 * cert/key at CA-signed material.
 */
export function resolveCerts(
  config: CRMConfig,
  overrides: { cert?: string; key?: string } = {},
): { cert: string; key: string } {
  const certPath =
    overrides.cert || config.serve.cert || join(certsDir, 'server.crt')
  const keyPath =
    overrides.key || config.serve.key || join(certsDir, 'server.key')
  if (!(existsSync(certPath) && existsSync(keyPath))) {
    ensurePrivateDir(certsDir)
    const out = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '3650',
        '-nodes',
        '-subj',
        '/CN=crm.cli',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    if (out.status !== 0 || !existsSync(certPath) || !existsSync(keyPath)) {
      throw new Error(
        `crm serve: could not generate a self-signed certificate (openssl exited ${out.status}). ` +
          'Install openssl, or point [serve] cert/key in crm.toml at existing TLS material. ' +
          `openssl stderr: ${out.stderr?.toString().trim()}`,
      )
    }
  }
  return {
    cert: readFileSync(certPath, 'utf-8'),
    key: readFileSync(keyPath, 'utf-8'),
  }
}

/**
 * Start the CRM RPC server (NDJSON over TLS).
 *
 * Protocol: every connection's first frame must be auth.login / auth.token /
 * auth.bootstrap; after that the caller's identity is bound to the socket.
 * `GET /healthz` over the same port answers with a small HTTP response for
 * load balancers and orchestrators.
 */
export function startServer(opts: ServeOptions): Promise<tls.Server> {
  const { db, config, host, port, bootstrapCode } = opts
  const { cert, key } = resolveCerts(config, {
    cert: opts.certOverride,
    key: opts.keyOverride,
  })

  let connections = 0
  const server = tls.createServer({ key, cert }, (socket) => {
    connections++
    if (connections > MAX_CONNECTIONS) {
      socket.write(
        `${JSON.stringify({
          error: {
            code: 'INTERNAL',
            message: 'too many concurrent connections',
          },
        })}\n`,
      )
      socket.destroy()
      connections--
      return
    }

    const identity: {
      current: { id: string; username: string; role: string } | null
    } = {
      current: null,
    }
    const ctx = {
      bootstrapCode,
      ip: socket.remoteAddress ?? 'unknown',
    }
    let buffer = ''
    let busy = false
    const queued: string[] = []

    const respond = (
      id: number,
      result?: unknown,
      error?: ServerError | Error,
    ) => {
      if (socket.destroyed) {
        return
      }
      const frame = error
        ? JSON.stringify({
            id,
            error: { code: errorCode(error), message: error.message },
          })
        : JSON.stringify({ id, result })
      socket.write(`${frame}\n`)
    }

    const processLine = async (line: string) => {
      let msg: {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      try {
        msg = JSON.parse(line)
      } catch {
        respond(0, undefined, new ServerError('INVALID', 'malformed frame'))
        return
      }
      if (typeof msg.id !== 'number' || typeof msg.method !== 'string') {
        respond(
          (msg.id as number) ?? 0,
          undefined,
          new ServerError(
            'INVALID',
            'frame must have numeric id and string method',
          ),
        )
        return
      }
      try {
        if (identity.current === null) {
          const auth = await handleAuth(
            db,
            config,
            ctx,
            msg.method,
            msg.params ?? {},
          )
          identity.current = auth.identity
          respond(msg.id, auth.result)
        } else {
          const result = await handleCommand(
            db,
            { ip: ctx.ip },
            identity.current,
            msg.method,
            msg.params ?? {},
          )
          respond(msg.id, result)
        }
      } catch (e) {
        const err =
          e instanceof ServerError
            ? e
            : new ServerError(
                'INTERNAL',
                e instanceof Error ? e.message : String(e),
              )
        respond(msg.id, undefined, err)
      }
    }

    const enqueue = (line: string) => {
      queued.push(line)
      if (busy) {
        return
      }
      busy = true
      const pump = async () => {
        try {
          for (;;) {
            const next = queued.shift()
            if (next === undefined) {
              break
            }
            await processLine(next)
          }
        } finally {
          busy = false
        }
      }
      pump().catch((err) => {
        console.error('crm serve: frame processing failed:', err)
      })
    }

    let sniffed = false
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_MESSAGE_BYTES) {
        respond(0, undefined, new ServerError('INVALID', 'message too large'))
        socket.destroy()
        return
      }
      if (!sniffed) {
        sniffed = true
        if (chunk.slice(0, 4).toString() === 'GET ') {
          handleHealthz(socket)
          return
        }
      }
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) {
          enqueue(line)
        }
      }
    })

    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy())
    socket.on('close', () => {
      connections--
      if (identity.current) {
        recordAudit(db, {
          actor_id: identity.current.id,
          actor_name: identity.current.username,
          action: 'conn.closed',
          source: 'rpc',
          ip: ctx.ip,
        }).catch(() => undefined)
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const actual = (server.address() as AddressInfo).port
      console.log(`READY ${actual}`)
      resolve(server)
    })
  })
}

function errorCode(e: Error): string {
  return (e as Error & { code?: string }).code ?? 'INTERNAL'
}

function handleHealthz(socket: TLSSocket): void {
  socket.write(
    'HTTP/1.1 200 OK\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 11\r\n' +
      'Connection: close\r\n' +
      '\r\n' +
      '{"ok":true}',
  )
  socket.end()
}
