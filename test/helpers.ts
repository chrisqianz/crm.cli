import {
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Whether the current platform supports FUSE/NFS mount tests */
export const canMount = existsSync('/dev/fuse') // Linux FUSE only — macOS NFS mount causes kernel panics, skip for now

const CRM_BIN = join(import.meta.dir, '..', 'src', 'cli.ts')

/** Every path under `dir` that looks like crm state; bun's own cache is
 * excluded because it is the runtime, not the product.
 *
 * Scope of the promise: the A3 whitelist allows `~/.crm/config.toml` (plus the
 * `~/.crm` runtime dir: credentials, sockets, bin) and the caches by
 * construction, so `~/.crm` itself is deliberately outside this walk — which is
 * why the spec's literal `find $HOME -name '*crm*'` can never be the assertion.
 * What this walk enforces is the enforceable subset: no *crm/db-named* artifact
 * appears anywhere under $HOME that the run did not address explicitly.
 */
export function leaked(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (p.includes('/Library/Caches')) {
        continue
      }
      if (e.isDirectory() && !e.isSymbolicLink()) {
        walk(p)
      } else if (/crm|\.db/i.test(e.name)) {
        out.push(p)
      }
    }
  }
  if (statSync(dir, { throwIfNoEntry: false })) {
    walk(dir)
  }
  return out
}

const TEST_CONFIG = `[phone]
default_country = "US"
display = "national"

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"
`

export interface RunResult {
  exitCode: number
  stderr: string
  stdout: string
}

export function createTestContext(opts?: { noConfig?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'crm-test-'))
  const dbPath = join(dir, 'test.db')
  const configPath = join(dir, 'config.toml')
  if (!opts?.noConfig) {
    writeFileSync(configPath, TEST_CONFIG)
  }
  const baseEnv = opts?.noConfig
    ? { ...process.env, NO_COLOR: '1' }
    : { ...process.env, NO_COLOR: '1', CRM_CONFIG: configPath }

  /**
   * Remote mode: when CRM_TEST_REMOTE_SERVER is set (host:port) the CLI runs
   * in thin-client mode against that server instead of the local db file.
   * CRM_TEST_REMOTE_TOKEN carries the bearer token. This lets the same
   * scenario tests exercise local and remote modes interchangeably.
   */
  const remoteServer = process.env.CRM_TEST_REMOTE_SERVER
  const remoteToken = process.env.CRM_TEST_REMOTE_TOKEN ?? ''
  function run(...args: string[]): RunResult {
    const proc = remoteServer
      ? Bun.spawnSync(['bun', 'run', CRM_BIN, ...args], {
          cwd: dir,
          env: {
            ...baseEnv,
            CRM_SERVER: remoteServer,
            CRM_TOKEN: remoteToken,
            CRM_INSECURE: '1',
          },
        })
      : Bun.spawnSync(['bun', 'run', CRM_BIN, '--db', dbPath, ...args], {
          cwd: dir,
          env: baseEnv,
        })
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    }
  }

  function runOK(...args: string[]): string {
    const result = run(...args)
    if (result.exitCode !== 0) {
      throw new Error(
        `crm ${args.join(' ')} failed (exit ${result.exitCode}):\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
      )
    }
    return result.stdout
  }

  function runFail(...args: string[]): RunResult {
    const result = run(...args)
    if (result.exitCode === 0) {
      throw new Error(
        `expected crm ${args.join(' ')} to fail, but it succeeded:\nstdout: ${result.stdout}`,
      )
    }
    return result
  }

  function runJSON<T = unknown>(...args: string[]): T {
    const out = runOK(...args)
    return JSON.parse(out) as T
  }

  function runWithEnv(
    env: Record<string, string>,
    ...args: string[]
  ): RunResult {
    const proc = remoteServer
      ? Bun.spawnSync(['bun', 'run', CRM_BIN, ...args], {
          cwd: dir,
          env: {
            ...baseEnv,
            ...env,
            CRM_SERVER: remoteServer,
            CRM_TOKEN: remoteToken,
            CRM_INSECURE: '1',
          },
        })
      : Bun.spawnSync(['bun', 'run', CRM_BIN, '--db', dbPath, ...args], {
          cwd: dir,
          env: { ...baseEnv, ...env },
        })
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    }
  }

  return { dir, dbPath, configPath, run, runOK, runFail, runJSON, runWithEnv }
}

export type TestContext = ReturnType<typeof createTestContext>
