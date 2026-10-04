#!/usr/bin/env bun
// Committed bin entry so package managers can create the `crm` command
// link even before a build exists. The real entry is dist/cli.js; for
// git installs it is produced by the postinstall guard in package.json.
try {
  await import('../dist/cli.js')
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('dist/cli.js')) {
    console.error(
      'crm.cli: dist/cli.js is missing — the build has not run yet.\n' +
        'Run: cd <install-dir> && bun run build',
    )
    process.exit(1)
  }
  throw e
}
