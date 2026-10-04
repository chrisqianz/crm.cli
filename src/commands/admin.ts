import type { Command } from 'commander'

import { die, gInsecure } from '../lib/helpers'
import { promptLine, promptSecret } from '../lib/prompt'
import { RpcClient } from '../lib/rpc'
import { loadSession, resolveServerAddr, saveSession } from '../lib/session'

// `crm admin …` — thin-client administration (spec/enterprise.md P1).
// Every call goes over the wire: the CLI never reads the server DB locally.

interface AdminOpts {
  insecure?: boolean
  server?: string
}

function resolveAddrOrDie(opts: AdminOpts): { host: string; port: number } {
  const { host, port } = resolveServerAddr(opts.server)
  if (!host) {
    die('No server configured. Use --server <host:port> or run `crm login`.')
  }
  return { host, port }
}

/** Connect authenticated (saved session, or CRM_TOKEN env for agent mode) and run `fn`. */
async function withSession(
  opts: AdminOpts,
  fn: (client: RpcClient) => Promise<void>,
): Promise<void> {
  const session = loadSession()
  const token = session?.token ?? process.env.CRM_TOKEN
  if (!token) {
    die('Not logged in. Run `crm login` first (or set CRM_SERVER + CRM_TOKEN).')
  }
  const { host, port } = resolveAddrOrDie(opts)
  const client = await RpcClient.connect(port, host, {
    insecure:
      !!opts.insecure ||
      gInsecure ||
      session?.insecure === true ||
      process.env.CRM_INSECURE === '1',
  }).catch((e: Error) => die(`cannot connect to ${host}:${port}: ${e.message}`))
  try {
    await client
      .call('auth.token', { token })
      .catch((e: Error) =>
        die(`not authenticated: ${e.message} (run \`crm login\`)`),
      )
    try {
      await fn(client)
    } catch (e) {
      const err = e as Error & { code?: string }
      die(err.code ? `${err.code}: ${err.message}` : err.message)
    }
  } finally {
    client.close()
  }
}

