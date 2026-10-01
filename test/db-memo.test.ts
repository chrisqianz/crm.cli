/**
 * A REPL is one process running many commands, and every command opens the
 * database through `openDB`. Without memoization each line creates a fresh
 * libSQL client that nothing ever closes and re-runs the whole schema
 * bootstrap — the same one-process-many-parses hazard class as the shared
 * collecting-flag leak. `openDB` must hand back one memoized handle per
 * resolved path; one-shot mode (one open per process) is unchanged.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { openDB } from '../src/db'

function freshDbDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'crm-dbmemo-')), name)
}

describe('openDB memoization', () => {
  test('the same path yields the same handle, however spelled', async () => {
    const p = freshDbDir('a.db')
    const first = await openDB(p)
    const again = await openDB(p)
    expect(again).toBe(first)
    // String concat, not join: join would normalize the `..` away and the
    // spelling would be identical. Different spelling, same resolved file —
    // the memo key is `resolve(path)`, so both land on the same handle.
    const spelled = `${dirname(p)}/../${basename(dirname(p))}/${basename(p)}`
    const againSpelled = await openDB(spelled)
    expect(spelled).not.toBe(p)
    expect(againSpelled).toBe(first)
  })

  test('a different path is a different handle', async () => {
    const a = await openDB(freshDbDir('a.db'))
    const b = await openDB(freshDbDir('b.db'))
    expect(a).not.toBe(b)
  })
})
