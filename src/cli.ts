#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { Command } from 'commander'

import {
  registerActivityCommands,
  registerLogCommand,
} from './commands/activity'
import { registerAdminCommands } from './commands/admin'
import { registerAuditCommands } from './commands/audit'
import { registerBackupCommands } from './commands/backup'
import { registerCompanyCommands } from './commands/company'
import { registerCompletionCommand } from './commands/completion'
import { registerContactCommands } from './commands/contact'
import { registerDealCommands, registerPipelineCommand } from './commands/deal'
import { registerDupesCommand } from './commands/dupes'
import { registerEmailCommands } from './commands/email'
import { registerFuseCommands } from './commands/fuse'
import { registerImportExportCommands } from './commands/importexport'
import { registerLoginCommands } from './commands/login'
import { registerMigrateCommand } from './commands/migrate'
import { registerPasswordCommands } from './commands/password'
import { registerReportCommands } from './commands/report'
import { registerSearchCommands } from './commands/search'
import { registerServeCommand } from './commands/serve'
import { registerStatusCommands } from './commands/status'
import { registerSuggestCommand } from './commands/suggest'
import { registerTagCommands } from './commands/tag'
import { registerTaskCommands } from './commands/task'
import { startDaemon } from './fuse-daemon'
import { cleanArgv } from './lib/helpers'
import { commandsWithFlag, suggestCommands } from './lib/suggest'
import { runRepl } from './repl/repl'

// Injected at build time via --define; falls back to package.json for dev/test
declare const __PKG_VERSION__: string | undefined
const version =
  typeof __PKG_VERSION__ === 'undefined'
    ? (await import('../package.json', { with: { type: 'json' } })).default
        .version
    : __PKG_VERSION__

/**
 * The whole command tree, built fresh. Exported for the REPL, which executes
 * every line through this same program; the entry-side work at the bottom of
 * this file only runs when the process started here, so importing
 * `buildProgram` never parses the host's argv.
 */
export function buildProgram(): Command {
  const program = new Command()
  // -V prints the CLI version. `--version` is intentionally NOT a program-level
  // flag: it is the optimistic-locking argument of `contact/company/deal edit`
  // and `deal move` (a top-level --version would swallow the subcommand flag).
  program
    .name('crm')
    .description('Headless CLI-first CRM')
    .version(version, '-V')
  program.exitOverride()

  registerContactCommands(program)
  registerAuditCommands(program)
  registerStatusCommands(program)
  registerCompanyCommands(program)
  registerDealCommands(program)
  registerPipelineCommand(program)
  registerLogCommand(program)
  registerActivityCommands(program)
  registerTagCommands(program)
  registerSearchCommands(program)
  registerReportCommands(program)
  registerImportExportCommands(program)
  registerMigrateCommand(program)
  registerDupesCommand(program)
  registerEmailCommands(program)
  registerTaskCommands(program)
  registerFuseCommands(program)
  registerServeCommand(program)
  registerLoginCommands(program)
  registerPasswordCommands(program)
  registerAdminCommands(program)
  registerBackupCommands(program)
  registerCompletionCommand(program)
  registerSuggestCommand(program)

  return program
}

if (isCliEntrypoint()) {
  await main()
}

async function main(): Promise<void> {
  const program = buildProgram()

  // Hidden subcommand: runs the FUSE daemon in-process (used by `crm mount`)
  if (cleanArgv[0] === '__daemon') {
    startDaemon(cleanArgv.slice(1)).catch((err) => {
      console.error('fuse-daemon fatal:', err)
      process.exit(1)
    })
    return
  }

  // Nothing but global flags and a terminal to type at: that is the human
  // path. Non-TTY keeps commander's usage error, so the machine surface
  // (`crm` with no args in a script) is untouched.
  if (
    cleanArgv.length === 0 &&
    (process.stdin.isTTY || process.env.CRM_REPL_FORCE === '1')
  ) {
    // The raw slice, not cleanArgv: `status` reports where the data comes
    // from, and cleanArgv has already eaten the `--db <path>` that says so.
    await runRepl(program, undefined, process.argv.slice(2))
    return
  }

  try {
    program.parse(['node', 'crm', ...cleanArgv])
  } catch (e: unknown) {
    const err = e as { exitCode?: number; message?: string }
    if (err.exitCode !== undefined && err.exitCode === 0) {
      process.exit(0)
    }
    const hint =
      unknownOptionHint(program, err.message ?? '') ??
      unknownCommandHint(program, err.message ?? '')
    if (hint) {
      console.error(hint)
    }
    if (err.exitCode !== undefined) {
      process.exit(err.exitCode)
    }
    console.error(err.message || e)
    process.exit(1)
  }
}

/**
 * True when this module is the process entrypoint. `import.meta.main` covers
 * bun; the argv/URL comparison covers the bundled `dist/cli.js` run by node,
 * where bun's flag is not available.
 */
function isCliEntrypoint(): boolean {
  if (import.meta.main === true) {
    return true
  }
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  try {
    // Node resolves the main module through symlinks by default, so
    // import.meta.url is the realpath while argv[1] is the path as typed
    // (bin/crm → dist/cli.js). Compare like like.
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

/**
 * When an option is typed on a command group (`crm contact --email x`),
 * commander only says "unknown option". Point at the subcommand that owns
 * the flag.
 */
function unknownOptionHint(program: Command, message: string): string | null {
  const m = /^error: unknown option '(-{1,2}[A-Za-z0-9-]+)'/.exec(message)
  if (!m) {
    return null
  }
  const owners = commandsWithFlag(program, m[1]).slice(0, 3)
  if (owners.length === 0) {
    return null
  }
  const list = owners.map((o) => `  crm ${o} ${m[1]}...`).join('\n')
  return `\nhint: '${m[1]}' is an option of:\n${list}`
}

/**
 * On an unknown subcommand, suggest the closest commands across the
 * whole tree (commander's own "did you mean" only sees one level).
 */
function unknownCommandHint(program: Command, message: string): string | null {
  const m = /^error: unknown command '([^']*)'/.exec(message)
  if (!m) {
    return null
  }
  const hits = suggestCommands(program, m[1], 3)
  if (hits.length === 0) {
    return null
  }
  const list = hits.map((h) => `  crm ${h.path}`).join('\n')
  return `\nhint: you probably meant:\n${list}`
}
