import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@libsql/client'

import {
  bootstrapOwner,
  CRM,
  connect,
  freshDb,
  REPO,
  startServer,
} from './helpers'

function workDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'crm-p5-backup-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function cli(
  args: string[],
  env?: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'run', CRM, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CRM_CONFIG: '/dev/null',
      ...(env ?? {}),
    },
  })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

function ltxCount(replicaDir: string): number {
  const base = join(replicaDir, 'ltx')
  if (!existsSync(base)) {
    return 0
  }
  let n = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.ltx')) {
        n++
      }
    }
  }
  walk(base)
  return n
}

function countRows(dbPath: string, table: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = createClient({ url: `file:${dbPath}` })
    client
      .execute(`SELECT COUNT(*) AS n FROM ${table}`)
      .then((r) => {
        const n = Number(String((r.rows[0] as Record<string, unknown>).n))
        client.close()
        resolve(n)
      })
      .catch((e) => {
        client.close()
        reject(e)
      })
  })
}

describe('P5 backup: litestream backup + restore', () => {
  test('init registers the DB and takes a first snapshot', async () => {
    const { dbPath, cleanup } = freshDb()
    const { dir, cleanup: wdCleanup } = workDir()
    try {
      cli([
        '--db',
        dbPath,
        'contact',
        'add',
        '--name',
        'A',
        '--email',
        'a@p5.test',
      ])
      const out = cli(['--db', dbPath, 'backup', 'init', '--destination', dir])
      expect(out.exitCode, out.stderr).toBe(0)
      // LTX files materialized in the replica
      expect(ltxCount(dir)).toBeGreaterThan(0)
      // status reports the DB as ok
      const st = cli(['--db', dbPath, 'backup', 'status'])
      expect(st.exitCode, st.stderr).toBe(0)
      expect(st.stdout).toContain(dbPath)
      // init wrote an audit row
      const audit = await countRows(dbPath, 'audit_log')
      expect(audit).toBeGreaterThan(0)
    } finally {
      cleanup()
      wdCleanup()
    }
  }, 90_000)

  test('sync replicates new writes (txid advances)', () => {
    const { dbPath, cleanup } = freshDb()
    const { dir, cleanup: wdCleanup } = workDir()
    try {
      cli(['--db', dbPath, 'backup', 'init', '--destination', dir])
      const before = ltxCount(dir)
      cli([
        '--db',
        dbPath,
        'contact',
        'add',
        '--name',
        'B',
        '--email',
        'b@p5.test',
      ])
      const out = cli(['--db', dbPath, 'backup', 'sync'])
      expect(out.exitCode, out.stderr).toBe(0)
      expect(ltxCount(dir)).toBeGreaterThan(before)
    } finally {
      cleanup()
      wdCleanup()
    }
  }, 90_000)

  test('restore: kill server → restore from replica → audit verify passes', async () => {
    const { dbPath, cleanup } = freshDb()
    const { dir, cleanup: wdCleanup } = workDir()
    try {
      // live server, real remote writes
      const server = await startServer(dbPath)
      const owner = await bootstrapOwner(server)
      const client = await connect(server.port, owner.token)
      await client.call('contact.add', { name: 'R1', email: ['r1@p5.test'] })
      await client.call('contact.add', { name: 'R2', email: ['r2@p5.test'] })
      await client.call('company.add', {
        name: 'RCo',
        website: ['rco.p5.test'],
      })
      client.close()
      cli(['--db', dbPath, 'backup', 'init', '--destination', dir])
      await server.close() // kill the server

      const liveContacts = await countRows(dbPath, 'contacts')
      expect(liveContacts).toBe(2)

      // restore to a fresh file
      const restored = join(dir, 'restored.db')
      const out = cli(['--db', dbPath, 'backup', 'restore', '--to', restored])
      expect(out.exitCode, out.stderr).toBe(0)
      expect(existsSync(restored)).toBe(true)

      // exit criterion: audit verify passes on the restored file
      const verify = cli(['--db', restored, 'audit', 'verify'])
      expect(verify.exitCode, verify.stdout + verify.stderr).toBe(0)
      expect(verify.stdout).toContain('OK: audit chain intact')

      // data is complete
      expect(await countRows(restored, 'contacts')).toBe(liveContacts)
      expect(await countRows(restored, 'companies')).toBe(1)

      // restore refuses to overwrite an existing file (CONFLICT → exit 3)
      const again = cli(['--db', dbPath, 'backup', 'restore', '--to', restored])
      expect(again.exitCode).toBe(3)
      expect(again.stderr).toMatch(/exists/i)
    } finally {
      cleanup()
      wdCleanup()
    }
  }, 120_000)

  test('check: restore to temp, verify chain, compare row counts', () => {
    const { dbPath, cleanup } = freshDb()
    const { dir, cleanup: wdCleanup } = workDir()
    try {
      cli(['--db', dbPath, 'backup', 'init', '--destination', dir])
      cli([
        '--db',
        dbPath,
        'contact',
        'add',
        '--name',
        'C',
        '--email',
        'c@p5.test',
      ])
      cli(['--db', dbPath, 'backup', 'sync'])
      const out = cli(['--db', dbPath, 'backup', 'check'])
      expect(out.exitCode, out.stderr).toBe(0)
      expect(out.stdout).toContain('OK')
    } finally {
      cleanup()
      wdCleanup()
    }
  }, 90_000)

  test('missing binary → clean error with install guidance', () => {
    const { dbPath, cleanup } = freshDb()
    const { dir, cleanup: wdCleanup } = workDir()
    try {
      const out = cli(
        [
          '--db',
          dbPath,
          'backup',
          'init',
          '--destination',
          join(dir, 'replica'),
        ],
        { LITESTREAM_BIN: '/nonexistent/litestream' },
      )
      expect(out.exitCode).toBe(1)
      expect(out.stderr).toMatch(/litestream/i)
      expect(out.stderr).toMatch(/LITESTREAM_BIN|install|download/)
    } finally {
      cleanup()
      wdCleanup()
    }
  }, 30_000)

  test('invalid destination → clean error before anything is written', () => {
    const { dbPath, cleanup } = freshDb()
    try {
      const out = cli([
        '--db',
        dbPath,
        'backup',
        'init',
        '--destination',
        'gs://bucket/x',
      ])
      expect(out.exitCode).toBe(1)
      expect(out.stderr).toMatch(/local path or s3:/)
    } finally {
      cleanup()
    }
  }, 30_000)

  test('serve with [backup] destination spawns continuous replication', async () => {
    const { dbPath, cleanup } = freshDb()
    const { dir, cleanup: wdCleanup } = workDir()
    try {
      const configPath = join(dir, 'server.toml')
      await Bun.write(
        configPath,
        `[database]\npath = "${dbPath}"\n\n[backup]\ndestination = "${dir}"\n`,
      )
      // startServer takes an optional config path
      const server = await startServer(dbPath, { configPath })
      try {
        const owner = await bootstrapOwner(server)
        const client = await connect(server.port, owner.token)
        await client.call('contact.add', { name: 'D', email: ['d@p5.test'] })
        client.close()
        // the daemon child must replicate within its sync interval (~5s)
        let n = 0
        for (let i = 0; i < 30; i++) {
          n = ltxCount(dir)
          if (n > 0) {
            break
          }
          await Bun.sleep(1000)
        }
        expect(n).toBeGreaterThan(0)
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
      wdCleanup()
    }
  }, 120_000)

  test('remote client: status/sync via RPC; init/restore rejected', async () => {
    const { dbPath, cleanup } = freshDb()
    const { dir, cleanup: wdCleanup } = workDir()
    try {
      const server = await startServer(dbPath)
      try {
        const owner = await bootstrapOwner(server)
        // configure the replica on the server host first (local CLI)
        const replica = join(dir, 'replica')
        const localInit = cli([
          '--db',
          dbPath,
          'backup',
          'init',
          '--destination',
          replica,
        ])
        expect(localInit.exitCode, localInit.stderr).toBe(0)
        const remote = (args: string[]) =>
          cli(args, {
            CRM_SERVER: `127.0.0.1:${server.port}`,
            CRM_TOKEN: owner.token,
            CRM_INSECURE: '1',
          })
        // admin RPC: status works remotely
        const status = remote(['backup', 'status'])
        expect(status.exitCode, status.stderr).toBe(0)
        expect(status.stdout).toContain(dbPath)
        // sync works remotely (admin)
        const sync = remote(['backup', 'sync'])
        expect(sync.exitCode, sync.stderr).toBe(0)
        // init/restore are server-host-only
        const remoteInit = remote([
          'backup',
          'init',
          '--destination',
          '/tmp/p5-not-here',
        ])
        expect(remoteInit.exitCode).toBe(1)
        expect(remoteInit.stderr).toMatch(/server host/)
        const restore = remote(['backup', 'restore', '--to', '/tmp/p5-x.db'])
        expect(restore.exitCode).toBe(1)
        expect(restore.stderr).toMatch(/server host/)
      } finally {
        await server.close()
      }
    } finally {
      cleanup()
      wdCleanup()
    }
  }, 90_000)
})
