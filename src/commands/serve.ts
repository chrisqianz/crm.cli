import type { Command } from 'commander'

import { loadConfig } from '../config'
import { openDB } from '../db'
import * as schema from '../drizzle-schema'
import { die, gConfig, gDb } from '../lib/helpers'
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
