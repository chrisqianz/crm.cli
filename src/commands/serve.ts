import type { Command } from 'commander'

import { loadConfig, projectAuthConfigWarning } from '../config'
import { openDB } from '../db'
import * as schema from '../drizzle-schema'
import { die, gConfig, gDb } from '../lib/helpers'
import { ldapWarnings, validateLdapConfig } from '../lib/ldap'
import {
  configPathFor,
  parseDestination,
  renderConfig,
  replicaUrl,
  resolveLitestream,
  startReplicateDaemon,
} from '../lib/litestream'
import { generateBootstrapCode } from '../lib/secrets'
import { startServer } from '../server/serve'

// `crm serve` — the enterprise server (spec/enterprise.md, P1).
// Prints `BOOTSTRAP-CODE=<code>` when the users table is empty (one-time
// owner creation), then `READY <port>` once the TLS listener is up.

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Run the CRM server (enterprise mode; NDJSON RPC over TLS)')
    .option('--port <port>', 'Port to listen on (0 = auto)')
    .option('--host <host>', 'Host/interface to bind')
    .option('--cert <path>', 'TLS certificate (PEM)')
    .option('--key <path>', 'TLS private key (PEM)')
    .action(
      async (opts: {
        port?: string
        host?: string
        cert?: string
        key?: string
      }) => {
        const config = loadConfig({ configPath: gConfig, dbPath: gDb })
        // A project-discovered config that tried to define login
        // authority was stripped (loadConfig warns). Here that is fatal:
        // an operator who wrote [ldap] into crm.toml means to authenticate
        // against that directory, and silently serving a different auth
        // model is the failure mode this whole path exists to close.
        if (config.config_meta.dropped_auth_authority) {
          die(
            `Error: refusing to start — ${projectAuthConfigWarning(config.config_meta.path)}`,
          )
        }
        // P6: an enabled [ldap] section must be fully valid before we
        // serve — a broken directory config is a boot failure, not a
        // runtime surprise.
        const ldapErr = validateLdapConfig(config)
        if (ldapErr) {
          die(`Error: ${ldapErr}`)
        }
        for (const warning of ldapWarnings(config)) {
          console.error(`Warning: ${warning}`)
        }
        const db = await openDB(config.database.path)
        const users = await db
          .select({ id: schema.users.id })
          .from(schema.users)
        const bootstrapCode =
          users.length === 0 ? generateBootstrapCode() : null
        if (bootstrapCode) {
          console.log(`BOOTSTRAP-CODE=${bootstrapCode}`)
        }
        const port =
          opts.port === undefined ? config.serve.port : Number(opts.port)
        const host = opts.host ?? config.serve.host
        // P5: continuous litestream replication when a backup destination
        // is configured. The daemon is a child of this process — it dies
        // with the server and is written from the same config.
        let replica: { close: () => void } | null = null
        if (config.backup.destination) {
          try {
            const dest = parseDestination(config.backup.destination)
            const configPath = configPathFor(config.database.path)
            const { writeFileSync, mkdirSync } = await import('node:fs')
            const bin = resolveLitestream()
            writeFileSync(configPath, renderConfig(config.database.path, dest))
            if (dest.kind === 'file' && dest.path) {
              mkdirSync(dest.path, { recursive: true })
            }
            replica = startReplicateDaemon(bin, configPath)
            console.log(`backup replication started → ${replicaUrl(dest)}`)
          } catch (e) {
            console.error(
              `backup: continuous replication disabled (${(e as Error).message})`,
            )
          }
        }
        try {
          const server = await startServer({
            db,
            config,
            host,
            port,
            certOverride: opts.cert,
            keyOverride: opts.key,
            bootstrapCode,
          })
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            console.log(
              `crm serve listening on ${host === '0.0.0.0' || host === '::' ? '0.0.0.0' : host}:${addr.port} (DB: ${config.database.path})`,
            )
          }
          const shutdown = () => {
            console.log('shutting down…')
            replica?.close()
            server.close(() => process.exit(0))
            setTimeout(() => process.exit(0), 3000).unref()
          }
          process.on('SIGINT', shutdown)
          process.on('SIGTERM', shutdown)
        } catch (e) {
          die(`serve error: ${(e as Error).message}`)
        }
      },
    )
}
