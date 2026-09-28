import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@libsql/client'

import {
  ensurePrivateDir,
  socketPathFor,
  socketsDir,
} from '../../src/lib/paths.ts'

/**
 * P3: the FUSE full-document write path gets CAS for free — the document
 * carries `version`, so a write with a stale version must be rejected
 * (spec/enterprise.md "Concurrency: optimistic locking", point 3).
 *
 * Drives the daemon's NDJSON socket directly (no mount required).
 */
const CRM_BIN = join(import.meta.dir, '..', '..', 'src', 'cli.ts')

interface Daemon {
  close: () => Promise<void>
  dbPath: string
  proc: ReturnType<typeof spawn>
  send: (obj: Record<string, unknown>) => Promise<Record<string, unknown>>
  socket: string
}

async function startDaemon(): Promise<Daemon> {
  const workdir = mkdtempSync(join(tmpdir(), 'crm-daemon-cas-'))
  const dbPath = join(workdir, 'test.db')
  const socket = socketPathFor(`${workdir}-mountpoint`)
  ensurePrivateDir(socketsDir)

  const proc = spawn('bun', ['run', CRM_BIN, '__daemon', socket, dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('daemon did not become ready')),
      10_000,
    )
    let buf = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      if (buf.includes('READY')) {
        clearTimeout(timer)
        resolve()
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`daemon exited early (code ${code})`))
    })
  })

  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void
      reject: (e: Error) => void
    }
  >()
  let nextId = 1

  const sock = await new Promise<ReturnType<typeof connect>>(
    (resolve, reject) => {
      const s = connect(socket, () => resolve(s))
      s.on('error', reject)
    },
  )
  let buf = ''
  sock.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let idx: number
    for (;;) {
      idx = buf.indexOf('\n')
      if (idx === -1) {
        break
      }
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) {
        continue
      }
      const msg = JSON.parse(line) as {
        id?: number
        ok?: boolean
        error?: string
        msg?: string
      }
      const p = pending.get(msg.id ?? -1)
      if (p) {
        pending.delete(msg.id ?? -1)
        p.resolve({ ...(msg as Record<string, unknown>) })
      }
    }
  })

  function send(
    obj: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('daemon op timed out')),
        10_000,
      )
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      sock.write(`${JSON.stringify({ ...obj, id })}\n`)
    })
  }

  return {
    proc,
    socket,
    dbPath,
    send,
    close: async () => {
      sock.end()
      proc.kill()
      await new Promise<void>((resolve) => proc.on('exit', () => resolve()))
    },
  }
}

describe('P3 CAS: FUSE document write path', () => {
  test('document round-trips version; stale-version write is rejected with ECONFLICT', async () => {
    const d = await startDaemon()
    try {
      const client = createClient({ url: `file:${d.dbPath}` })
      // seed a contact directly so the daemon has a document to serve
      await client.execute(
        `INSERT INTO contacts (id, name, emails, phones, companies, tags, custom_fields, created_at, updated_at)
         VALUES ('ct_casdockey00000000000000000', 'Doc', '[]', '[]', '[]', '[]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      // read the document — it carries version 1
      const read = await d.send({
        op: 'read',
        path: 'contacts/ct_casdockey00000000000000000...doc.json',
      })
      const doc = JSON.parse(String(read.data)) as {
        version: number
        name: string
      }
      expect(doc.version).toBe(1)

      // a write that includes the current version succeeds (v2)
      const okWrite = await d.send({
        op: 'write',
        path: 'contacts/ct_casdockey00000000000000000...doc.json',
        data: JSON.stringify({ ...doc, name: 'Doc-2' }),
      })
      expect(okWrite.ok).toBe(true)

      // a write with the stale version (1) must be rejected
      const staleWrite = await d.send({
        op: 'write',
        path: 'contacts/ct_casdockey00000000000000000...doc.json',
        data: JSON.stringify({ ...doc, name: 'Doc-stale' }),
      })
      expect(staleWrite.error).toBe('ECONFLICT')

      // a write without a version still works (backward compatible, LWW)
      const lww = await d.send({
        op: 'write',
        path: 'contacts/ct_casdockey00000000000000000...doc.json',
        data: JSON.stringify({ name: 'Doc-lww' }),
      })
      expect(lww.ok).toBe(true)

      const finalRead = await d.send({
        op: 'read',
        path: 'contacts/ct_casdockey00000000000000000...doc.json',
      })
      const finalDoc = JSON.parse(String(finalRead.data)) as {
        version: number
        name: string
      }
      expect(finalDoc.name).toBe('Doc-lww')
      expect(finalDoc.version).toBe(3)

      await client.close()
    } finally {
      await d.close()
    }
  }, 90_000)
})
