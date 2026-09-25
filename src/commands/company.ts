import type { Command } from 'commander'

import { formatOutput } from '../format'
import { collect, showEntity } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

export function registerCompanyCommands(program: Command) {
  const cmd = program.command('company').description('Manage companies')

  cmd
    .command('add')
    .requiredOption('--name <name>', 'Company name')
    .option('--website <url>', 'Website', collect, [])
    .option('--phone <phone>', 'Phone', collect, [])
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (opts) => {
      const { id } = await dispatch<{ id: string }>('company.add', opts)
      console.log(id)
    })

  cmd
    .command('list')
    .option('--tag <tag>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .option('--filter <expr>')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'company.list',
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
        'company.show',
        { ref },
      )
      const { fmt } = renderCtx()
      showEntity(detail, fmt)
    })

  cmd
    .command('edit')
    .argument('<ref>')
    .option('--name <name>')
    .option('--add-website <url>', '', collect, [])
    .option('--rm-website <url>', '', collect, [])
    .option('--add-phone <p>', '', collect, [])
    .option('--rm-phone <p>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .action(async (ref, opts) => {
      const { id } = await dispatch<{ id: string }>('company.edit', {
        ref,
        ...opts,
      })
      console.log(id)
    })

  cmd
    .command('rm')
    .argument('<ref>')
    .option('--force', 'Skip confirmation')
    .action(async (ref, opts) => {
      await dispatch('company.rm', { ref, force: opts.force })
    })

  cmd
    .command('merge')
    .argument('<id1>')
    .argument('<id2>')
    .action(async (id1, id2) => {
      const { id } = await dispatch<{ id: string }>('company.merge', {
        id1,
        id2,
      })
      console.log(id)
    })
}
