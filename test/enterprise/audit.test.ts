import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@libsql/client'

import { diffSnapshots, renderDiff } from '../../src/lib/diff'
import {
  ensurePrivateDir,
  socketPathFor,
  socketsDir,
} from '../../src/lib/paths.ts'
import {
  bootstrapOwner,
  CRM,
  connect,
  freshDb,
  REPO,
  startServer,
  type TestServer,
} from './helpers'

/**
 * P4: audit hash chain.
 *
 * spec/enterprise.md "Audit": every mutation produces a row; each row
 * carries prev_hash + row_hash (sha256); tampering with row N breaks every
 * row after N; `crm audit verify` walks the chain and reports the first
 * broken seq. Local mode (source=cli-local, actor=OS user), remote mode
 * (source=rpc, actor=acting user) and the FUSE daemon (source=fuse) all
 * land in the same chain.
 */

interface AuditRow {
  action: string
  actor_id: string
  actor_name: string
  after_json: string | null
  at: string
  before_json: string | null
  entity_id: string | null
  entity_type: string | null
  ip: string | null
  prev_hash: string
  row_hash: string
  seq: number
  source: string
}

async function auditRows(dbPath: string, where = ''): Promise<AuditRow[]> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const r = await client.execute(
      `SELECT * FROM audit_log ${where} ORDER BY seq`,
    )
    const cols = r.columns
    return r.rows.map((row) => {
      const values = row as unknown as unknown[]
      const o: Record<string, unknown> = {}
      cols.forEach((c, i) => {
        o[c] = values[i]
      })
      return o as unknown as AuditRow
    })
  } finally {
    client.close()
  }
}

function remoteRun(
  server: TestServer,
  token: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: mkdtempSync(join(tmpdir(), 'crm-p4-home-')),
      CRM_SERVER: `127.0.0.1:${server.port}`,
      CRM_TOKEN: token,
      CRM_INSECURE: '1',
      CRM_CONFIG: '/dev/null',
    },
  })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

async function withServer<T>(
  fn: (server: TestServer, token: string) => T | Promise<T>,
): Promise<T> {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    return await fn(server, owner.token)
  } finally {
    await server.close()
    cleanup()
  }
}

