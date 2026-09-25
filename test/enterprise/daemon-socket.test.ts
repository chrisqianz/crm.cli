import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensurePrivateDir,
  socketPathFor,
  socketsDir,
} from '../../src/lib/paths.ts'

/**
 * P0 security: the FUSE daemon serves unauthenticated newline-delimited
 * JSON. Its socket must therefore live in a user-private directory
 * (0700) and the socket file itself must be 0600 — the old tmpdir()
 * location is world-accessible on Linux (/tmp).
 */
const CRM_BIN = join(import.meta.dir, '..', '..', 'src', 'cli.ts')

function modeOf(path: string): number {
  // permission bits = last three octal digits of mode (0o100644 → 0o644)
  return Number.parseInt(lstatSync(path).mode.toString(8).slice(-3), 8)
}

describe('daemon socket hardening (P0 security)', () => {
  test('socket path resolves under user-private ~/.crm/sockets, never tmpdir', () => {
    const p = socketPathFor('/mnt/some mount')
    expect(p.startsWith(join(homedir(), '.crm', 'sockets'))).toBe(true)
    expect(p.startsWith(tmpdir())).toBe(false)
  })

  test('ensurePrivateDir enforces 0700', () => {
    ensurePrivateDir(socketsDir)
    expect(modeOf(socketsDir)).toBe(0o700)
  })

  test('daemon listens on a 0600 socket', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'crm-sock-test-'))
    const dbPath = join(workdir, 'test.db')
    const sock = socketPathFor(`${workdir}-mountpoint`)
    ensurePrivateDir(socketsDir)

    const proc = spawn('bun', ['run', CRM_BIN, '__daemon', sock, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000)
      let buf = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        if (buf.includes('READY')) {
          clearTimeout(timer)
          resolve(true)
        }
      })
      proc.on('exit', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })

    try {
      expect(ready).toBe(true)
      expect(modeOf(sock)).toBe(0o600)
    } finally {
      proc.kill()
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
