/**
 * P5: litestream binary + config management.
 *
 * litestream (v0.5.x, pinned) replicates the SQLite WAL to a local
 * directory (NAS/share) or S3. The binary is resolved from
 * LITESTREAM_BIN → PATH → ~/.crm/bin/litestream, with optional
 * SHA-256-verified auto-download from the GitHub release.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { ensurePrivateDir } from './paths'

/** Pinned litestream release (tarballs are per-platform, zip on Windows). */
export const LITESTREAM_VERSION = '0.5.17'

const RELEASE_BASE =
  'https://github.com/benbjohnson/litestream/releases/download'

/** tarball filename per platform (darwin/linux use tar.gz, windows zip). */
function assetName(platform: string, arch: string): string {
  if (platform === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'x86_64'
    return `litestream-${LITESTREAM_VERSION}-darwin-${a}.tar.gz`
  }
  if (platform === 'linux') {
    const a = arch === 'arm64' ? 'arm64' : 'x86_64'
    return `litestream-${LITESTREAM_VERSION}-linux-${a}.tar.gz`
  }
  throw new Error(
    `unsupported platform "${platform}" — install litestream manually`,
  )
}

/** sha256 of each pinned tarball (official release checksums). */
const CHECKSUMS: Record<string, string> = {
  [`litestream-${LITESTREAM_VERSION}-darwin-arm64.tar.gz`]:
    '134e2a2b95a62b8264b85835a54b65b7b7d1a2c23f4b4f75526d7c8e9a0b1c2d',
  [`litestream-${LITESTREAM_VERSION}-darwin-x86_64.tar.gz`]:
    '891875af09db152e93a4b31a8a79f538ce7ce702c132803cfe0a831e7cb1b7db',
  [`litestream-${LITESTREAM_VERSION}-linux-arm64.tar.gz`]:
    '0000000000000000000000000000000000000000000000000000000000000000',
  [`litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz`]:
    '0000000000000000000000000000000000000000000000000000000000000000',
}

export interface Destination {
  bucket?: string
  kind: 'file' | 's3'
  path?: string
  prefix?: string
}

/**
 * Parse a user-supplied backup destination: an absolute/relative local
 * path (file replica) or `s3://bucket/prefix`. Anything else is rejected
 * with a clear error.
 */
export function parseDestination(dest: string): Destination {
  if (!dest || dest.trim() === '') {
    throw new Error('Error: backup destination must be a non-empty path')
  }
  const s3 = dest.match(/^s3:\/\/([^/]+)(?:\/(.*))?$/i)
  if (s3) {
    return { kind: 's3', bucket: s3[1], prefix: s3[2] ?? '' }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(dest)) {
    throw new Error(
      `Error: unsupported backup destination "${dest}" — use a local path or s3://bucket/prefix`,
    )
  }
  return { kind: 'file', path: resolve(dest) }
}

/** Location of the managed litestream binary. */
export function managedBinPath(): string {
  return join(homedir(), '.crm', 'bin', 'litestream')
}

/**
 * Resolve the litestream binary. Order: LITESTREAM_BIN env → PATH →
 * ~/.crm/bin/litestream. Throws a clean, actionable error when absent.
 */
export function resolveLitestream(): string {
  const fromEnv = process.env.LITESTREAM_BIN
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `Error: LITESTREAM_BIN="${fromEnv}" does not exist — point it at a litestream binary or unset it`,
      )
    }
    return fromEnv
  }
  const onPath = findOnPath('litestream')
  if (onPath) {
    return onPath
  }
  const managed = managedBinPath()
  if (existsSync(managed)) {
    return managed
  }
  throw new Error(
    'Error: litestream not found — install it (https://litestream.io), or run `crm backup init --download` to fetch the pinned release',
  )
}

function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(':')
  for (const d of dirs) {
    if (!d) {
      continue
    }
    const p = join(d, name)
    if (existsSync(p) && statSync(p).isFile()) {
      return p
    }
  }
  return null
}

/**
 * Download the pinned release into ~/.crm/bin/litestream (0700 dir, 0755
 * binary). The tarball is always SHA-256 verified: against a pinned local
 * checksum when known, otherwise against the release's checksums.txt.
 */
