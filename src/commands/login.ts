import type { Command } from 'commander'

import { die, gInsecure } from '../lib/helpers'
import { promptLine, promptSecret } from '../lib/prompt'
import { RpcClient } from '../lib/rpc'
import {
  clearSession,
  loadSession,
  resolveServerAddr,
  saveSession,
} from '../lib/session'

// `crm login / whoami / logout` — session management against `crm serve`.

export function registerLoginCommands(program: Command): void {
  program
    .command('login')
    .description('Authenticate to a CRM server and save the session token')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--username <name>', 'Username (prompts if omitted)')
    .option(
      '--password <password>',
      'Password (prompts if omitted; prefer the prompt)',
    )
    .option(
      '--insecure',
      'Skip TLS certificate verification (self-signed certs)',
    )
    .action(
      async (opts: {
        server?: string
        username?: string
        password?: string
        insecure?: boolean
      }) => {
        if (!(process.stdin.isTTY || opts.password)) {
          die('login requires a TTY (or --password) to read the password')
        }
        const { host, port } = resolveServerAddr(opts.server)
        if (!host) {
          die(
            'No server configured. Use --server <host:port> or set CRM_SERVER.',
          )
        }
        // A saved username is a suggestion, never a silent decision: the
        // prompt shows it as the default and a bare Enter keeps it, but
        // the human always sees which account they are authenticating as
        // and can type a different one. Non-TTY (piped/automated) keeps
        // the machine behavior of reusing the saved user without reading
        // a stdin line that was meant for something else.
        const savedUser = loadSession()?.username
        let username: string | undefined = opts.username
        if (username === undefined && savedUser !== undefined) {
          username = process.stdin.isTTY
            ? (await promptLine(`Username (${savedUser}): `)) || savedUser
            : savedUser
        }
        if (username === undefined) {
          username = await promptLine('Username: ')
        }
        const password = opts.password ?? (await promptSecret('Password: '))
        const insecure = !!opts.insecure || gInsecure
        const client = await RpcClient.connect(port, host, {
          insecure,
        }).catch((e: Error) =>
          die(`cannot connect to ${host}:${port}: ${e.message}`),
        )
        try {
          const res = await client.call<{
            token: string
            user: { username: string; role: string }
            must_change?: boolean
          }>('auth.login', { username, password })
          saveSession({
            server: `${host}:${port}`,
            username: res.user.username,
            token: res.token,
            insecure,
          })
          console.log(
            `Logged in as ${res.user.username} (${res.user.role}) → ${host}:${port}`,
          )
          console.log('Session saved to ~/.crm/credentials (0600).')
          if (res.must_change === true) {
            if (process.stdin.isTTY) {
              console.log('This password needs to be changed now.')
              const fresh = await promptSecret('New password: ')
              try {
                await client.call('auth.change-password', {
                  current: password,
                  new: fresh,
                })
                console.log('Password changed.')
              } catch (e) {
                die(
                  `password must be changed — run crm password change (${(e as Error).message})`,
                )
              }
            } else {
              // The session is saved; finish the change out of band.
              die('password must be changed — run crm password change')
            }
          }
        } catch (e) {
          die(`login failed: ${(e as Error).message}`)
        } finally {
          client.close()
        }
      },
    )

  program
    .command('whoami')
    .description('Show the authenticated user on the server')
    .option('--server <host:port>', 'Server address')
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: { server?: string; insecure?: boolean }) => {
      const session = loadSession()
      const token = session?.token ?? process.env.CRM_TOKEN
      if (!token) {
        die(
          'Not logged in. Run `crm login` first (or set CRM_SERVER + CRM_TOKEN).',
        )
      }
      const { host, port } = resolveServerAddr(opts.server)
      if (!host) {
        die('No server configured.')
      }
      const client = await RpcClient.connect(port, host, {
        insecure:
          !!opts.insecure ||
          gInsecure ||
          session?.insecure === true ||
          process.env.CRM_INSECURE === '1',
      }).catch((e: Error) =>
        die(`cannot connect to ${host}:${port}: ${e.message}`),
      )
      try {
        const res = await client.call<{
          user: { username: string; role: string }
        }>('auth.token', { token })
        console.log(`${res.user.username} (${res.user.role}) → ${host}:${port}`)
      } catch (e) {
        die(`not authenticated: ${(e as Error).message}`)
      } finally {
        client.close()
      }
    })

  program
    .command('logout')
    .description(
      'Forget the saved server session (the token stays valid server-side)',
    )
    .action(() => {
      if (clearSession()) {
        console.log('Cleared ~/.crm/credentials')
      } else {
        console.log('No saved session.')
      }
    })
}
