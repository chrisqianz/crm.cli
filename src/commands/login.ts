import type { Command } from 'commander'

import { die } from '../lib/helpers'
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
        const username =
          opts.username ??
          loadSession()?.username ??
          (await promptLine('Username: '))
        const password = opts.password ?? (await promptSecret('Password: '))
        const client = await RpcClient.connect(port, host, {
          insecure: !!opts.insecure,
        }).catch((e: Error) =>
          die(`cannot connect to ${host}:${port}: ${e.message}`),
        )
        try {
          const res = await client.call<{
            token: string
            user: { username: string; role: string }
          }>('auth.login', { username, password })
          saveSession({
            server: `${host}:${port}`,
            username: res.user.username,
            token: res.token,
          })
          console.log(
            `Logged in as ${res.user.username} (${res.user.role}) → ${host}:${port}`,
          )
          console.log('Session saved to ~/.crm/credentials (0600).')
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
      if (!session) {
        die('Not logged in. Run `crm login` first.')
      }
      const { host, port } = resolveServerAddr(opts.server ?? session.server)
      if (!host) {
        die('No server configured.')
      }
      const client = await RpcClient.connect(port, host, {
        insecure: !!opts.insecure,
      }).catch((e: Error) =>
        die(`cannot connect to ${host}:${port}: ${e.message}`),
      )
      try {
        const res = await client.call<{
          user: { username: string; role: string }
        }>('auth.token', { token: session.token })
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