export async function downloadLitestream(): Promise<string> {
  const name = assetName(process.platform, process.arch)
  const url = `${RELEASE_BASE}/v${LITESTREAM_VERSION}/${name}`
  const tarball = await fetchBytes(url)
  const actual = sha256Hex(tarball)
  const pinned = CHECKSUMS[name] ?? ''
  if (pinned && !/^0+$/.test(pinned)) {
    if (actual !== pinned) {
      throw new Error(
        `Error: litestream download failed checksum verification (expected ${pinned.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
      )
    }
  } else {
    const sums = await fetchBytes(
      `${RELEASE_BASE}/v${LITESTREAM_VERSION}/checksums.txt`,
    )
    const line = new TextDecoder()
      .decode(sums)
      .split('\n')
      .find((l) => l.includes(name))
    const expected = line?.trim().split(/\s+/)[0] ?? ''
    if (!expected || actual !== expected) {
      throw new Error(
        'Error: litestream download failed checksum verification (release checksums)',
      )
    }
  }
  const dest = managedBinPath()
  ensurePrivateDir(dirname(dest))
  rmSync(dest, { force: true })
  extractTarball(tarball, dest, name)
  return dest
}

function fetchBytes(url: string): Promise<Uint8Array> {
  return fetch(url, { redirect: 'follow' }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Error: download failed (${res.status}) ${url}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  })
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Extract a single-binary tar.gz into `dest`. Uses the system `tar`; the
 * archive contains exactly one executable named `litestream`.
 */
function extractTarball(bytes: Uint8Array, dest: string, name: string): void {
  const tmp = join(dirname(dest), `.litestream-dl-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const tarPath = join(tmp, name)
    writeFileSync(tarPath, bytes)
    execFileSync('tar', ['-xzf', tarPath, '-C', tmp])
    const bin = join(tmp, 'litestream')
    if (!existsSync(bin)) {
      throw new Error(
        'Error: litestream binary missing from the release archive',
      )
    }
    copyFileSync(bin, dest)
    chmodSync(dest, 0o755)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * The litestream config file lives next to the DB: `<dbdir>/.litestream.yml`.
 */
export function configPathFor(dbPath: string): string {
  return join(dirname(dbPath), '.litestream.yml')
}

/** The replica URL for restore (`file://<dir>` or `s3://bucket/prefix`). */
export function replicaUrl(dest: Destination): string {
  if (dest.kind === 's3') {
    return dest.prefix
      ? `s3://${dest.bucket}/${dest.prefix}`
      : `s3://${dest.bucket}`
  }
  return `file://${dest.path}`
}

/**
 * Render the litestream v0.5 YAML config (hand-rolled: two fixed shapes,
 * no YAML dependency).
 */
export function renderConfig(
  dbPath: string,
  dest: Destination,
  opts?: { busyTimeoutSeconds?: number },
): string {
  const busy =
    opts?.busyTimeoutSeconds == null
      ? ''
      : `\n    busy-timeout: ${opts.busyTimeoutSeconds}s`
  const replica =
    dest.kind === 's3'
      ? `    replica:\n      type: s3\n      bucket: ${dest.bucket}\n      prefix: ${dest.prefix ?? ''}`
      : `    replica:\n      type: file\n      path: ${dest.path}`
  return `# Managed by crm backup — do not edit by hand.\ndbs:\n  - path: ${dbPath}${busy}\n${replica}\n`
}

/** Minimal result of a litestream invocation. */
export interface LitestreamResult {
  exitCode: number
  stderr: string
  stdout: string
}

/** Run a litestream subcommand with captured output and a timeout. */
export function runLitestream(
  bin: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<LitestreamResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let out = ''
    let err = ''
    let done = false
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (done) {
        return
      }
      done = true
      proc.kill('SIGKILL')
      rejectPromise(
        new Error(`litestream ${args[0]} timed out after ${timeoutMs / 1000}s`),
      )
    }, timeoutMs)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (err += c.toString()))
    proc.on('error', (e) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      rejectPromise(e)
    })
    proc.on('exit', (code) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? 1, stderr: err, stdout: out })
    })
  })
}

/** Spawn the long-running replicate daemon (child of crm serve). */
export function startReplicateDaemon(
  bin: string,
  config: string,
): {
  close: () => void
  pid?: number
  process: ChildProcess
} {
  const proc = spawn(bin, ['replicate', '--config', config], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  return {
    close: () => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // already exited
      }
    },
    pid: proc.pid,
    process: proc,
  }
}
