import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { slugify } from '../fuse-json'

/**
 * Private state for mount infrastructure (daemon sockets, mount PID files).
 *
 * These live under ~/.crm instead of tmpdir(): on Linux tmpdir() is the
 * world-accessible /tmp, where another local user could replace the daemon
 * socket (it serves unauthenticated JSON) or poison the PID file that
 * guards against double mounts. ~/.crm is owned by the invoking user.
 */
export const socketsDir = join(homedir(), '.crm', 'sockets')
export const mountsDir = join(homedir(), '.crm', 'mounts')

/** Directory for the server's TLS material (~/.crm/certs, 0700). */
export const certsDir = join(homedir(), '.crm', 'certs')

/**
 * Saved server credentials (~/.crm/credentials, 0600).
 * Written by `crm login`: { server, username, token }.
 */
export function credentialsPath(): string {
  return join(homedir(), '.crm', 'credentials')
}

export function socketPathFor(mountPoint: string): string {
  return join(socketsDir, `crm-fuse-${slugify(mountPoint)}.sock`)
}

export function pidFileFor(mountPoint: string): string {
  return join(mountsDir, `crm-mount-${slugify(mountPoint)}.pid`)
}

/**
 * Create a directory and enforce 0700. mkdirSync's mode argument is masked
 * by the process umask, so a follow-up chmod guarantees the mode.
 */
export function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  try {
    chmodSync(dir, 0o700)
  } catch {
    // best effort — the parent (~/.crm) is still user-owned
  }
}
