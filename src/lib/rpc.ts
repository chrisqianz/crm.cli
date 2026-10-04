import tls, { type TLSSocket } from 'node:tls'

export class RpcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

interface Pending {
  reject: (e: Error) => void
  resolve: (v: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * NDJSON-over-TLS RPC client for `crm serve`.
 *
 * Frame in:  {"id":1,"method":"auth.login","params":{...}}\n
 * Frame out: {"id":1,"result":{...}} or {"id":1,"error":{"code":"AUTH","message":"..."}}\n
 *
 * The first frame on a connection must be one of auth.token / auth.login /
 * auth.bootstrap; the server refuses anything else with an AUTH error.
 */
export class RpcClient {
  private readonly socket: TLSSocket
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  private constructor(socket: TLSSocket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err) =>
      this.failAll(new Error(`connection error: ${err.message}`)),
    )
    socket.on('close', () => this.failAll(new Error('connection closed')))
  }

  static connect(
    port: number,
    host = '127.0.0.1',
    opts: { insecure?: boolean } = {},
  ): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        {
          host,
          port,
          // Production deployments should present a CA-signed cert; --insecure
          // disables verification for the self-signed default.
          rejectUnauthorized: opts.insecure !== true,
          servername: 'localhost',
        },
        () => resolve(new RpcClient(socket)),
      )
      socket.once('error', (err) => reject(err))
    })
  }

  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    if (this.socket.destroyed) {
      return Promise.reject(new RpcError('AUTH', 'connection closed'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new RpcError('INTERNAL', `timeout waiting for ${method} response`),
        )
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** End the write side, then destroy the socket outright: a plain `end()`
   * leaves the socket readable until the peer closes (minutes, under the
   * server's idle timeout), which holds the event loop open and parks a
   * half-open slot on the server's connection cap. */
  close(): void {
    this.socket.end()
    this.socket.destroy()
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx === -1) {
        break
      }
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) {
        continue
      }
      let msg: {
        id?: number
        result?: unknown
        error?: { code?: string; message?: string }
      }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // malformed line — never expected from our server
      }
      if (typeof msg.id !== 'number') {
        continue
      }
      const p = this.pending.get(msg.id)
      if (!p) {
        continue
      }
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        p.reject(
          new RpcError(
            msg.error.code ?? 'INTERNAL',
            msg.error.message ?? 'unknown error',
          ),
        )
      } else {
        p.resolve(msg.result)
      }
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
