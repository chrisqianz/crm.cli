import { readFileSync } from 'node:fs'

import type { Command } from 'commander'

import { formatOutput } from '../format'
import { parseCSV } from '../lib/helpers'
import { dispatch, renderCtx } from '../remote/dispatch'

export function registerImportExportCommands(program: Command) {
  const imp = program.command('import').description('Import data')

  imp
    .command('contacts')
    .argument('<file>')
    .option('--dry-run')
    .option('--skip-errors')
    .option('--update')
    .action(async (file, opts) => {
      const records = readRecords(file)
      const result = (await dispatch('import.contacts', {
        records,
        dryRun: opts.dryRun,
        skipErrors: opts.skipErrors,
        update: opts.update,
      })) as {
        imported: number
        skipped: number
        errors: number
        dryRunLines: string[]
      }
      for (const line of result.dryRunLines) {
        console.log(line)
      }
      console.log(
        `Imported: ${result.imported}, skipped: ${result.skipped}, errors: ${result.errors}`,
      )
    })

  imp
    .command('companies')
    .argument('<file>')
    .option('--dry-run')
    .option('--skip-errors')
    .action(async (file, opts) => {
      const records = readRecords(file)
      const result = (await dispatch('import.companies', {
        records,
        dryRun: opts.dryRun,
        skipErrors: opts.skipErrors,
      })) as { imported: number; dryRunLines: string[] }
      for (const line of result.dryRunLines) {
        console.log(line)
      }
      console.log(`Imported: ${result.imported}`)
    })

  imp
    .command('deals')
    .argument('<file>')
    .option('--dry-run')
    .option('--skip-errors')
    .action(async (file, opts) => {
      const records = readRecords(file)
      const result = (await dispatch('import.deals', {
        records,
        dryRun: opts.dryRun,
        skipErrors: opts.skipErrors,
      })) as { imported: number; dryRunLines: string[] }
      for (const line of result.dryRunLines) {
        console.log(line)
      }
      console.log(`Imported: ${result.imported}`)
    })

  const exp = program.command('export').description('Export data')
  exp.command('contacts').action(async () => {
    const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
      'export.contacts',
      {},
    )
    const { config, fmt } = renderCtx()
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('companies').action(async () => {
    const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
      'export.companies',
      {},
    )
    const { config, fmt } = renderCtx()
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('deals').action(async () => {
    const { rows } = await dispatch<{ rows: Record<string, unknown>[] }>(
      'export.deals',
      {},
    )
    const { config, fmt } = renderCtx()
    console.log(formatOutput(rows, fmt, config))
  })
  exp.command('all').action(async () => {
    const { data } = (await dispatch('export.all', {})) as {
      data: Record<string, unknown[]>
    }
    const { config, fmt } = renderCtx()
    if (fmt === 'json') {
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log(
        formatOutput(
          Object.entries(data).map(([k, v]) => ({ type: k, count: v.length })),
          fmt,
          config,
        ),
      )
    }
  })
}

function readRecords(file: string): Record<string, string>[] {
  let raw: string
  if (file === '-') {
    const chunks: Buffer[] = []
    const fd = require('node:fs').openSync('/dev/stdin', 'r')
    const buf = Buffer.alloc(65_536)
    let n = require('node:fs').readSync(fd, buf) as number
    while (n > 0) {
      chunks.push(buf.subarray(0, n))
      n = require('node:fs').readSync(fd, buf) as number
    }
    require('node:fs').closeSync(fd)
    raw = Buffer.concat(chunks).toString('utf-8')
  } else {
    raw = readFileSync(file, 'utf-8')
  }
  raw = raw.trim()
  if (!raw) {
    return []
  }
  if (raw.startsWith('[') || raw.startsWith('{')) {
    return JSON.parse(raw)
  }
  return parseCSV(raw)
}
