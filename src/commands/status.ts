/**
 * `crm status` — server status (B5). Remote-only by design: it reports
 * the server's live facts (uptime, connections, counts, backup state).
 * In local mode there is no server to report, so it fails clean with
 * the mode-contract NOT_CONNECTED pointer instead of inventing anything.
 */

import type { Command } from 'commander'

import { die, gInsecure } from '../lib/helpers'
import { RpcClient } from '../lib/rpc'
import { loadSession, resolveServerAddr } from '../lib/session'
import { NOT_CONNECTED } from '../remote/dispatch'

interface StatusResult {
  audit_seq: number | null
  backend: string
  backup: { last_sync_at: string | null; in_sync: boolean | null }
  connections: number | null
  /** null when the server has no file to size — a postgres-backed server. */
  db_bytes: number | null
  now: string
  server_version: string
  tokens: number
  uptime_ms: number | null
  users: number
}

function fmtBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) {
    return `${d}d ${h}h`
  }
  if (h > 0) {
    return `${h}h ${m}m`
  }
  return `${m}m ${s % 60}s`
}

function backupLine(s: StatusResult): string {
  if (s.backup.in_sync === null) {
    return 'not configured'
  }
  const state = s.backup.in_sync ? 'in sync' : 'behind'
  const last = s.backup.last_sync_at ? ` (last ${s.backup.last_sync_at})` : ''
  return `${state}${last}`
}

export function registerStatusCommands(program: Command): void {
  program
    .command('status')
    .description('Server status: uptime, connections, counts, backup')
    .option('--server <host:port>', 'Server address (default: saved session)')
    .option('--insecure', 'Skip TLS certificate verification')
    .action(
      async (opts: { server?: string; insecure?: boolean }): Promise<void> => {
        const session = loadSession()
        const token = session?.token ?? process.env.CRM_TOKEN
        const { host, port } = resolveServerAddr(opts.server)
        // resolveServerAddr returns '' / 0 when nothing was configured;
        // empty env vars count as absent too.
        const noServer = host === ''
        const noToken = token === undefined || token === ''
        if (noServer || noToken) {
          // Local mode / no session: no server exists to report on. The
          // fixed mode-contract copy (spec/client-repl.md A1) is the
          // right pointer, not a status page of invented values.
          die(NOT_CONNECTED)
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
          await client.call('auth.token', { token })
          const s = await client.call<StatusResult>('server.status', {})
          console.log(`server     ${host}:${port}`)
          console.log(`version    ${s.server_version}`)
          console.log(`database   ${s.backend}`)
          if (s.uptime_ms !== null) {
            console.log(`uptime     ${fmtUptime(s.uptime_ms)}`)
          }
          if (s.connections !== null) {
            console.log(`connections ${s.connections}`)
          }
          console.log(`users      ${s.users}`)
          console.log(`tokens     ${s.tokens}`)
          console.log(
            `db size    ${s.db_bytes === null ? '— (no local file)' : fmtBytes(s.db_bytes)}`,
          )
          console.log(`audit seq  ${s.audit_seq ?? '—'}`)
          console.log(`backup     ${backupLine(s)}`)
          if (session?.username) {
            console.log(`session    ${session.username}`)
          }
        } catch (e) {
          die((e as Error).message)
        } finally {
          client.close()
        }
      },
    )
}
