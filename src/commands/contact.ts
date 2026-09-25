import type { Command } from 'commander'

import { formatOutput } from '../format'
import { collect, showEntity } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

export function registerContactCommands(program: Command) {
  const cmd = program.command('contact').description('Manage contacts')

  cmd
    .command('add')
    .requiredOption('--name <name>', 'Contact name')
    .option('--email <email>', 'Email', collect, [])
    .option('--phone <phone>', 'Phone', collect, [])
    .option('--company <company>', 'Company', collect, [])
    .option('--tag <tag>', 'Tag', collect, [])
    .option('--linkedin <h>', 'LinkedIn')
    .option('--x <h>', 'X/Twitter')
    .option('--bluesky <h>', 'Bluesky')
    .option('--telegram <h>', 'Telegram')
    .option('--set <kv>', 'Custom field', collect, [])
    .action(async (opts) => {
      const { id } = await dispatch<{ id: string }>('contact.add', opts)
      console.log(id)
    })

  cmd
    .command('list')
    .option('--tag <tag>')
    .option('--company <company>')
    .option('--sort <field>')
    .option('--reverse', 'Reverse sort order')
    .option('--limit <n>')
    .option('--offset <n>')
    .option('--filter <expr>')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'contact.list',
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
        'contact.show',
        { ref },
      )
      const { fmt } = renderCtx()
      showEntity(detail, fmt)
    })

  cmd
    .command('edit')
    .argument('<ref>')
    .option('--name <name>')
    .option('--add-email <e>', '', collect, [])
    .option('--rm-email <e>', '', collect, [])
    .option('--add-phone <p>', '', collect, [])
    .option('--rm-phone <p>', '', collect, [])
    .option('--add-company <c>', '', collect, [])
    .option('--rm-company <c>', '', collect, [])
    .option('--add-tag <t>', '', collect, [])
    .option('--rm-tag <t>', '', collect, [])
    .option('--linkedin <h>')
    .option('--x <h>')
    .option('--bluesky <h>', 'Bluesky')
    .option('--telegram <h>', 'Telegram')
    .option('--set <kv>', '', collect, [])
    .option('--unset <key>', '', collect, [])
    .action(async (ref, opts) => {
      const { id } = await dispatch<{ id: string }>('contact.edit', {
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
      await dispatch('contact.rm', { ref, force: opts.force })
    })

  cmd
    .command('merge')
    .argument('<id1>')
    .argument('<id2>')
    .action(async (id1, id2) => {
      const { id } = await dispatch<{ id: string }>('contact.merge', {
        id1,
        id2,
      })
      console.log(id)
    })
}
