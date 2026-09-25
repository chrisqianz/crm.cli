import type { Command } from 'commander'

import { formatOutput } from '../format'
import { die } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

export function registerTagCommands(program: Command) {
  program
    .command('tag')
    .description('Tag an entity or list tags')
    .argument('[args...]')
    .option('--type <type>')
    .action(async (args: string[], opts) => {
      if (args[0] === 'list') {
        const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
          'tag.list',
          { type: opts.type },
        )
        const { config, fmt } = renderCtx()
        if (fmt === 'json') {
          console.log(JSON.stringify(rows, null, 2))
        } else {
          console.log(formatOutput(rows, fmt, config))
        }
        return
      }
      if (args.length < 2) {
        die('Error: usage: tag <ref> <tags...>')
      }
      await dispatch('tag', { ref: args[0], tags: args.slice(1) })
    })

  program
    .command('untag')
    .description('Remove tags from an entity')
    .argument('<ref>')
    .argument('<tags...>')
    .action(async (rawRef: string, rawTags: string[]) => {
      await dispatch('untag', { ref: rawRef, tags: rawTags })
    })
}