describe('P4 audit: hash chain', () => {
  test('remote writes are chained: prev/row hashes link in seq order', async () => {
    await withServer(async (server, token) => {
      remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'A',
        '--email',
        'a@p4.test',
      ])
      remoteRun(server, token, [
        'company',
        'add',
        '--name',
        'C',
        '--website',
        'c.p4.test',
      ])
      remoteRun(server, token, ['contact', 'edit', 'a@p4.test', '--name', 'A2'])
      const rows = await auditRows(server.dbPath)
      // bootstrap + login already audited; filter to the data writes
      const writes = rows.filter((r) =>
        ['contact.add', 'company.add', 'contact.edit'].includes(r.action),
      )
      expect(writes.length).toBe(3)
      expect(writes[0].source).toBe('rpc')
      expect(writes[0].actor_name).toBe('admin')
      // chain: first row's prev is genesis, each next prev = prior row_hash
      const GENESIS = '0'.repeat(64)
      // the full chain (incl. auth rows) must be unbroken
      let expectedPrev = GENESIS
      for (const r of rows) {
        expect(r.prev_hash, `seq ${r.seq} prev mismatch`).toBe(expectedPrev)
        expect(r.row_hash).toMatch(/^[0-9a-f]{64}$/)
        expectedPrev = r.row_hash
      }
    })
  }, 60_000)

  test('before/after snapshots capture the change', async () => {
    await withServer(async (server, token) => {
      const add = remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'Snap',
        '--email',
        'snap@p4.test',
      ])
      expect(add.exitCode, add.stderr).toBe(0)
      const id = add.stdout.trim()
      remoteRun(server, token, ['contact', 'edit', id, '--name', 'Snapped'])

      const rows = await auditRows(server.dbPath)
      const addRow = rows.find((r) => r.action === 'contact.add')
      const editRow = rows.find((r) => r.action === 'contact.edit')
      expect(addRow).toBeDefined()
      expect(editRow).toBeDefined()
      // insert: no before, after carries the created entity
      expect(addRow!.before_json).toBeNull()
      const addAfter = JSON.parse(addRow!.after_json!) as { name: string }
      expect(addAfter.name).toBe('Snap')
      // edit: before is the pre-edit state, after the post-edit state
      const before = JSON.parse(editRow!.before_json!) as { name: string }
      const after = JSON.parse(editRow!.after_json!) as { name: string }
      expect(before.name).toBe('Snap')
      expect(after.name).toBe('Snapped')
      expect(editRow!.entity_id).toBe(id)
      expect(editRow!.entity_type).toBe('contact')
    })
  }, 60_000)

  test('verify walks the chain and passes on an untampered db', async () => {
    await withServer((server, token) => {
      remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'V',
        '--email',
        'v@p4.test',
      ])
      const out = remoteRun(server, token, ['audit', 'verify'])
      expect(out.exitCode, out.stderr).toBe(0)
      expect(out.stdout).toMatch(/ok/i)
      expect(out.stdout).toMatch(/chain/i)
    })
  }, 60_000)

  test('verify detects a single-row tamper and reports the seq', async () => {
    await withServer(async (server, token) => {
      remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'T',
        '--email',
        't@p4.test',
      ])
      remoteRun(server, token, ['contact', 'edit', 't@p4.test', '--name', 'T2'])
      const rows = await auditRows(server.dbPath)
      const victim = rows.find((r) => r.action === 'contact.add')!
      const client = createClient({ url: `file:${server.dbPath}` })
      await client.execute(
        `UPDATE audit_log SET actor_name = 'mallory' WHERE seq = ?`,
        [victim.seq],
      )
      client.close()
      const out = remoteRun(server, token, ['audit', 'verify'])
      expect(out.exitCode).toBe(1)
      expect(out.stdout + out.stderr).toMatch(new RegExp(`seq ${victim.seq}`))
    })
  }, 60_000)

  test('verify detects a deleted row (chain break at the next row)', async () => {
    await withServer(async (server, token) => {
      remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'D',
        '--email',
        'd@p4.test',
      ])
      remoteRun(server, token, [
        'company',
        'add',
        '--name',
        'C',
        '--website',
        'c2.p4.test',
      ])
      const rows = await auditRows(server.dbPath)
      const victim = rows.find((r) => r.action === 'contact.add')!
      const client = createClient({ url: `file:${server.dbPath}` })
      await client.execute('DELETE FROM audit_log WHERE seq = ?', [victim.seq])
      client.close()
      const out = remoteRun(server, token, ['audit', 'verify'])
      expect(out.exitCode).toBe(1)
      // the row AFTER the gap no longer links to its predecessor
      const outText = out.stdout + out.stderr
      expect(outText).toMatch(/tamper|broken|mismatch|missing/i)
    })
  }, 60_000)

  test('legacy (pre-P4) rows are reported, chain still verifies', async () => {
    await withServer(async (server, token) => {
      // simulate a pre-P4 row: empty hashes
      const client = createClient({ url: `file:${server.dbPath}` })
      await client.execute(
        `INSERT INTO audit_log (at, actor_id, actor_name, action, source)
         VALUES ('2026-01-01T00:00:00.000Z', 'legacy', 'legacy-user', 'contact.add', 'rpc')`,
      )
      client.close()
      remoteRun(server, token, [
        'contact',
        'add',
        '--name',
        'L',
        '--email',
        'l@p4.test',
      ])
      const out = remoteRun(server, token, ['audit', 'verify'])
      expect(out.exitCode, out.stdout + out.stderr).toBe(0)
      expect(out.stdout).toMatch(/legacy/i)
    })
  }, 60_000)
})

