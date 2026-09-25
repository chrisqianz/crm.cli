import type { Command } from 'commander'

import { dispatch, renderCtx } from '../remote/dispatch'

interface DupeResult {
  left: Record<string, unknown>
  reasons: string[]
  right: Record<string, unknown>
  score: number
}

export function registerDupesCommand(program: Command) {
  program
    .command('dupes')
    .description('Find likely duplicates')
    .option('--type <type>', 'Entity type (contact or company)')
    .option('--threshold <n>', 'Similarity threshold 0-1', '0.3')
    .option('--limit <n>', 'Max results')
    .action(async (opts) => {
      const { results } = (await dispatch('dupes', opts)) as {
        results: DupeResult[]
      }
      const { fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(
          JSON.stringify(
            results.map((r) => ({
              left: r.left,
              right: r.right,
              reasons: r.reasons,
            })),
            null,
            2,
          ),
        )
      } else {
        if (results.length === 0) {
          console.log('')
          return
        }
        const lines = results.map((r) => {
          const lName = r.left.name || r.left.title || r.left.id
          const rName = r.right.name || r.right.title || r.right.id
          return `${lName} <-> ${rName}: ${r.reasons.join(', ')}`
        })
        console.log(lines.join('\n'))
      }
    })
}
