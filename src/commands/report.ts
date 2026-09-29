import type { Command } from 'commander'

import { formatOutput } from '../format'
import { type Bar, fmtCompact, renderChart } from '../lib/chart'
import { dispatch, renderCtx } from '../remote/dispatch'

type Row = Record<string, unknown>

const CHART_HELP =
  'Render a bar chart (terminal; pass a .svg path to write a file)'

function pipelineBars(rows: Row[]): Bar[] {
  return rows
    .filter((r) => r.stage !== 'Total')
    .map((r) => ({
      label: String(r.stage),
      value: Number(r.value) || 0,
      sub: `${r.count} deals`,
    }))
}

function conversionBars(rows: Row[]): Bar[] {
  return rows.map((r) => ({
    label: String(r.stage),
    value: Number(String(r.rate).replace('%', '')) || 0,
    sub: `${r.rate} (${r.entered} in → ${r.advanced} out)`,
  }))
}

function velocityBars(rows: Row[]): Bar[] {
  return rows.map((r) => ({
    label: String(r.stage),
    value: Number(r.avg_ms) || 0,
    sub: `${r.avg_display} over ${r.deals} deals`,
  }))
}

function forecastBars(rows: Row[]): Bar[] {
  const byMonth = new Map<string, { v: number; n: number }>()
  for (const r of rows) {
    const month = String(r.expected_close || '').slice(0, 7) || 'no date'
    const cur = byMonth.get(month) ?? { v: 0, n: 0 }
    cur.v += Number(r.weighted) || 0
    cur.n += 1
    byMonth.set(month, cur)
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([m, s]) => ({
      label: m,
      value: Math.round(s.v),
      sub: `${s.n} deal${s.n === 1 ? '' : 's'}`,
    }))
}

function dealValueBars(rows: Row[]): Bar[] {
  return rows
    .map((r) => ({
      label: String(r.title),
      value: Number(r.value) || 0,
      sub: String(r.expected_close || 'closed'),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
}

function activityBars(rows: Row[]): Bar[] {
  return rows.map((r) => ({
    label: String(r.type ?? r.contact ?? 'unknown'),
    value: Number(r.count) || 0,
  }))
}

export function registerReportCommands(program: Command) {
  const cmd = program.command('report').description('Reports')

  cmd
    .command('pipeline')
    .description('Pipeline summary')
    .option('--chart [file]', CHART_HELP)
    .action(async (opts: { chart?: string }) => {
      const { rows } = await dispatch<{ rows: Row[] }>('report.pipeline', {})
      if (opts.chart !== undefined) {
        renderChart('Pipeline', pipelineBars(rows), opts.chart, {
          formatValue: fmtCompact,
        })
        return
      }
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('activity')
    .description('Activity counts by type or contact')
    .option('--by <field>', 'Group by (type or contact)')
    .option('--period <period>', 'Time period (e.g. 7d, 30d)')
    .option('--chart [file]', CHART_HELP)
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Row[] }>('report.activity', opts)
      if (opts.chart !== undefined) {
        renderChart('Activity by type', activityBars(rows), opts.chart, {
          formatValue: (v: number) => String(Math.round(v)),
        })
        return
      }
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('stale')
    .description('Entities with no recent activity')
    .option('--days <n>', 'Days threshold', '30')
    .option('--type <type>', 'Entity type (contact or deal)')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Row[] }>('report.stale', opts)
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
    .description('Stage conversion rates')
    .option('--since <date>', 'Only count transitions after date (YYYY-MM-DD)')
    .option('--chart [file]', CHART_HELP)
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Row[] }>(
        'report.conversion',
        opts,
      )
      if (opts.chart !== undefined) {
        renderChart('Stage conversion', conversionBars(rows), opts.chart, {
          formatValue: (v: number) => `${Math.round(v)}%`,
        })
        return
      }
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('velocity')
    .description('Average time per pipeline stage')
    .option('--won-only', 'Only count deals that were won')
    .option('--chart [file]', CHART_HELP)
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Row[] }>('report.velocity', opts)
      if (opts.chart !== undefined) {
        renderChart('Average time per stage', velocityBars(rows), opts.chart, {
          formatValue: (v: number) => `${Math.round(v)}ms`,
        })
        return
      }
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
    .description('Weighted forecast by expected close')
    .option(
      '--period <period>',
      'Filter by expected close month (YYYY-MM) or days (30d)',
    )
    .option('--chart [file]', CHART_HELP)
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Row[] }>('report.forecast', opts)
      if (opts.chart !== undefined) {
        renderChart(
          'Weighted forecast by month',
          forecastBars(rows),
          opts.chart,
          {
            formatValue: fmtCompact,
          },
        )
        return
      }
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })

  cmd
    .command('won')
    .description('Won deals summary')
    .option('--period <period>', 'Time period (e.g. 30d)')
    .option('--chart [file]', CHART_HELP)
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Row[] }>('report.won', opts)
      if (opts.chart === undefined) {
        const { config, fmt } = renderCtx()
        if (fmt === 'json') {
          console.log(JSON.stringify(rows, null, 2))
        } else {
          console.log(formatOutput(rows, fmt, config))
        }
      } else {
        renderChart('Won deals by value', dealValueBars(rows), opts.chart, {
          formatValue: fmtCompact,
        })
      }
    })

  cmd
    .command('lost')
    .description('Lost deals summary')
    .option('--period <period>', 'Time period')
    .option('--chart [file]', CHART_HELP)
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Row[] }>('report.lost', opts)
      if (opts.chart === undefined) {
        const { config, fmt } = renderCtx()
        if (fmt === 'json') {
          console.log(JSON.stringify(rows, null, 2))
        } else {
          console.log(formatOutput(rows, fmt, config))
        }
      } else {
        renderChart('Lost deals by value', dealValueBars(rows), opts.chart, {
          formatValue: fmtCompact,
        })
      }
    })
}
