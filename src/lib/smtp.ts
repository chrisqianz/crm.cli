/**
 * Minimal SMTP client (RFC 5321 subset): EHLO, optional STARTTLS,
 * AUTH LOGIN, MAIL FROM / RCPT TO / DATA (dot-stuffed), QUIT.
 *
 * No dependency: the CRM's mail path must not pull in a full mail
 * stack. Plain TCP for relays that advertise nothing, STARTTLS when the
 * relay offers it and `secure` is off, implicit TLS when `secure` is on.
 */
import net from 'node:net'
import tls from 'node:tls'

export interface SmtpMessage {
  cc?: string[]
  from: string
  host: string
  password?: string
  port: number
  /** implicit TLS (typically port 465) */
  secure?: boolean
  subject: string
  text: string
  to: string[]
  user?: string
}

const TIMEOUT_MS = 30_000

interface Reply {
  code: number
  /** all lines, "NNN " prefixes stripped, joined with \n */
  text: string
}

/** Line-oriented SMTP reply reader (handles multi-line 250-… replies). */
class Reader {
  private readonly bufBox = { s: '' }
  private readonly ml = { code: 0, lines: [] as string[], active: false }
  private readonly queue: Reply[] = []
  private readonly waiters: ((r: Reply) => void)[] = []
  private closed = false

  constructor(socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.bufBox.s += chunk.toString('utf8')
      for (;;) {
        const nl = this.bufBox.s.indexOf('\r\n')
        if (nl < 0) {
          break
        }
        const line = this.bufBox.s.slice(0, nl)
        this.bufBox.s = this.bufBox.s.slice(nl + 2)
        this.pushLine(line)
      }
    })
    socket.on('close', () => this.fail())
  }

  private pushLine(line: string): void {
    const m = /^(\d{3})([\s-])?(.*)$/.exec(line)
    if (!m) {
      return
    }
    const code = Number(m[1])
    const text = m[3]
    if (this.ml.active && this.ml.code === code) {
      this.ml.lines.push(text)
      if (m[2] === '-') {
        return
      }
      const done = { code, text: this.ml.lines.join('\n') }
      this.ml.active = false
      this.ml.lines = []
      this.deliver(done)
      return
    }
    if (m[2] === '-') {
      this.ml.active = true
      this.ml.code = code
      this.ml.lines = [text]
      return
    }
    this.deliver({ code, text })
  }

  private deliver(r: Reply): void {
    const w = this.waiters.shift()
    if (w) {
      w(r)
    } else {
      this.queue.push(r)
    }
  }

  private fail(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    const w = this.waiters.shift()
    if (w) {
      w({ code: 0, text: 'connection closed' })
    }
  }

  read(): Promise<Reply> {
    const q = this.queue.shift()
    if (q) {
      return Promise.resolve(q)
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function buildMessage(m: SmtpMessage): string {
  const body = m.text.replace(/\r?\n/g, '\r\n')
  const dotStuffed = body
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? `.${l}` : l))
    .join('\r\n')
  const safeFrom = m.from.replace(/[^a-zA-Z0-9@.-]/g, '_')
  return (
    `From: ${m.from}\r\n` +
    `To: ${m.to.join(', ')}\r\n` +
    (m.cc && m.cc.length > 0 ? `Cc: ${m.cc.join(', ')}\r\n` : '') +
    `Subject: ${m.subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${safeFrom}>\r\n` +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Transfer-Encoding: 8bit\r\n' +
    `\r\n${dotStuffed}\r\n`
  )
}

/** Connect, authenticate, and send one message. Throws on SMTP errors. */
export async function smtpSend(m: SmtpMessage): Promise<void> {
  const guard = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`SMTP timeout talking to ${m.host}:${m.port}`))
    }, TIMEOUT_MS)
    t.unref()
  })
  const open = m.secure
    ? tls.connect({ host: m.host, port: m.port, rejectUnauthorized: true })
    : net.connect(m.port, m.host)
  // Attach the reader BEFORE the handshake completes: the server's
  // greeting can arrive in the same flight as the connect event, and a
  // late reader would drop it (then wait for the 30s guard).
  let socket: net.Socket = open
  let reader = new Reader(open)
  const opened = new Promise<void>((resolve, reject) => {
    open.once('error', reject)
    if (m.secure) {
      open.once('secureConnect', () => resolve())
    } else {
      open.once('connect', () => resolve())
    }
  })
  await Promise.race([opened, guard]).catch((e: Error) => {
    open.destroy()
    throw new Error(`cannot reach SMTP relay ${m.host}:${m.port}: ${e.message}`)
  })

  const expect = async (codes: number[], what: string): Promise<Reply> => {
    const r = await Promise.race([reader.read(), guard])
    if (!codes.includes(r.code)) {
      throw new Error(`SMTP ${what} failed: ${r.code} ${r.text}`)
    }
    return r
  }
  const cmd = (line: string, codes: number[], what: string): Promise<Reply> => {
    socket.write(`${line}\r\n`)
    return expect(codes, what)
  }

  try {
    await expect([220], 'greeting')
    const ehlo = () => cmd('EHLO crm.cli', [250], 'EHLO')
    const capsList = (r: Reply): string[] =>
      r.text.split('\n').map((l) => l.trim().toUpperCase())
    let capabilities = capsList(await ehlo())

    // STARTTLS upgrade (plain socket → TLS), then a fresh EHLO
    if (capabilities.includes('STARTTLS') && !m.secure) {
      await cmd('STARTTLS', [220], 'STARTTLS')
      const upgraded = await new Promise<net.Socket>((resolve, reject) => {
        const t = tls.connect({ socket, rejectUnauthorized: true }, () =>
          resolve(t),
        )
        t.once('error', reject)
      })
      const upgradedOpen = new Promise<void>((resolve, reject) => {
        upgraded.once('error', reject)
        upgraded.once('secureConnect', () => resolve())
      })
      await Promise.race([upgradedOpen, guard])
      socket = upgraded
      reader = new Reader(socket)
      capabilities = capsList(await ehlo())
    }

    if (m.user && m.password) {
      if (!capabilities.includes('AUTH LOGIN')) {
        throw new Error(
          `SMTP relay ${m.host}:${m.port} does not advertise AUTH LOGIN (caps: ${capabilities.join(' ') || 'none'})`,
        )
      }
      await cmd('AUTH LOGIN', [334], 'AUTH LOGIN')
      await cmd(b64(m.user), [334], 'AUTH LOGIN user')
      await cmd(b64(m.password), [235], 'AUTH LOGIN password')
    }

    await cmd(`MAIL FROM:<${m.from}>`, [250], 'MAIL FROM')
    for (const to of [...m.to, ...(m.cc ?? [])]) {
      await cmd(`RCPT TO:<${to}>`, [250, 251], `RCPT TO <${to}>`)
    }
    await cmd('DATA', [354], 'DATA')
    socket.write(`${buildMessage(m)}.\r\n`)
    await expect([250], 'message accepted')
    await cmd('QUIT', [221], 'QUIT')
    socket.end()
  } catch (e) {
    socket.destroy()
    if (e instanceof Error && e.message.startsWith('SMTP')) {
      throw e
    }
    throw e
  }
}
