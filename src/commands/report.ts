import type { Command } from 'commander'

import { formatOutput } from '../format'
import { dispatch, renderCtx } from '../remote/dispatch'

export function registerReportCommands(program: Command) {
  const cmd = program.command('report').description('Reports')

  cmd.command('pipeline').action(async () => {
    const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
      'report.pipeline',
      {},
    )
    const { config, fmt } = renderCtx()
    if (fmt === 'json') {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      console.log(formatOutput(rows, fmt, config))
    }
  })

  cmd
    .command('activity')
    .option('--by <field>', 'Group by (type or contact)')
    .option('--period <period>', 'Time period (e.g. 7d, 30d)')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'report.activity',
        opts,
      )
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('stale')
    .option('--days <n>', 'Days threshold', '30')
    .option('--type <type>', 'Entity type (contact or deal)')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'report.stale',
        opts,
      )
      const { fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        if (rows.length === 0) {
          console.log('No stale entities found.')
          return
        }
        const lines = rows.map(
          (r) =>
            `[${r.type}] ${r.name || r.title} (${r.id}) — last: ${r.last_activity || 'never'}`,
        )
        console.log(lines.join('\n'))
      }
    })

  cmd
    .command('conversion')
    .option('--since <date>', 'Only count transitions after date (YYYY-MM-DD)')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'report.conversion',
        opts,
      )
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('velocity')
    .option('--won-only', 'Only count deals that were won')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'report.velocity',
        opts,
      )
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(
          formatOutput(
            rows.map((d) => ({
              stage: d.stage,
              avg_time: d.avg_display,
              deals: d.deals,
            })),
            fmt,
            config,
          ),
        )
      }
    })

  cmd
    .command('forecast')
    .option(
      '--period <period>',
      'Filter by expected close month (YYYY-MM) or days (30d)',
    )
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'report.forecast',
        opts,
      )
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('won')
    .option('--period <period>', 'Time period (e.g. 30d)')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'report.won',
        opts,
      )
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('lost')
    .option('--period <period>', 'Time period')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'report.lost',
        opts,
      )
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })
}
