import type { Command } from 'commander'

import { dispatch, renderCtx } from '../remote/dispatch'

export function registerSearchCommands(program: Command) {
  program
    .command('search')
    .description('Full-text search')
    .argument('<query>')
    .option('--type <type>')
    .action(async (rawQuery, opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'search.search',
        { query: rawQuery, type: opts.type },
      )
      const { fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        if (rows.length === 0) {
          console.log('')
          return
        }
        const lines = rows.map((r) => {
          if (r.type === 'contact') {
            return `[contact] ${r.name} (${r.id})`
          }
          if (r.type === 'company') {
            return `[company] ${r.name} (${r.id})`
          }
          if (r.type === 'deal') {
            return `[deal] ${r.title} (${r.id})`
          }
          if (r.entity_type === 'activity') {
            return `[activity] ${r.body} (${r.id})`
          }
          return `[${r.type}] ${r.id}`
        })
        console.log(lines.join('\n'))
      }
    })

  program
    .command('find')
    .description('Semantic search')
    .argument('<query>')
    .option('--type <type>')
    .option('--limit <n>')
    .option('--threshold <n>', 'Minimum similarity score 0.0-1.0')
    .action(async (rawQuery, opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'search.find',
        {
          query: rawQuery,
          type: opts.type,
          limit: opts.limit,
          threshold: opts.threshold,
        },
      )
      const { fmt } = renderCtx()
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        if (rows.length === 0) {
          console.log('')
          return
        }
        const lines = rows.map(
          (r) => `[${r.type}] ${r.name || r.title} (${r.id})`,
        )
        console.log(lines.join('\n'))
      }
    })

  const idx = program.command('index').description('Search index management')
  idx.command('status').action(async () => {
    const { lines } = await dispatch<{ lines: string[] }>('index.status', {})
    for (const line of lines) {
      console.log(line)
    }
  })

  idx.command('rebuild').action(async () => {
    await dispatch('index.rebuild', {})
    console.log('Index rebuilt')
  })
}
