import type { Command } from 'commander'

import { formatOutput } from '../format'
import { collect } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

export function registerLogCommand(program: Command) {
  program
    .command('log')
    .description('Log an activity')
    .argument('<type>', 'Activity type (note, call, meeting, email)')
    .argument('<body>', 'Activity body')
    .option('--contact <ref>', 'Link to contact (repeatable)', collect, [])
    .option('--company <ref>', 'Link to company (auto-creates if needed)')
    .option('--deal <ref>', 'Link to deal')
    .option('--at <date>', 'Custom timestamp')
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (rawType, rawBody, opts) => {
      await dispatch('activity.log', {
        type: rawType,
        body: rawBody,
        ...opts,
      })
    })
}

export function registerActivityCommands(program: Command) {
  const cmd = program.command('activity').description('Activity management')
  cmd
    .command('list')
    .option('--contact <ref>')
    .option('--company <ref>')
    .option('--deal <id>')
    .option('--type <type>')
    .option('--since <date>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'activity.list',
        opts,
      )
      const { config, fmt } = renderCtx()
      console.log(formatOutput(rows, fmt, config))
    })
}
