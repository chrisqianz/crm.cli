import type { Command } from 'commander'

import { die } from '../lib/helpers'
import { suggestCommands } from '../lib/suggest'

// `crm suggest <words>` — fuzzy command discovery. The index comes from
// the live command tree, so this stays accurate as the CLI grows; the
// Chinese alias table (CJK_ALIASES in lib/suggest.ts) maps business
// vocabulary to command names.

export function registerSuggestCommand(program: Command): void {
  program
    .command('suggest')
    .description(
      'Find the command for a fuzzy description (e.g. suggest 删除 客户)',
    )
    .argument('[query...]', 'words or a phrase describing what you want')
    .action((query: string[]) => {
      if (query.length === 0) {
        die(
          'usage: crm suggest <words>\n  examples: suggest 删除 客户\n            suggest report chart\n            suggest import csv',
        )
      }
      const hits = suggestCommands(program, query.join(' '), 5)
      if (hits.length === 0) {
        console.log('No matching command.')
        console.log(
          '  Try different words, run `crm --help`, or set up shell completion: crm completion bash',
        )
        return
      }
      const w = Math.max(...hits.map((h) => `crm ${h.path}`.length))
      for (const h of hits) {
        console.log(`${`crm ${h.path}`.padEnd(w + 2)} — ${h.description}`)
      }
    })
}
