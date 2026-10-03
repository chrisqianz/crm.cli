/**
 * Dying TCP proxy for the reconnect tests.
 *
 * Forwards TCP traffic to argv[2] (target port), except the very FIRST
 * accepted connection, which is closed immediately — a transport-level
 * death the client cannot confuse with a structured RPC error.
 *
 * Two sandbox realities shape this file:
 *  1. It runs as its OWN process: the sandbox stalls a local TLS chain
 *     when a process listens and connects through that listener in itself.
 *  2. It forwards with Bun.listen/Bun.connect, NOT node:net pipe(): in
 *     bun 1.3.14 (macOS x64) a node:net relay silently swallows TLS
 *     handshakes, so no client completes one through it. Bun's native
 *     sockets pass bytes.
 *
 * Protocol on stdout:
 *   PROXY_READY <port>                              once listening
 *   ACCEPT {"accepts":n,"forwarded":m} [KILLED]     once per connection
 */

const target = Number(process.argv[2])
if (!Number.isInteger(target) || target <= 0) {
  console.error('usage: dying-proxy.ts <target-port>')
  process.exit(2)
}

let first = true
let killRemaining = Number(process.env.KILL_N ?? '1')
const stats = { accepts: 0, forwarded: 0 }

// bun 1.3.14's shipped types lag the runtime here: Sockets do carry
// destroy(), and Server.ref is assignable. Keep the cast in one place.
interface Killable {
  destroy(): void
  write(data: string | Uint8Array): number
}
const kill = (s: unknown) => (s as Killable).destroy()

// relay state per client, tracked here rather than in socket .data so the
// lagging Bun socket typings stay out of the logic
interface Pair {
  buf: Buffer[]
  up?: Killable
}
const pairs = new Map<unknown, Pair>()

const server = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open(client) {
      stats.accepts += 1
      if (first) {
        first = false
      }
      if (killRemaining > 0) {
        killRemaining -= 1
        console.log(`ACCEPT ${JSON.stringify(stats)} KILLED`)
        kill(client)
        return
      }
      stats.forwarded += 1
      console.log(`ACCEPT ${JSON.stringify(stats)}`)
      const pair: Pair = { buf: [] }
      pairs.set(client, pair)
      Bun.connect({
        hostname: '127.0.0.1',
        port: target,
        socket: {
          open(up) {
            if (!pairs.has(client)) {
              kill(up)
              return
            }
            pair.up = up as unknown as Killable
            for (const chunk of pair.buf) {
              ;(up as unknown as Killable).write(chunk)
            }
            pair.buf = []
          },
          data(_up, chunk) {
            ;(client as unknown as Killable).write(chunk)
          },
          error() {
            kill(client)
          },
          close() {
            kill(client)
          },
        },
      })
    },
    data(client, chunk) {
      const pair = pairs.get(client)
      if (!pair) {
        return
      }
      if (pair.up) {
        pair.up.write(chunk)
      } else {
        pair.buf.push(Buffer.from(chunk))
      }
    },
    error(client) {
      pairs.delete(client)
    },
    close(client) {
      pairs.delete(client)
    },
  },
})

console.log(`PROXY_READY ${server.port}`)

// Keep the relay alive even when the parent closes our stdin. The listener
// itself is unreferenced so an orphaned proxy never outlives its parent:
// with Bun, a loop holding only unref'd handles exits on its own.
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  process.stdin.pause()
})
;(server as unknown as { ref: boolean }).ref = false
