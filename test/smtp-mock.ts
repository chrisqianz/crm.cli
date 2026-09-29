/**
 * In-process SMTP sink for email tests. Speaks just enough RFC 5321
 * (greeting, EHLO with optional AUTH LOGIN, MAIL/RCPT/DATA/QUIT) to
 * exercise the real client end to end on localhost.
 */

import type { AddressInfo } from 'node:net'
import net from 'node:net'

export interface CapturedMessage {
  auth?: { user: string; password: string }
  data: string
  from: string
  to: string[]
}

export interface MockSmtp {
  close: () => Promise<void>
  messages: CapturedMessage[]
  port: number
}

export function startMockSmtp(
  opts: { auth?: { user: string; password: string } } = {},
): Promise<MockSmtp> {
  const messages: CapturedMessage[] = []
  const server = net.createServer((socket) => {
    let buf = ''
    let from = ''
    const to: string[] = []
    let dataLines: string[] = []
    let inData = false
    let authUser = ''
    let authPass = ''
    let authStep = 0
    const send = (line: string) => socket.write(`${line}\r\n`)
    send('220 mock SMTP ready')
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      for (;;) {
        const nl = buf.indexOf('\r\n')
        if (nl < 0) {
          return
        }
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            messages.push({
              from,
              to,
              data: dataLines.join('\r\n'),
              ...(authUser
                ? { auth: { user: authUser, password: authPass } }
                : {}),
            })
            send('250 OK message accepted')
          } else {
            dataLines.push(line)
          }
          continue
        }
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO')) {
          send('250-mock relay')
          if (opts.auth) {
            send('250-AUTH LOGIN')
          }
          send('250 OK')
        } else if (upper.startsWith('AUTH LOGIN')) {
          authStep = 1
          send('334 VXNlcm5hbWU6')
        } else if (authStep === 1) {
          authUser = Buffer.from(line, 'base64').toString('utf8')
          authStep = 2
          send('334 UGFzc3dvcmQ6')
        } else if (authStep === 2) {
          authPass = Buffer.from(line, 'base64').toString('utf8')
          authStep = 0
          send('235 2.7.0 authenticated')
        } else if (upper.startsWith('MAIL FROM:')) {
          from = line.match(/<([^>]*)>/)?.[1] ?? ''
          send('250 2.1.0 OK')
        } else if (upper.startsWith('RCPT TO:')) {
          to.push(line.match(/<([^>]*)>/)?.[1] ?? '')
          send('250 2.1.5 OK')
        } else if (upper === 'DATA') {
          inData = true
          dataLines = []
          send('354 End data with <CR><LF>.<CR><LF>')
        } else if (upper === 'QUIT') {
          send('221 2.0.0 bye')
          socket.end()
        } else {
          send('250 OK')
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        messages,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          }),
      })
    })
  })
}
