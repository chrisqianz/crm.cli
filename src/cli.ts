#!/usr/bin/env node

import { Command } from 'commander'

import {
  registerActivityCommands,
  registerLogCommand,
} from './commands/activity'
import { registerAdminCommands } from './commands/admin'
import { registerAuditCommands } from './commands/audit'
import { registerBackupCommands } from './commands/backup'
import { registerCompanyCommands } from './commands/company'
import { registerContactCommands } from './commands/contact'
import { registerDealCommands, registerPipelineCommand } from './commands/deal'
import { registerDupesCommand } from './commands/dupes'
import { registerFuseCommands } from './commands/fuse'
import { registerImportExportCommands } from './commands/importexport'
import { registerLoginCommands } from './commands/login'
import { registerReportCommands } from './commands/report'
import { registerSearchCommands } from './commands/search'
import { registerServeCommand } from './commands/serve'
import { registerTagCommands } from './commands/tag'
import { startDaemon } from './fuse-daemon'
import { cleanArgv } from './lib/helpers'

// Injected at build time via --define; falls back to package.json for dev/test
declare const __PKG_VERSION__: string | undefined
const version =
  typeof __PKG_VERSION__ === 'undefined'
    ? (await import('../package.json', { with: { type: 'json' } })).default
        .version
    : __PKG_VERSION__

const program = new Command()
// -V prints the CLI version. `--version` is intentionally NOT a program-level
// flag: it is the optimistic-locking argument of `contact/company/deal edit`
// and `deal move` (a top-level --version would swallow the subcommand flag).
program.name('crm').description('Headless CLI-first CRM').version(version, '-V')
program.exitOverride()

registerContactCommands(program)
registerAuditCommands(program)
registerCompanyCommands(program)
registerDealCommands(program)
registerPipelineCommand(program)
registerLogCommand(program)
registerActivityCommands(program)
registerTagCommands(program)
registerSearchCommands(program)
registerReportCommands(program)
registerImportExportCommands(program)
registerDupesCommand(program)
registerFuseCommands(program)
registerServeCommand(program)
registerLoginCommands(program)
registerAdminCommands(program)
registerBackupCommands(program)

// Hidden subcommand: runs the FUSE daemon in-process (used by `crm mount`)
if (cleanArgv[0] === '__daemon') {
  startDaemon(cleanArgv.slice(1)).catch((err) => {
    console.error('fuse-daemon fatal:', err)
    process.exit(1)
  })
} else {
  try {
    program.parse(['node', 'crm', ...cleanArgv])
  } catch (e: unknown) {
    const err = e as { exitCode?: number; message?: string }
    if (err.exitCode !== undefined && err.exitCode === 0) {
      process.exit(0)
    }
    if (err.exitCode !== undefined) {
      process.exit(err.exitCode)
    }
    console.error(err.message || e)
    process.exit(1)
  }
}