describe('P4 audit: local mode rows', () => {
  test('local writes land in the same chain (source=cli-local, actor=OS user)', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const proc = Bun.spawnSync(
        [
          'bun',
          'run',
          CRM,
          '--db',
          dbPath,
          '--config',
          '/dev/null',
          'contact',
          'add',
          '--name',
          'Local',
          '--email',
          'local@p4.test',
        ],
        { env: { ...process.env, NO_COLOR: '1' } },
      )
      expect(proc.exitCode, proc.stderr.toString()).toBe(0)
      const rows = await auditRows(dbPath)
      const row = rows.find((r) => r.action === 'contact.add')
      expect(row).toBeDefined()
      expect(row!.source).toBe('cli-local')
      const osUser = process.env.USER || process.env.LOGNAME
      if (osUser) {
        expect(row!.actor_name).toBe(osUser)
      }
      // chain intact
      const GENESIS = '0'.repeat(64)
      let expectedPrev = GENESIS
      for (const r of rows) {
        expect(r.prev_hash).toBe(expectedPrev)
        expectedPrev = r.row_hash
      }
    } finally {
      cleanup()
    }
  }, 60_000)

  test('local `crm audit verify` passes; tamper fails locally too', async () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const run = (
        ...args: string[]
      ): { exitCode: number; stdout: string; stderr: string } => {
        const p = Bun.spawnSync(
          ['bun', 'run', CRM, '--db', dbPath, '--config', '/dev/null', ...args],
          { env: { ...process.env, NO_COLOR: '1' } },
        )
        return {
          exitCode: p.exitCode,
          stdout: p.stdout.toString(),
          stderr: p.stderr.toString(),
        }
      }
      expect(
        run('contact', 'add', '--name', 'X', '--email', 'x@p4.test').exitCode,
      ).toBe(0)
      const ok = run('audit', 'verify')
      expect(ok.exitCode, ok.stdout + ok.stderr).toBe(0)

      const client = createClient({ url: `file:${dbPath}` })
      const r = await client.execute(
        `SELECT seq FROM audit_log WHERE action = 'contact.add' LIMIT 1`,
      )
      const seq = Number(String(r.rows[0].seq))
      await client.execute(
        `UPDATE audit_log SET action = 'contact.hack' WHERE seq = ?`,
        [seq],
      )
      client.close()
      const bad = run('audit', 'verify')
      expect(bad.exitCode).toBe(1)
      expect(bad.stdout + bad.stderr).toMatch(`seq ${seq}`)
    } finally {
      cleanup()
    }
  }, 60_000)
})