export function registerAdminCommands(program: Command): void {
  const admin = program
    .command('admin')
    .description('Server administration (enterprise mode)')

  admin
    .command('bootstrap')
    .description('Create the owner account (only while users is empty)')
    .requiredOption('--code <code>', 'BOOTSTRAP-CODE printed by `crm serve`')
    .requiredOption('--username <name>', 'Owner username')
    .option('--password <password>', 'Owner password (prompts if omitted)')
    .option('--display-name <name>', 'Display name')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(
      async (
        opts: AdminOpts & {
          code: string
          username: string
          password?: string
          displayName?: string
        },
      ) => {
        const password =
          opts.password ??
          (process.stdin.isTTY
            ? await promptSecret('Password: ')
            : die('bootstrap requires --password (non-interactive)'))
        const { host, port } = resolveAddrOrDie(opts)
        const client = await RpcClient.connect(port, host, {
          insecure: !!opts.insecure || gInsecure,
        }).catch((e: Error) =>
          die(`cannot connect to ${host}:${port}: ${e.message}`),
        )
        try {
          const res = await client.call<{
            token: string
            user: { username: string; role: string }
          }>('auth.bootstrap', {
            code: opts.code,
            username: opts.username,
            password,
            display_name: opts.displayName,
          })
          console.log(
            `Owner "${res.user.username}" created (${res.user.role}).`,
          )
          console.log(`Session token (shown once): ${res.token}`)
          const hadSession = loadSession() !== null
          saveSession({
            server: `${host}:${port}`,
            username: res.user.username,
            token: res.token,
          })
          if (hadSession) {
            console.log('Session updated to the new owner identity.')
          } else {
            console.log('Session saved to ~/.crm/credentials (0600).')
          }
        } catch (e) {
          die(`bootstrap failed: ${(e as Error).message}`)
        } finally {
          client.close()
        }
      },
    )

  const user = admin.command('user').description('Manage user accounts')

  user
    .command('create')
    .description('Provision a user; prints a one-time initial password')
    .requiredOption('--username <name>', 'Username')
    .option('--display-name <name>', 'Display name')
    .option('--email <email>', 'Email address')
    .option('--role <role>', 'Role: admin | writer | reader (default reader)')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(
      async (
        opts: AdminOpts & {
          username: string
          displayName?: string
          email?: string
          role?: string
        },
      ) => {
        await withSession(opts, async (client) => {
          const res = await client.call<{
            user: { username: string; role: string }
            initial_password: string
          }>('admin.user.create', {
            username: opts.username,
            display_name: opts.displayName,
            email: opts.email,
            role: opts.role,
          })
          console.log(`Created ${res.user.username} (${res.user.role})`)
          console.log(`Initial password (one-time): ${res.initial_password}`)
        })
      },
    )

  user
    .command('list')
    .description('List all user accounts')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts) => {
      await withSession(opts, async (client) => {
        const res = await client.call<{
          users: Array<{
            username: string
            role: string
            display_name: string | null
            disabled: boolean
            locked: boolean
          }>
        }>('admin.user.list', {})
        for (const u of res.users) {
          const flags = [u.disabled && 'disabled', u.locked && 'locked']
            .filter(Boolean)
            .join(', ')
          console.log(
            `${u.username.padEnd(24)} ${u.role.padEnd(8)} ${u.display_name ?? ''} ${flags}`.trimEnd(),
          )
        }
      })
    })

  user
    .command('set-role')
    .description('Change a user role')
    .requiredOption('--username <name>', 'Username')
    .requiredOption('--role <role>', 'Role: admin | writer | reader')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts & { username: string; role: string }) => {
      await withSession(opts, async (client) => {
        const res = await client.call<{
          user: { username: string; role: string }
        }>('admin.user.set-role', { username: opts.username, role: opts.role })
        console.log(`${res.user.username} → ${res.user.role}`)
      })
    })

  user
    .command('disable')
    .description('Disable a user (login refused until enabled)')
    .requiredOption('--username <name>', 'Username')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts & { username: string }) => {
      await withSession(opts, async (client) => {
        await client.call('admin.user.disable', { username: opts.username })
        console.log(`Disabled ${opts.username}`)
      })
    })

  user
    .command('enable')
    .description('Re-enable a disabled user')
    .requiredOption('--username <name>', 'Username')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts & { username: string }) => {
      await withSession(opts, async (client) => {
        await client.call('admin.user.enable', { username: opts.username })
        console.log(`Enabled ${opts.username}`)
      })
    })

  user
    .command('reset-password')
    .description(
      'Reset a user password; prints a one-time temporary password (user is forced to change it at next login)',
    )
    .requiredOption('--username <name>', 'Username')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts & { username: string }) => {
      await withSession(opts, async (client) => {
        const res = await client.call<{ temporary_password: string }>(
          'admin.user.reset-password',
          { username: opts.username },
        )
        console.log(
          `Password reset for ${opts.username} (one-time temporary): ${res.temporary_password}`,
        )
        console.log('The user must change it at next login.')
      })
    })

  user
    .command('delete')
    .description(
      'Delete a user (tokens cascade; owned contacts/deals/tasks become unowned)',
    )
    .requiredOption('--username <name>', 'Username to delete')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts & { username: string }) => {
      // Deletion is typed, not flagged: re-typing the username is the
      // confirmation. promptLine reads one line — TTY or pipe alike.
      const typed = await promptLine('Type the username to confirm: ')
      if (typed !== opts.username) {
        die('Aborted.')
      }
      await withSession(opts, async (client) => {
        const res = await client.call<{ username: string }>(
          'admin.user.delete',
          { username: opts.username },
        )
        console.log(`Deleted ${res.username}`)
      })
    })

  const token = admin.command('token').description('Manage service tokens')

  token
    .command('create')
    .description('Create a service token (agent/service accounts)')
    .requiredOption('--name <name>', 'Token name')
    .option('--username <name>', 'User to bind (default: current user)')
    .option('--expires <seconds>', 'Lifetime in seconds (default: no expiry)')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(
      async (
        opts: AdminOpts & { name: string; username?: string; expires?: string },
      ) => {
        await withSession(opts, async (client) => {
          const res = await client.call<{ token: string; username: string }>(
            'admin.token.create',
            {
              name: opts.name,
              username: opts.username,
              expires_in_seconds: opts.expires ? Number(opts.expires) : 0,
            },
          )
          console.log(`Token for ${res.username}: ${res.token}`)
          console.log('Shown once — store it in the agent/service environment.')
        })
      },
    )

  token
    .command('list')
    .description('List service tokens')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts) => {
      await withSession(opts, async (client) => {
        const res = await client.call<{
          tokens: Array<{
            id: string
            name: string
            username: string
            expires_at: string | null
            last_used_at: string | null
          }>
        }>('admin.token.list', {})
        for (const t of res.tokens) {
          console.log(
            `${t.id.padEnd(26)} ${t.name.padEnd(20)} ${t.username.padEnd(16)} ${t.expires_at ?? 'no expiry'} ${t.last_used_at ? `last used ${t.last_used_at}` : 'never used'}`,
          )
        }
      })
    })

  token
    .command('revoke')
    .description('Revoke a service token')
    .requiredOption('--id <id>', 'Token id from `admin token list`')
    .option(
      '--server <host:port>',
      'Server address (default: CRM_SERVER or saved)',
    )
    .option('--insecure', 'Skip TLS certificate verification')
    .action(async (opts: AdminOpts & { id: string }) => {
      await withSession(opts, async (client) => {
        await client.call('admin.token.revoke', { id: opts.id })
        console.log(`Revoked ${opts.id}`)
      })
    })
}
