import { readFileSync } from 'node:fs'

import type { Command } from 'commander'

import { collect, die } from '../lib/helpers'
import { dispatch } from '../remote/dispatch'

// `crm email send` — outbound email through the server's SMTP relay.
// The recipient defaults to the contact's first address; the send is
// auto-logged as an `email` activity on the contact (and the deal, if
// given) so the record stays the source of truth.

export function registerEmailCommands(program: Command): void {
  const cmd = program
    .command('email')
    .description('Send email through the configured SMTP relay')

  cmd
    .command('send')
    .description('Send an email to a contact and log it as an activity')
    .argument('<contact>', 'Contact ref (id, name, email, phone, social)')
    .option('--subject <subject>', 'Subject line')
    .option('--body <text>', 'Message body (or --body-file)')
    .option(
      '--body-file <path>',
      'Read the message body from a file (- = stdin)',
    )
    .option(
      '--to <addr>',
      'Override the recipient (contact address by default)',
    )
    .option('--cc <addr>', 'Carbon copy (repeatable)', collect, [])
    .option('--deal <ref>', 'Link the activity to a deal')
    .action(async (contact: string, opts: Record<string, string>) => {
      let body = opts.body ?? ''
      if (opts.bodyFile) {
        // fd 0 = stdin
        body = readFileSync(opts.bodyFile === '-' ? 0 : opts.bodyFile, 'utf-8')
      }
      if (!body.trim()) {
        die(
          "Error: required option '--body <text>' not specified (or --body-file)",
        )
      }
      try {
        const res = await dispatch<{ sent_to: string; subject: string }>(
          'email.send',
          {
            contact,
            to: opts.to,
            subject: opts.subject ?? '',
            body,
            cc: opts.cc ?? [],
            deal: opts.deal,
          },
        )
        console.log(`Sent "${res.subject}" → ${res.sent_to}`)
        console.log('Activity logged on the contact.')
      } catch (e) {
        die((e as Error).message)
      }
    })
}
