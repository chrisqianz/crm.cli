/**
 * Session surface of the REPL: where this session's data comes from and how
 * that reads on the status line. Lives apart from repl.ts so the loop stays
 * about the loop.
 */

import { basename } from 'node:path'

import { loadSession } from '../lib/session'

/** Where this session's data would come from: a local db, a server, or neither. */
export function statusLine(ctx: { entryArgv: string[] }): string {
  const db = flagValue(ctx.entryArgv, '--db')
  if (db) {
    return `local:${basename(db)}`
  }
  const session = loadSession()
  if (session) {
    return session.username
      ? `${session.username}@${session.server} ✓`
      : `${session.server} ✓`
  }
  return 'not logged in'
}

/** The server this session should talk to when the human does not name one:
 * an explicit env override first, then the saved login. Null means the login
 * wizard has to ask. */
export function knownServer(): string | null {
  return process.env.CRM_SERVER || loadSession()?.server || null
}

/** The separated form is the only one that can reach the REPL: the argv
 * pre-parser strips `--db <path>` and nothing else, so `--db=x.db` never
 * empties `cleanArgv` and never opens a session at all. */
export function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
