import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { credentialsPath, ensurePrivateDir } from './paths'

/** Saved server session: { server, username, token } at ~/.crm/credentials (0600). */
export interface Session {
  server: string
  token: string
  username: string
}

export function loadSession(): Session | null {
  try {
    const raw = readFileSync(credentialsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Session>
    if (typeof parsed.server === 'string' && typeof parsed.token === 'string') {
      return {
        server: parsed.server,
        username: typeof parsed.username === 'string' ? parsed.username : '',
        token: parsed.token,
      }
    }
    return null
  } catch {
    return null
  }
}

export function saveSession(creds: Session): void {
  const path = credentialsPath()
  ensurePrivateDir(dirname(path))
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 })
}

export function clearSession(): boolean {
  const path = credentialsPath()
  if (!existsSync(path)) {
    return false
  }
  unlinkSync(path)
  return true
}

/**
 * host:port from a flag > CRM_SERVER env > saved session.
 * Returns { host: '', port: 0 } when nothing is configured or the value is
 * malformed — callers must check and die with a helpful message.
 */
export function resolveServerAddr(flag?: string): {
  host: string
  port: number
} {
  const raw = flag ?? process.env.CRM_SERVER ?? loadSession()?.server ?? ''
  if (!raw) {
    return { host: '', port: 0 }
  }
  const [host, portStr] = raw.split(':')
  const port = portStr ? Number(portStr) : 8443
  if (!host || Number.isNaN(port)) {
    return { host: '', port: 0 }
  }
  return { host, port }
}
