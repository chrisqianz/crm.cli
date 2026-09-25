import { createHash, randomBytes } from 'node:crypto'

import { hash, verify } from '@node-rs/argon2'

// Password hashing is argon2id (the default algorithm of @node-rs/argon2)
// with the OWASP 2024 recommendation (m=19456 KiB, t=2, p=1).

export function hashPassword(password: string): Promise<string> {
  return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 })
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(hash, password)
  } catch {
    return false
  }
}

/** One-time initial password: 22 base64url chars (~132 bits of entropy). */
export function generatePassword(): string {
  return randomBytes(16).toString('base64url')
}

/** Bearer token. The raw value is shown exactly once; only hashToken() is stored. */
export function generateToken(): string {
  return `crm_${randomBytes(32).toString('base64url')}`
}

/** One-time bootstrap code, printed by `crm serve` when users is empty. */
export function generateBootstrapCode(): string {
  return `crm-bootstrap-${randomBytes(16).toString('base64url')}`
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
