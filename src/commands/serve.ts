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
import { NEEDS_DB } from '../remote/dispatch'
import { startAdminServer } from '../server/admin'
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
    .option(
      '--admin-port <port>',
      'Also serve the web console on this HTTP port (0 = auto; omit to disable)',
    )
    .option(
      '--admin-host <host>',
      'Interface for the web console (default: same as the RPC host)',
    )
    .action(
      async (opts: {
        port?: string
        host?: string
        cert?: string
        key?: string
        adminPort?: string
        adminHost?: string
      }) => {
        const config = loadConfig({ configPath: gConfig, dbPath: gDb })
        // A server hosts one named database, and nothing names it for you
        // any more: an operator who forgot --db/CRM_DB gets the fixed
        // message instead of a database silently created under $HOME.
        if (!config.database.path) {
          die(NEEDS_DB)
        }
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
        let admin: Awaited<ReturnType<typeof startAdminServer>> | null = null
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
            // Client-reachable address, not the bind interface: nobody can
            // dial 0.0.0.0. D-A: an explicit public identity wins — the
            // bind-derived value is only the fallback for dev servers.
            const bindHost =
              host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
            const rpcHost = config.serve.public_host || bindHost
            const rpcPort = config.serve.public_port || addr.port
            console.log(
              `crm serve listening on ${host === '0.0.0.0' || host === '::' ? '0.0.0.0' : host}:${addr.port} (DB: ${config.database.path})`,
            )
            // Nothing discovers this server: a client has to be told the
            // address, and the host's own commands need the database named
            // (spec/client-repl.md A1/A2). Say both while we have a TTY.
            console.log(`clients: crm login ${rpcHost}:${rpcPort}`)
            console.log(
              `this host: [database] path = "${config.database.path}" in crm.toml, or pass --db`,
            )
            if (opts.adminPort !== undefined) {
              // Default certs are self-signed → clients need cert-skip.
              // Custom material is assumed trusted.
              const rpcInsecure = !(
                opts.cert ||
                opts.key ||
                config.serve.cert ||
                config.serve.key
              )
              admin = await startAdminServer({
                db,
                config,
                bootstrapCode,
                host: opts.adminHost ?? host,
                port: Number(opts.adminPort),
                rpcHost,
                rpcPort,
                rpcInsecure,
                installSource: config.serve.install_source,
              })
            }
          }
          const shutdown = () => {
            console.log('shutting down…')
            replica?.close()
            server.close(() => process.exit(0))
            if (admin) {
              admin.server.close()
            }
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
