/**
 * `crm password change` — self-service password change against the server.
 *
 * Remote-only by design: passwords are a server-side concept (the `users`
 * table is the server's). Local mode has no session identity to change
 * the password of, so it fails clean with a pointer at the right surface.
 */

import type { Command } from 'commander'

import { die, gInsecure } from '../lib/helpers'
import { promptSecret } from '../lib/prompt'
import { RpcClient } from '../lib/rpc'
import { loadSession, resolveServerAddr } from '../lib/session'

export function registerPasswordCommands(program: Command): void {
  const password = program
    .command('password')
    .description('Manage your own password (server mode)')

  password
    .command('change')
    .description('Change your password (prompts for the current one)')
    .option('--server <host:port>', 'Server address')
    .option('--insecure', 'Skip TLS certificate verification')
    .action(
      async (opts: { server?: string; insecure?: boolean }): Promise<void> => {
        const session = loadSession()
        const token = session?.token ?? process.env.CRM_TOKEN
        if (!token) {
          die(
            'Not logged in. Run `crm login` first (or set CRM_SERVER + CRM_TOKEN).',
          )
        }
        const { host, port } = resolveServerAddr(opts.server)
        if (!host) {
          die(
            'No server configured. Password management is a server feature — log in to a server first, or use --local for data commands.',
          )
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
          // The first frame of a connection must be an auth method; the
          // session token authenticates the frame, the change rides on top.
          await client.call('auth.token', { token })
          const current = await promptSecret('Current password: ')
          const fresh = await promptSecret('New password: ')
          const res = await client.call<{ username: string }>(
            'auth.change-password',
            { current, new: fresh },
          )
          console.log(`Password changed for ${res.username}.`)
        } catch (e) {
          die((e as Error).message)
        } finally {
          client.close()
        }
      },
    )
}
