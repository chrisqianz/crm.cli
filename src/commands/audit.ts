import type { Command } from 'commander'

import { formatOutput } from '../format'
import { die } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

/**
 * P4: the audit command surface — list (filterable), verify (walk the
 * hash chain), export (full chain). Works in local and remote mode.
 */
export function registerAuditCommands(program: Command) {
  const audit = program
    .command('audit')
    .description('Audit log: list, verify the hash chain, export')

  audit
    .command('list')
    .description('Show recent audit rows (newest first)')
    .option('--limit <n>', 'Max rows (default 50)')
    .option('--actor <name>', 'Filter by actor name')
    .option('--action <action>', 'Filter by action (e.g. contact.add)')
    .option('--entity <id>', 'Filter by entity id')
    .option('--since <iso>', 'Only rows after this timestamp')
    .action(
      async (opts: {
        actor?: string
        action?: string
        entity?: string
        limit?: string
        since?: string
      }) => {
        const { rows } = await dispatch<{
          rows: Record<string, unknown>[]
        }>('audit.list', {
          limit: opts.limit,
          actor: opts.actor,
          action: opts.action,
          entity: opts.entity,
          since: opts.since,
        })
        const { config, fmt } = renderCtx()
        if (fmt === 'json') {
          console.log(JSON.stringify(rows, null, 2))
        } else {
          console.log(formatOutput(rows, fmt, config))
        }
      },
    )

  audit
    .command('verify')
    .description('Walk the hash chain; exits 1 on tamper')
    .action(async () => {
      const r = await dispatch<{
        ok: boolean
        broken_seq: number | null
        chained: number
        genesis_seq: number | null
        legacy: number
        reason: string | null
      }>('audit.verify', {})
      if (!r.ok) {
        const where = r.broken_seq === null ? '' : ` at seq ${r.broken_seq}`
        console.error(
          `Error: audit chain tampered${where}: ${r.reason ?? 'unknown'}`,
        )
        die('audit chain verification failed', 1)
      }
      const legacyNote =
        r.legacy > 0 ? `; ${r.legacy} legacy row(s) before the chain` : ''
      const genesis =
        r.genesis_seq === null ? '' : `; genesis seq ${r.genesis_seq}`
      console.log(
        `OK: audit chain intact — ${r.chained} row(s) verified${genesis}${legacyNote}`,
      )
    })

  audit
    .command('export')
    .description('Export the full audit chain')
    .option('--format <fmt>', 'Output format: table, json, csv, tsv')
    .action(async (opts: { format?: string }) => {
      const { rows } = await dispatch<{
        rows: Record<string, unknown>[]
      }>('audit.export', {})
      const { config, fmt } = renderCtx()
      const outFmt = opts.format ?? fmt
      if (
        outFmt !== 'table' &&
        outFmt !== 'json' &&
        outFmt !== 'csv' &&
        outFmt !== 'tsv'
      ) {
        die(`Error: unknown format "${outFmt}"`)
      }
      if (outFmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, outFmt, config))
      }
    })
}
