import type { Command } from 'commander'

import { formatOutput } from '../format'
import { die, showEntity } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

/**
 * `crm task` — follow-up to-dos (P9). Light-weight and linkable to a
 * contact and/or deal so "what do I do about Acme today" is one command:
 *
 *   crm task add 'Call Acme re: renewal' --due 2026-07-01 \
 *       --contact 'Acme' --owner lin
 *   crm task list --due-today
 *   crm task list --overdue --mine
 *   crm task done 'Call Acme re: renewal'
 *   crm task rm 'Call Acme re: renewal'
 */
export function registerTaskCommands(program: Command): void {
  const cmd = program.command('task').description('Follow-up tasks')

  cmd
    .command('add')
    .description('Create a task')
    .argument('[title]', 'Task title (same as --title)')
    .option('--title <title>', 'Task title')
    .option('--due <date>', 'Due date (YYYY-MM-DD) or ISO timestamp')
    .option('--owner <owner>', 'Assigned owner (username)')
    .option('--contact <ref>', 'Link a contact')
    .option('--deal <ref>', 'Link a deal')
    .action(async (title, opts) => {
      const finalTitle = opts.title ?? title
      if (!finalTitle) {
        die("Error: required option '--title <title>' not specified")
      }
      const { id } = await dispatch<{ id: string }>('task.add', {
        ...opts,
        title: finalTitle,
      })
      console.log(id)
    })

  cmd
    .command('list')
    .description('List tasks (open by default)')
    .option('--status <status>', 'open or done (default: open)')
    .option('--due-today', 'Due today (open)')
    .option('--overdue', 'Past due (open)')
    .option('--owner <owner>', 'Filter by assigned owner (username)')
    .option('--mine', 'Only my tasks (remote mode)')
    .option('--contact <ref>', 'Only tasks linked to this contact')
    .option('--limit <n>')
    .option('--offset <n>')
    .action(async (opts) => {
      const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
        'task.list',
        opts,
      )
      const { config, fmt } = renderCtx()
      console.log(formatOutput(rows, fmt, config))
    })

  cmd
    .command('show')
    .description('Show one task (ref: id or title)')
    .argument('<ref>')
    .action(async (ref) => {
      const { detail } = await dispatch<{ detail: Record<string, unknown> }>(
        'task.show',
        { ref },
      )
      const { fmt } = renderCtx()
      showEntity(detail, fmt)
    })

  cmd
    .command('done')
    .description('Mark a task done (ref: id or title)')
    .argument('<ref>')
    .action(async (ref) => {
      const { id, status } = await dispatch<{
        id: string
        status: string
      }>('task.done', { ref })
      console.log(`${id} ${status}`)
    })

  cmd
    .command('rm')
    .description('Delete a task (ref: id or title)')
    .argument('<ref>')
    .option('--force', 'Skip confirmation')
    .action(async (ref, opts) => {
      const { id } = await dispatch<{ id: string }>('task.rm', {
        ref,
        force: opts.force,
      })
      console.log(id)
    })
}
