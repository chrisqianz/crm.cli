import type { Command } from 'commander'

import { formatOutput } from '../format'
import { collect, showEntity } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

export function registerDealCommands(program: Command) {
  const cmd = program.command('deal').description('Manage deals')

  cmd
    .command('add')
    .requiredOption('--title <title>', 'Deal title')
    .option('--value <n>', 'Deal value')
    .option('--stage <stage>', 'Pipeline stage')
    .option('--contact <ref>', 'Contact', collect, [])
    .option('--company <ref>', 'Company')
    .option('--expected-close <date>', 'Expected close date')
    .option('--probability <n>', 'Win probability 0-100')
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (opts) => {
      const { id } = await dispatch<{ id: string }>('deal.add', opts)
      console.log(id)
    })

  cmd
    .command('list')
    .option('--stage <stage>')
    .option('--min-value <n>')
    .option('--max-value <n>')
    .option('--contact <ref>')
    .option('--company <ref>')
    .option('--tag <tag>')
    .option('--filter <expr>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'deal.list',
        opts,
      )
      const { config, fmt } = renderCtx()
      console.log(formatOutput(rows, fmt, config))
    })

  cmd
    .command('show')
    .argument('<ref>')
    .action(async (ref) => {
      const { detail } = await dispatch<{ detail: Record<string, unknown> }>(
        'deal.show',
        { ref },
      )
      const { fmt } = renderCtx()
      showEntity(detail, fmt)
    })

  cmd
    .command('edit')
    .argument('<ref>')
    .option('--title <title>')
    .option('--value <n>')
    .option('--company <ref>', 'Change linked company')
    .option('--expected-close <date>', 'Expected close date (YYYY-MM-DD)')
    .option('--probability <n>', 'Win probability 0-100')
    .option('--add-contact <ref>', '', collect, [])
    .option('--rm-contact <ref>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .option(
      '--version <n>',
      'Optimistic locking: require the deal to still be at this version (see `crm deal show`); exits 3 on conflict',
    )
    .action(async (ref, opts) => {
      const { id } = await dispatch<{ id: string }>('deal.edit', {
        ref,
        ...opts,
      })
      console.log(id)
    })

  cmd
    .command('move')
    .argument('<ref>')
    .requiredOption('--stage <stage>', 'Target stage')
    .option('--note <text>', 'Note')
    .option(
      '--version <n>',
      'Optimistic locking: require the deal to still be at this version (see `crm deal show`); exits 3 on conflict',
    )
    .action(async (ref, opts) => {
      const { id } = await dispatch<{ id: string }>('deal.move', {
        ref,
        stage: opts.stage,
        note: opts.note,
        version: opts.version,
      })
      console.log(id)
    })

  cmd
    .command('rm')
    .argument('<ref>')
    .option('--force', 'Skip confirmation')
    .action(async (ref, opts) => {
      await dispatch('deal.rm', { ref, force: opts.force })
    })
}

export function registerPipelineCommand(program: Command) {
  program
    .command('pipeline')
    .description('Pipeline summary')
    .action(async () => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'pipeline',
        {},
      )
      const { config, fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(formatOutput(rows, fmt, config))
      }
    })
}
