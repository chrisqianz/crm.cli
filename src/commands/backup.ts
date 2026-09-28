/**
 * `crm backup ...` — P5 litestream backup/restore commands.
 *
 * Server-host operations: `init` / `restore` / `check` only run in local
 * mode (against the process-local DB). `status` / `sync` also work through
 * RPC (admin) so an operator or agent can inspect/force replication
 * remotely — the data lives on the server host either way.
 */
import type { Command } from 'commander'

import { dispatch, localOnly } from '../remote/dispatch'
import { backupCheck, backupInit, backupRestore } from '../service/backup'

export function registerBackupCommands(program: Command): void {
  const backup = program
    .command('backup')
    .description('litestream WAL backup & restore (server host)')

  backup
    .command('init')
    .description('register the DB and take the first snapshot')
    .requiredOption(
      '--destination <dest>',
      'replica destination (local path or s3://bucket/prefix)',
    )
    .option('--download', 'download the pinned litestream release if missing')
    .action(async (opts) => {
      if (opts.download) {
        const { downloadLitestream } = await import('../lib/litestream')
        process.stdout.write('downloading litestream…\n')
        await downloadLitestream()
      }
      const out = await localOnly(async (db, config) =>
        backupInit(db, config, { destination: opts.destination }),
      )
      process.stdout.write(
        `backup initialized — replica at ${String(out.replica)}\nconfig: ${String(out.config)}\n`,
      )
    })

  backup
    .command('sync')
    .description('run one replication pass')
    .action(async () => {
      await dispatch('backup.sync', {})
      process.stdout.write('backup sync complete\n')
    })

  backup
    .command('status')
    .description('show replication status')
    .option('--json', 'output raw JSON')
    .action(async (opts) => {
      const out = await dispatch<{
        databases: Record<string, unknown>[]
      }>('backup.status', {})
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
        return
      }
      for (const d of out.databases) {
        process.stdout.write(
          `${String(d.database)}  status=${String(d.status)}  ` +
            `txid=${String(d.local_txid ?? '-')}  wal=${String(d.wal_size ?? '-')}\n`,
        )
      }
    })

  backup
    .command('restore')
    .description('rebuild a fresh DB file from the replica')
    .requiredOption('--to <path>', 'output path (must not exist)')
    .action(async (opts) => {
      const out = await localOnly(async (db, config) =>
        backupRestore(db, config, { to: opts.to }),
      )
      process.stdout.write(`restored → ${String(out.to)}\n`)
    })

  backup
    .command('check')
    .description('restore to a temp file, verify the audit chain, compare rows')
    .action(async () => {
      const out = await localOnly(async (db, config) =>
        backupCheck(db, config, {}),
      )
      process.stdout.write(out.ok ? `OK: ${out.note}\n` : `WARN: ${out.note}\n`)
      if (!out.ok) {
        process.exitCode = 1
      }
    })
}