describe('P4 audit: FUSE daemon writes', () => {
  test('daemon document writes are audited with source=fuse', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'crm-p4-daemon-'))
    const dbPath = join(workdir, 'test.db')
    const socket = socketPathFor(`${workdir}-mountpoint`)
    ensurePrivateDir(socketsDir)

    const proc = spawn('bun', ['run', CRM, '__daemon', socket, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let ready = false
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('daemon not ready')),
        15_000,
      )
      let buf = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        if (buf.includes('READY')) {
          ready = true
          clearTimeout(timer)
          resolve()
        }
      })
      proc.on('exit', (code) => reject(new Error(`daemon exited ${code}`)))
    })
    expect(ready).toBe(true)

    try {
      const pending = new Map<
        number,
        {
          resolve: (v: Record<string, unknown>) => void
          reject: (e: Error) => void
        }
      >()
      let nextId = 1
      const sock = await new Promise<ReturnType<typeof netConnect>>(
        (resolve, reject) => {
          const s = netConnect(socket, () => resolve(s))
          s.on('error', reject)
        },
      )
      let buf = ''
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        for (;;) {
          const idx = buf.indexOf('\n')
          if (idx === -1) {
            break
          }
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (!line.trim()) {
            continue
          }
          const msg = JSON.parse(line) as { id?: number }
          const p = pending.get(msg.id ?? -1)
          if (p) {
            pending.delete(msg.id ?? -1)
            p.resolve(msg as Record<string, unknown>)
          }
        }
      })
      const send = (
        obj: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
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

      // seed a contact, write its document through the daemon
      const client = createClient({ url: `file:${dbPath}` })
      await client.execute(
        `INSERT INTO contacts (id, name, emails, phones, companies, tags, custom_fields, created_at, updated_at)
         VALUES ('ct_p4daemonkey00000000000000000', 'Fuse', '[]', '[]', '[]', '[]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      client.close()
      const read = await send({
        op: 'read',
        path: 'contacts/ct_p4daemonkey00000000000000000...doc.json',
      })
      const doc = JSON.parse(String(read.data))
      const w = await send({
        op: 'write',
        path: 'contacts/ct_p4daemonkey00000000000000000...doc.json',
        data: JSON.stringify({ ...doc, name: 'Fused' }),
      })
      expect(w.ok).toBe(true)

      const rows = await auditRows(dbPath)
      const fuseRow = rows.find((r) => r.source === 'fuse')
      expect(fuseRow).toBeDefined()
      expect(fuseRow!.entity_type).toBe('contact')
      expect(fuseRow!.entity_id).toBe('ct_p4daemonkey00000000000000000')
      const after = JSON.parse(fuseRow!.after_json!) as { name: string }
      expect(after.name).toBe('Fused')
      sock.end()
    } finally {
      proc.kill()
      await new Promise<void>((resolve) => proc.on('exit', () => resolve()))
    }
  }, 90_000)
})

describe('P4 audit: remote command access', () => {
  test('reader can audit list/verify/export remotely', async () => {
    await withServer(async (server, ownerToken) => {
      remoteRun(server, ownerToken, [
        'contact',
        'add',
        '--name',
        'R',
        '--email',
        'r@p4.test',
      ])
      const client = await connect(server.port, ownerToken)
      try {
        await client.call('admin.user.create', {
          username: 'audreader',
          role: 'reader',
        })
        const created = await client.call<{ token: string }>(
          'admin.token.create',
          {
            name: 'audreader-token',
            username: 'audreader',
          },
        )
        const readerToken = created.token
        const list = remoteRun(server, readerToken, ['audit', 'list'])
        expect(list.exitCode, list.stderr).toBe(0)
        expect(list.stdout).toContain('contact.add')
        const verify = remoteRun(server, readerToken, ['audit', 'verify'])
        expect(verify.exitCode, verify.stdout + verify.stderr).toBe(0)
        const exportOut = remoteRun(server, readerToken, [
          'audit',
          'export',
          '--format',
          'json',
        ])
        expect(exportOut.exitCode, exportOut.stderr).toBe(0)
        const rows = JSON.parse(exportOut.stdout) as Array<{ action: string }>
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.some((r) => r.action === 'contact.add')).toBe(true)
      } finally {
        client.close()
      }
    })
  }, 90_000)

  // Regression (P9 review): handleCommand strips client `actor` for writes,
  // but on READ methods actor is a legitimate filter (audit list --actor).
  // Dropping it there silently returns the whole log for every actor.
  test('remote audit list --actor filters by actor', async () => {
    await withServer(async (server, ownerToken) => {
      const admin = await connect(server.port, ownerToken)
      let linToken = ''
      try {
        await admin.call('admin.user.create', {
          username: 'filter.lin',
          role: 'writer',
        })
        const created = await admin.call<{ token: string }>(
          'admin.token.create',
          { name: 'filter-lin-token', username: 'filter.lin' },
        )
        linToken = created.token
      } finally {
        admin.close()
      }
      remoteRun(server, ownerToken, [
        'contact',
        'add',
        '--name',
        'ByAdmin',
        '--email',
        'ba@p4.test',
      ])
      remoteRun(server, linToken, [
        'contact',
        'add',
        '--name',
        'ByLin',
        '--email',
        'bl@p4.test',
      ])

      interface Row {
        action: string
        actor_name: string
      }
      const linOut = remoteRun(server, ownerToken, [
        'audit',
        'list',
        '--actor',
        'filter.lin',
        '--format',
        'json',
      ])
      expect(linOut.exitCode, linOut.stderr).toBe(0)
      const linRows = JSON.parse(linOut.stdout) as Row[]
      expect(linRows.length).toBeGreaterThan(0)
      expect(linRows.every((r) => r.actor_name === 'filter.lin')).toBe(true)

      const adminOut = remoteRun(server, ownerToken, [
        'audit',
        'list',
        '--actor',
        'admin',
        '--action',
        'contact.add',
        '--format',
        'json',
      ])
      expect(adminOut.exitCode, adminOut.stderr).toBe(0)
      const adminRows = JSON.parse(adminOut.stdout) as Row[]
      expect(adminRows.length).toBeGreaterThan(0)
      expect(adminRows.every((r) => r.actor_name === 'admin')).toBe(true)
    })
  }, 90_000)

  test('a forged actor param cannot misattribute a remote write', async () => {
    await withServer(async (server, ownerToken) => {
      const client = await connect(server.port, ownerToken)
      try {
        await client.call('contact.add', {
          name: 'Forged',
          email: ['forged@p4.test'],
          actor: 'mallory',
        })
      } finally {
        client.close()
      }
      // The write must be attributed to the authenticated caller, never to
      // the client-supplied actor — and the (now working) --actor filter
      // proves it: mallory owns no rows, admin owns the add.
      const forgedOut = remoteRun(server, ownerToken, [
        'audit',
        'list',
        '--actor',
        'mallory',
        '--format',
        'json',
      ])
      expect(forgedOut.exitCode, forgedOut.stderr).toBe(0)
      expect((JSON.parse(forgedOut.stdout) as unknown[]).length).toBe(0)

      const realOut = remoteRun(server, ownerToken, [
        'audit',
        'list',
        '--actor',
        'admin',
        '--action',
        'contact.add',
        '--format',
        'json',
      ])
      expect(realOut.exitCode, realOut.stderr).toBe(0)
      const realRows = JSON.parse(realOut.stdout) as Array<{
        after_json: string | null
      }>
      expect(
        realRows.some((r) => String(r.after_json).includes('Forged')),
      ).toBe(true)
    })
  }, 90_000)
})

// B4: the diff view. lib/diff is the shared renderer (CLI + tests);
// audit.get is the registry endpoint; the console renders its own JS
// mirror, so the console tests cover wiring + the server-side filters
describe('B4: audit diff view', () => {
  test('diffSnapshots: changed fields only, one-side-only fields included', () => {
    const before = JSON.stringify({ stage: 'open', value: 100, title: 'T' })
    const after = JSON.stringify({
      stage: 'won',
      value: 100,
      title: 'T',
      note: 'x',
    })
    const diffs = diffSnapshots(before, after)
    expect(diffs.map((d) => d.field).sort()).toEqual(['note', 'stage'])
    const stage = diffs.find((d) => d.field === 'stage')
    expect(stage?.before).toBe('open')
    expect(stage?.after).toBe('won')
  })

  test('diffSnapshots: row-level events (both snapshots absent) are not changes', () => {
    expect(diffSnapshots(null, null)).toEqual([])
    expect(diffSnapshots('', '')).toEqual([])
    expect(renderDiff(null, null)).toContain('row-level event')
    // a creation (before absent, after present) shows every added field
    const created = diffSnapshots(null, JSON.stringify({ a: 1 }))
    expect(created.map((d) => d.field)).toEqual(['a'])
    expect(created[0].before).toBe('—')
  })

  test('renderDiff prints a side-by-side table', () => {
    const out = renderDiff(
      JSON.stringify({ stage: 'open' }),
      JSON.stringify({ stage: 'won' }),
    )
    expect(out).toContain('stage')
    expect(out).toContain('open')
    expect(out).toContain('won')
    expect(out).not.toContain('unchanged')
  })

  test('audit.get returns the row; bad seq is NOT_FOUND', async () => {
    const { dbPath, cleanup } = freshDb()
    const server: TestServer = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const admin = await connect(server.port, owner.token)
      const created = await admin.call<{ id: string }>('contact.add', {
        name: 'Diff Corp',
      })
      await admin.call('contact.edit', {
        ref: created.id,
        name: 'Diff Corp Renamed',
      })
      const list = await admin.call<{ rows: { seq: number }[] }>('audit.list', {
        limit: 5,
      })
      const updateRow = list.rows.find((r) => r.seq > 0)
      expect(updateRow).toBeDefined()
      const got = await admin.call<{ row: { seq: number; action: string } }>(
        'audit.get',
        { seq: updateRow!.seq },
      )
      expect(got.row.seq).toBe(updateRow!.seq)
      expect(typeof got.row.action).toBe('string')
      await expect(admin.call('audit.get', { seq: 999_999 })).rejects.toThrow(
        /not found/,
      )
    } finally {
      await server.close()
      cleanup()
    }
  }, 60_000)

  test('CLI: crm audit show <seq> --diff prints the field table', async () => {
    const { dbPath, cleanup } = freshDb()
    const server: TestServer = await startServer(dbPath)
    try {
      const owner = await bootstrapOwner(server)
      const admin = await connect(server.port, owner.token)
      const created = await admin.call<{ id: string }>('contact.add', {
        name: 'Show Corp',
      })
      await admin.call('contact.edit', {
        ref: created.id,
        name: 'Show Corp V2',
      })
      const list = await admin.call<{
        rows: { seq: number; action: string }[]
      }>('audit.list', { action: 'contact.edit', limit: 5 })
      const row = list.rows.find((r) => r.action === 'contact.edit')
      expect(row).toBeDefined()
      const out = remoteRun(server, owner.token, [
        'audit',
        'show',
        String(row!.seq),
        '--diff',
      ])
      expect(out.exitCode, out.stderr).toBe(0)
      expect(out.stdout).toContain('before')
      expect(out.stdout).toContain('after')
      expect(out.stdout).toContain('Show Corp V2')
      expect(out.stdout).not.toContain('Show Corp\n')
    } finally {
      await server.close()
      cleanup()
    }
  }, 60_000)
})
