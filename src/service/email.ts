/**
 * Outbound email (`crm email send`). Sends through the configured SMTP
 * relay and logs an `email` activity on the contact so the CRM record
 * stays the source of truth for "what did we tell this customer".
 *
 * Trust model: relay credentials never live in the config file.
 * `[mail]` carries host/port/user/from (routing, not secrets); the
 * password comes from the process env `CRM_SMTP_PASSWORD` — the same
 * posture as the LDAP bind password.
 */
import type { CRMConfig } from '../config'
import type { DB } from '../db'
import { safeJSON } from '../format'
import { ServiceError } from '../lib/errors'
import { smtpSend } from '../lib/smtp'
import { resolveContact } from '../resolve'
import { activityLog } from './activity'
import { dealResolve } from './deal'

export interface EmailSendParams {
  actor?: string
  body: string
  cc?: string[]
  contact: string
  /** Link the activity to a deal (ref). */
  deal?: string
  subject: string
  /** Override the contact's first address. */
  to?: string
}

export async function emailSend(
  db: DB,
  config: CRMConfig,
  p: Record<string, unknown>,
): Promise<{ sent_to: string; subject: string }> {
  const opts = p as unknown as EmailSendParams
  if (!config.mail.host) {
    throw new ServiceError(
      'INVALID',
      'Error: SMTP not configured — set [mail] host/user in the server config (password via CRM_SMTP_PASSWORD)',
    )
  }
  const password = process.env.CRM_SMTP_PASSWORD
  if (!password) {
    throw new ServiceError(
      'INVALID',
      'Error: SMTP password missing — set CRM_SMTP_PASSWORD in the server environment',
    )
  }
  const subject = (opts.subject ?? '').trim()
  const body = (opts.body ?? '').trim()
  if (!subject) {
    throw new ServiceError(
      'INVALID',
      "Error: required option '--subject <subject>' not specified",
    )
  }
  if (!body) {
    throw new ServiceError(
      'INVALID',
      "Error: required option '--body <text>' not specified (or --body-file)",
    )
  }

  const c = await resolveContact(db, opts.contact ?? '', config)
  if (!c) {
    throw new ServiceError(
      'NOT_FOUND',
      `Error: contact not found: ${opts.contact}`,
    )
  }
  const to = (opts.to ?? safeJSON(c.emails)?.[0] ?? '').trim()
  if (!to) {
    throw new ServiceError(
      'INVALID',
      `Error: contact "${c.name}" has no email address — pass --to <addr>`,
    )
  }

  let dealRef: string | undefined
  if (opts.deal) {
    dealRef = (await dealResolve(db, config, { ref: opts.deal })).id
  }

  await smtpSend({
    host: config.mail.host,
    port: config.mail.port,
    user: config.mail.user || undefined,
    password,
    secure: config.mail.secure,
    from: config.mail.from || config.mail.user || 'crm@localhost',
    to: [to],
    cc: opts.cc ?? [],
    subject,
    text: body,
  })

  await activityLog(db, config, {
    type: 'email',
    body: `Sent "${subject}" to ${to}`,
    contact: [c.id],
    deal: dealRef,
    actor: opts.actor,
  } as Record<string, unknown>)

  return { sent_to: to, subject }
}
