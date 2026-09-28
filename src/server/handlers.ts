import { eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { CRMConfig } from '../config'
import type { DB } from '../db'
import type { User } from '../drizzle-schema'
import * as schema from '../drizzle-schema'
import { auditMeta, auditSnapshot, recordAudit } from '../lib/audit'
import { ServiceError } from '../lib/errors'
import {
  AmbiguousIdentityError,
  type LdapDirectory,
  type LdapUser,
  openDirectory,
  roleForGroups,
} from '../lib/ldap'
import {
  generatePassword,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../lib/secrets'
import { METHODS, roleAllows } from '../service/registry'

// ── Protocol error (spec/enterprise.md §Error model) ──

export class ServerError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface Identity {
  id: string
  role: string
  username: string
}

const VALID_ROLES = ['owner', 'admin', 'writer', 'reader'] as const
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/

export function isPrivileged(identity: Identity): boolean {
  return identity.role === 'owner' || identity.role === 'admin'
}

function publicUser(u: User): {
  id: string
  username: string
  display_name: string | null
  email: string | null
  role: string
  created_at: string
} {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
  }
}

function strParam(params: Record<string, unknown>, name: string): string {
  const v = params[name]
  if (typeof v !== 'string' || v.length === 0) {
    throw new ServerError('INVALID', `missing or invalid parameter "${name}"`)
  }
  return v
}

// ── Audit ──

// ── Audit: see src/lib/audit.ts (hash chain, shared by local/remote/fuse) ──

// ── Lookups ──

async function findUser(db: DB, username: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.username}) = lower(${username})`)
    .limit(5)
  if (rows.length === 0) {
    return null
  }
  // a database created before the case-insensitive index may hold rows
  // differing only by case: prefer the disabled one, so a leftover
  // duplicate can never be the row that authenticates
  return rows.find((r) => r.disabled_at) ?? rows[0]
}

async function findUserById(db: DB, id: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
  return rows[0] ?? null
}

async function userCount(db: DB): Promise<number> {
  const rows = await db.select({ id: schema.users.id }).from(schema.users)
  return rows.length
}

// ── Auth methods (first frame on the connection) ──

export interface AuthResult {
  identity: Identity
  result: Record<string, unknown>
}

export function handleAuth(
  db: DB,
  config: CRMConfig,
  ctx: { bootstrapCode: string | null; ip: string },
  method: string,
  params: Record<string, unknown>,
): Promise<AuthResult> {
  if (method === 'auth.login') {
    return authLogin(db, config, ctx, params)
  }
  if (method === 'auth.token') {
    return authToken(db, params)
  }
  if (method === 'auth.bootstrap') {
    return authBootstrap(db, config, ctx, params)
  }
  throw new ServerError('AUTH', 'first frame must be an auth method')
}

/**
 * Service-account lookup, with the two directory-side failures named as
 * themselves. Both end the login: an unreachable directory has no
 * fallback by design, and an ambiguous match must not be settled by
 * taking whoever the directory happened to return first.
 */
async function lookupDirectoryUser(
  db: DB,
  ctx: { ip: string },
  dir: LdapDirectory,
  username: string,
): Promise<LdapUser | null> {
  try {
    return await dir.lookupUser(username)
  } catch (e) {
    const ambiguous = e instanceof AmbiguousIdentityError
    await recordAudit(db, {
      actor_id: '',
      actor_name: username,
      action: 'auth.login-failed',
      source: 'rpc',
      ip: ctx.ip,
      after_json: JSON.stringify({
        reason: ambiguous ? 'ambiguous-identity' : 'ldap-unreachable',
        username,
      }),
    }).catch(() => undefined)
    throw new ServerError(
      'AUTH',
      ambiguous
        ? 'that username is ambiguous in the directory — contact an administrator'
        : 'directory is unreachable — login is unavailable until it is back',
    )
  }
}

// ── Identity and login throttling ──

/**
 * CRM identities are stored lowercase. The directory matches names
 * case-insensitively (LDAP `caseIgnoreMatch`), SQLite's UNIQUE does not,
 * and humans type `Alice` — normalizing at every entry point stops those
 * three from agreeing on different rows.
 */
function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Sliding-window login counters, per process. Directory-backed logins
 * never touch the CRM lockout counters (the directory owns that policy),
 * so without this the server would forward an unbounded brute-force rate
 * at the corporate directory — which is how a company gets locked out.
 * Attempts are counted, not failures, so this doubles as no oracle: the
 * reply is identical whichever username was tried.
 */
const loginAttempts = new Map<string, number[]>()
const ATTEMPT_WINDOW_MS = 60_000
const MAX_TRACKED_KEYS = 10_000

function rateValue(configured: number, fallback: number): number {
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback
}

function allowAttempt(key: string, limit: number): boolean {
  if (limit <= 0) {
    return true
  }
  const now = Date.now()
  const recent = (loginAttempts.get(key) ?? []).filter(
    (t) => now - t < ATTEMPT_WINDOW_MS,
  )
  if (recent.length >= limit) {
    loginAttempts.set(key, recent)
    return false
  }
  recent.push(now)
  loginAttempts.set(key, recent)
  if (loginAttempts.size > MAX_TRACKED_KEYS) {
    // keys come from the network: spoofed IPs must be able to grow this
    // map without bound, so stale ones are dropped when it gets large
    for (const [k, times] of loginAttempts) {
      const last = times.at(-1) ?? 0
      if (times.length === 0 || now - last >= ATTEMPT_WINDOW_MS) {
        loginAttempts.delete(k)
      }
    }
  }
  return true
}

async function consumeLoginAttempt(
  db: DB,
  config: CRMConfig,
  ctx: { ip: string },
  username: string,
): Promise<void> {
  const ipLimit = rateValue(config.auth.login_rate_per_minute, 60)
  const userLimit = rateValue(config.auth.login_user_rate_per_minute, 15)
  const allowed =
    allowAttempt(`ip:${ctx.ip}`, ipLimit) &&
    allowAttempt(`u:${ctx.ip}|${username}`, userLimit)
  if (allowed) {
    return
  }
  await recordAudit(db, {
    actor_id: '',
    actor_name: username,
    action: 'auth.rate-limited',
    source: 'rpc',
    ip: ctx.ip,
    after_json: JSON.stringify({ ip_limit: ipLimit, user_limit: userLimit }),
  }).catch(() => undefined)
  throw new ServerError('AUTH', 'too many login attempts — try again later')
}

async function authLogin(
  db: DB,
  config: CRMConfig,
  ctx: { bootstrapCode: string | null; ip: string },
  params: Record<string, unknown>,
): Promise<AuthResult> {
  const username = normalizeUsername(strParam(params, 'username'))
  const password = strParam(params, 'password')
  await consumeLoginAttempt(db, config, ctx, username)

  // P6: when the directory is configured it wins for usernames that
  // resolve in it — including a same-named local account. A directory
  // outage is a hard AUTH error (no silent fallback to local passwords).
  if (config.ldap.enabled) {
    const dir = openDirectory(config)
    try {
      const entry = await lookupDirectoryUser(db, ctx, dir, username)
      if (entry) {
        // Deliberately outside lookupDirectoryUser's error handling: a
        // failed *login* (bad password, disabled account) says something
        // different from an unreachable directory and must not be
        // reported as one.
        return await directoryLogin(
          db,
          config,
          ctx,
          dir,
          username,
          password,
          entry,
        )
      }
    } finally {
      await dir.close()
    }
  }

  const u = await findUser(db, username)

  const fail = async (
    reason: string,
    actor: User | null,
    message?: string,
  ): Promise<never> => {
    await recordAudit(db, {
      actor_id: actor?.id ?? '',
      actor_name: username,
      action: 'auth.login-failed',
      source: 'rpc',
      ip: ctx.ip,
      after_json: JSON.stringify({ reason, username }),
    })
    throw new ServerError('AUTH', message ?? 'invalid credentials')
  }

  if (!u) {
    return fail('unknown-user', null)
  }
  if (u.disabled_at) {
    return fail('disabled', u, 'account is disabled')
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return fail('locked', u, 'account is locked, try again later')
  }
  if (!(u.password_hash && (await verifyPassword(u.password_hash, password)))) {
    const attempts = (u.failed_attempts ?? 0) + 1
    if (attempts >= config.auth.lockout_threshold) {
      await db
        .update(schema.users)
        .set({
          failed_attempts: 0,
          locked_until: new Date(
            Date.now() + config.auth.lockout_minutes * 60_000,
          ).toISOString(),
        })
        .where(eq(schema.users.id, u.id))
      await recordAudit(db, {
        actor_id: u.id,
        actor_name: u.username,
        action: 'auth.locked',
        source: 'rpc',
        ip: ctx.ip,
        entity_type: 'user',
        entity_id: u.id,
        after_json: JSON.stringify({
          username: u.username,
          locked_for_minutes: config.auth.lockout_minutes,
        }),
      })
    } else {
      await db
        .update(schema.users)
        .set({ failed_attempts: attempts })
        .where(eq(schema.users.id, u.id))
    }
    return fail(
      attempts >= config.auth.lockout_threshold
        ? 'locked-engaged'
        : 'bad-password',
      u,
    )
  }

  // Success: clear counters, issue a session token
  await db
    .update(schema.users)
    .set({ failed_attempts: 0, locked_until: null })
    .where(eq(schema.users.id, u.id))
  await recordAudit(db, {
    actor_id: u.id,
    actor_name: u.username,
    action: 'auth.login',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'user',
    entity_id: u.id,
  })
  const token = await issueToken(db, u.id, `session-${ulid()}`, null)
  return {
    identity: { id: u.id, username: u.username, role: u.role },
    result: { token, user: publicUser(u) },
  }
}

/**
 * P6: directory login — two-step bind, JIT provisioning, group→role.
 * A wrong password is a plain AUTH error (no lockout accounting: the
 * directory owns its own lockout policy; once the JIT row exists the
 * standard lockout applies to local-mode writes, not to this path).
 */
async function directoryLogin(
  db: DB,
  config: CRMConfig,
  ctx: { bootstrapCode: string | null; ip: string },
  dir: LdapDirectory,
  username: string,
  password: string,
  entry: LdapUser,
): Promise<AuthResult> {
  // The directory's own id is the identity, normalized: a filter on mail
  // (or anything else) must not provision a CRM user under whatever the
  // caller typed, and case variants must land on one row.
  const identity = normalizeUsername(entry.username || username)
  const ok = await dir.verifyPassword(entry.dn, password)
  if (!ok) {
    await recordAudit(db, {
      actor_id: '',
      actor_name: identity,
      action: 'auth.login-failed',
      source: 'rpc',
      ip: ctx.ip,
      after_json: JSON.stringify({
        reason: 'directory-bad-password',
        username: identity,
      }),
    }).catch(() => undefined)
    throw new ServerError('AUTH', 'invalid credentials')
  }

  const existing = await findUser(db, identity)
  // disabled_at is enforced locally even for directory users (incident
  // response without touching the directory). Audited, or the most
  // security-relevant rejection in the whole flow is invisible.
  if (existing?.disabled_at) {
    await recordAudit(db, {
      actor_id: existing.id,
      actor_name: existing.username,
      action: 'auth.login-failed',
      source: 'rpc',
      ip: ctx.ip,
      entity_type: 'user',
      entity_id: existing.id,
      after_json: JSON.stringify({ reason: 'disabled' }),
    }).catch(() => undefined)
    throw new ServerError('AUTH', 'account is disabled')
  }

  const groupDns = await dir.groupDns(entry.dn)
  const role = roleForGroups(config, groupDns)

  let user: User
  if (existing) {
    // refresh directory-sourced fields (role can follow group changes)
    await db
      .update(schema.users)
      .set({
        auth_source: 'ldap',
        ldap_dn: entry.dn,
        display_name: entry.displayName || null,
        email: entry.email || null,
        role,
        failed_attempts: 0,
        locked_until: null,
      })
      .where(eq(schema.users.id, existing.id))
    const refreshed = await findUser(db, identity)
    if (!refreshed) {
      throw new ServerError('INTERNAL', 'user row vanished after update')
    }
    user = refreshed
  } else {
    await db.insert(schema.users).values({
      id: `usr_${ulid()}`,
      username: identity,
      display_name: entry.displayName || null,
      email: entry.email || null,
      auth_source: 'ldap',
      password_hash: null,
      ldap_dn: entry.dn,
      role,
      failed_attempts: 0,
      locked_until: null,
      created_at: new Date().toISOString(),
      disabled_at: null,
    })
    const created = await findUser(db, identity)
    if (!created) {
      throw new ServerError('INTERNAL', 'JIT provisioning failed')
    }
    user = created
  }

  await recordAudit(db, {
    actor_id: user.id,
    actor_name: user.username,
    action: 'auth.login',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'user',
    entity_id: user.id,
    after_json: JSON.stringify({
      auth_source: 'ldap',
      role,
      groups: groupDns.length,
    }),
  })
  const token = await issueToken(db, user.id, `session-${ulid()}`, null)
  return {
    identity: { id: user.id, username: user.username, role: user.role },
    result: { token, user: publicUser(user) },
  }
}

async function authToken(
  db: DB,
  params: Record<string, unknown>,
): Promise<AuthResult> {
  const token = strParam(params, 'token')
  const rows = await db
    .select()
    .from(schema.tokens)
    .where(eq(schema.tokens.token_hash, hashToken(token)))
  const t = rows[0]
  if (!t) {
    throw new ServerError('AUTH', 'invalid token')
  }
  if (t.expires_at && new Date(t.expires_at) <= new Date()) {
    throw new ServerError('AUTH', 'token expired')
  }
  const u = await findUserById(db, t.user_id)
  if (!u) {
    throw new ServerError('AUTH', 'token owner no longer exists')
  }
  if (u.disabled_at) {
    throw new ServerError('AUTH', 'account is disabled')
  }
  await db
    .update(schema.tokens)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(schema.tokens.id, t.id))
  return {
    identity: { id: u.id, username: u.username, role: u.role },
    result: { user: publicUser(u) },
  }
}

async function authBootstrap(
  db: DB,
  config: CRMConfig,
  ctx: { bootstrapCode: string | null; ip: string },
  params: Record<string, unknown>,
): Promise<AuthResult> {
  if (ctx.bootstrapCode === null) {
    throw new ServerError(
      'AUTH',
      'bootstrap is only available while the users table is empty',
    )
  }
  const code = strParam(params, 'code')
  if (code !== ctx.bootstrapCode) {
    throw new ServerError('AUTH', 'invalid bootstrap code')
  }
  if ((await userCount(db)) > 0) {
    throw new ServerError(
      'AUTH',
      'bootstrap is only available while the users table is empty',
    )
  }
  // normalized before the pattern check: the pattern is lowercase, and
  // an operator typing `Alice` at bootstrap means the same identity
  const username = normalizeUsername(strParam(params, 'username'))
  if (!USERNAME_RE.test(username)) {
    throw new ServerError(
      'INVALID',
      'username must be 3-32 chars of [a-z0-9._-] starting with alnum',
    )
  }
  const password = strParam(params, 'password')
  if (password.length < config.auth.password_min_length) {
    throw new ServerError(
      'INVALID',
      `password must be at least ${config.auth.password_min_length} characters`,
    )
  }
  const display = (params.display_name as string | undefined) ?? username
  const now = new Date().toISOString()
  const id = `usr_${ulid()}`
  await db.insert(schema.users).values({
    id,
    username,
    display_name: display,
    email: null,
    auth_source: 'local',
    password_hash: await hashPassword(password),
    ldap_dn: null,
    role: 'owner',
    failed_attempts: 0,
    locked_until: null,
    created_at: now,
    disabled_at: null,
  })
  await recordAudit(db, {
    actor_id: id,
    actor_name: username,
    action: 'auth.bootstrap',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'user',
    entity_id: id,
    after_json: JSON.stringify({ username, role: 'owner' }),
  })
  const user = await findUser(db, username)
  if (!user) {
    throw new ServerError('NOT_FOUND', `user "${username}" not found`)
  }
  const token = await issueToken(db, user.id, 'owner-session', null)
  return {
    identity: { id: user.id, username: user.username, role: user.role },
    result: { token, user: publicUser(user) },
  }
}

async function issueToken(
  db: DB,
  userId: string,
  name: string,
  expiresAt: Date | null,
): Promise<string> {
  const token = generateToken()
  await db.insert(schema.tokens).values({
    id: `tok_${ulid()}`,
    user_id: userId,
    name,
    token_hash: hashToken(token),
    scopes: '[]',
    created_at: new Date().toISOString(),
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    last_used_at: new Date().toISOString(),
  })
  return token
}

// ── Command dispatch (post-auth frames) ──

export async function handleCommand(
  db: DB,
  config: CRMConfig,
  ctx: { ip: string },
  identity: Identity,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (method.startsWith('admin.')) {
    if (!isPrivileged(identity)) {
      throw new ServerError(
        'FORBIDDEN',
        `role "${identity.role}" cannot call ${method}`,
      )
    }
    return handleAdmin(db, ctx, identity, method, params)
  }
  const def = METHODS[method]
  if (!def) {
    throw new ServerError('INVALID', `unknown method "${method}"`)
  }
  if (!roleAllows(def.minRole, identity.role)) {
    throw new ServerError(
      'FORBIDDEN',
      `role "${identity.role}" cannot call ${method}`,
    )
  }
  // P3 actor threading: the service layer records the acting user on the
  // rows it touches (local mode has no identity, so it records none).
  // Only injected for write methods — read-only services may use `actor`
  // as a user-facing filter (e.g. `audit list --actor`) and must not see
  // the identity instead of the caller's explicit params.
  const actorParams = def.write
    ? { actor: identity.username, ...params }
    : params
  const before = def.write
    ? await auditSnapshot(db, config, method, actorParams, null)
    : null
  try {
    const result = await def.fn(db, config, actorParams)
    if (def.write) {
      const after = await auditSnapshot(db, config, method, actorParams, result)
      const meta = await auditMeta(db, config, method, actorParams, result)
      try {
        await recordAudit(db, {
          action: method,
          actor_id: identity.id,
          actor_name: identity.username,
          source: 'rpc',
          ip: ctx.ip,
          entity_type: meta.entity_type,
          entity_id: meta.entity_id,
          before_json: before,
          after_json: after,
        })
      } catch {
        // an audit failure must not fail the data write
      }
    }
    return result
  } catch (e) {
    if (e instanceof ServiceError) {
      throw new ServerError(e.code, e.message)
    }
    throw e
  }
}

function handleAdmin(
  db: DB,
  ctx: { ip: string },
  identity: Identity,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (method) {
    case 'admin.user.create':
      return adminUserCreate(db, ctx, identity, params)
    case 'admin.user.list':
      return adminUserList(db)
    case 'admin.user.set-role':
      return adminUserSetRole(db, ctx, identity, params)
    case 'admin.user.disable':
      return adminUserDisableEnable(db, ctx, identity, params, true)
    case 'admin.user.enable':
      return adminUserDisableEnable(db, ctx, identity, params, false)
    case 'admin.token.create':
      return adminTokenCreate(db, ctx, identity, params)
    case 'admin.token.list':
      return adminTokenList(db)
    case 'admin.token.revoke':
      return adminTokenRevoke(db, ctx, identity, params)
    default:
      throw new ServerError('INVALID', `unknown method "${method}"`)
  }
}

async function adminUserCreate(
  db: DB,
  ctx: { ip: string },
  identity: Identity,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const username = normalizeUsername(strParam(params, 'username'))
  if (!USERNAME_RE.test(username)) {
    throw new ServerError(
      'INVALID',
      'username must be 3-32 chars of [a-z0-9._-] starting with alnum',
    )
  }
  const role = (params.role as string | undefined) ?? 'reader'
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    throw new ServerError('INVALID', `invalid role "${role}"`)
  }
  if (role === 'owner') {
    throw new ServerError(
      'INVALID',
      'owner role can only be created via bootstrap',
    )
  }
  if (await findUser(db, username)) {
    throw new ServerError('CONFLICT', `username "${username}" already exists`)
  }
  const initialPassword = generatePassword()
  const display = (params.display_name as string | undefined) ?? username
  const id = `usr_${ulid()}`
  const now = new Date().toISOString()
  await db.insert(schema.users).values({
    id,
    username,
    display_name: display,
    email: (params.email as string | undefined) ?? null,
    auth_source: 'local',
    password_hash: await hashPassword(initialPassword),
    ldap_dn: null,
    role,
    failed_attempts: 0,
    locked_until: null,
    created_at: now,
    disabled_at: null,
  })
  const user = await findUser(db, username)
  if (!user) {
    throw new ServerError('NOT_FOUND', `user "${username}" not found`)
  }
  await recordAudit(db, {
    actor_id: identity.id,
    actor_name: identity.username,
    action: 'admin.user.create',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'user',
    entity_id: id,
    after_json: JSON.stringify({ username, role, display_name: display }),
  })
  return { user: publicUser(user), initial_password: initialPassword }
}

async function adminUserList(db: DB): Promise<Record<string, unknown>> {
  const rows = await db.select().from(schema.users)
  return {
    users: rows.map((u) => ({
      ...publicUser(u),
      disabled: u.disabled_at !== null,
      locked: u.locked_until !== null && new Date(u.locked_until) > new Date(),
    })),
  }
}

async function adminUserSetRole(
  db: DB,
  ctx: { ip: string },
  identity: Identity,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const username = strParam(params, 'username')
  const role = strParam(params, 'role')
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    throw new ServerError('INVALID', `invalid role "${role}"`)
  }
  if (role === 'owner') {
    throw new ServerError(
      'INVALID',
      'owner role can only be created via bootstrap',
    )
  }
  const u = await findUser(db, username)
  if (!u) {
    throw new ServerError('NOT_FOUND', `user "${username}" not found`)
  }
  if (u.auth_source === 'ldap') {
    // Directory roles are recomputed from group membership at every
    // login, so a set-role here would be silently undone hours later.
    // Saying so beats writing a value that is about to lose.
    throw new ServerError(
      'INVALID',
      `${u.username} authenticates against the directory — its role follows group membership. Change the group in the directory ([ldap.roles] maps it); set-role would be reverted on the next login. Use disable to cut access immediately.`,
    )
  }
  await db.update(schema.users).set({ role }).where(eq(schema.users.id, u.id))
  const updated = await findUser(db, username)
  if (!updated) {
    throw new ServerError('NOT_FOUND', `user "${username}" not found`)
  }
  await recordAudit(db, {
    actor_id: identity.id,
    actor_name: identity.username,
    action: 'admin.user.set-role',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'user',
    entity_id: u.id,
    after_json: JSON.stringify({ username, role }),
  })
  return { user: publicUser(updated) }
}

async function adminUserDisableEnable(
  db: DB,
  ctx: { ip: string },
  identity: Identity,
  params: Record<string, unknown>,
  disable: boolean,
): Promise<Record<string, unknown>> {
  const username = strParam(params, 'username')
  const u = await findUser(db, username)
  if (!u) {
    throw new ServerError('NOT_FOUND', `user "${username}" not found`)
  }
  if (u.role === 'owner' && disable) {
    throw new ServerError('INVALID', 'the owner account cannot be disabled')
  }
  if (u.id === identity.id && disable) {
    throw new ServerError('INVALID', 'cannot disable your own account')
  }
  await db
    .update(schema.users)
    .set({
      disabled_at: disable ? new Date().toISOString() : null,
      failed_attempts: 0,
      locked_until: null,
    })
    .where(eq(schema.users.id, u.id))
  const updated = await findUser(db, username)
  if (!updated) {
    throw new ServerError('NOT_FOUND', `user "${username}" not found`)
  }
  await recordAudit(db, {
    actor_id: identity.id,
    actor_name: identity.username,
    action: disable ? 'admin.user.disable' : 'admin.user.enable',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'user',
    entity_id: u.id,
    after_json: JSON.stringify({ username, disabled: disable }),
  })
  return { user: publicUser(updated) }
}

async function adminTokenCreate(
  db: DB,
  ctx: { ip: string },
  identity: Identity,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = strParam(params, 'name')
  const usernameParam = params.username as string | undefined
  const target = usernameParam
    ? await findUser(db, usernameParam)
    : await findUserById(db, identity.id)
  if (!target) {
    throw new ServerError('NOT_FOUND', 'target user for token not found')
  }
  const expiresIn = Number(params.expires_in_seconds ?? 0)
  const expiresAt =
    expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null
  const token = await issueToken(db, target.id, name, expiresAt)
  await recordAudit(db, {
    actor_id: identity.id,
    actor_name: identity.username,
    action: 'admin.token.create',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'token',
    entity_id: target.id,
    after_json: JSON.stringify({
      name,
      username: target.username,
      expires_in_seconds: expiresIn || null,
    }),
  })
  return { token, name, username: target.username }
}

async function adminTokenList(db: DB): Promise<Record<string, unknown>> {
  const tokens = await db.select().from(schema.tokens)
  const users = await db.select().from(schema.users)
  const byId = new Map(users.map((u) => [u.id, u.username]))
  return {
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      username: byId.get(t.user_id) ?? '?',
      created_at: t.created_at,
      expires_at: t.expires_at,
      last_used_at: t.last_used_at,
    })),
  }
}

async function adminTokenRevoke(
  db: DB,
  ctx: { ip: string },
  identity: Identity,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = strParam(params, 'id')
  const rows = await db
    .select()
    .from(schema.tokens)
    .where(eq(schema.tokens.id, id))
  const t = rows[0]
  if (!t) {
    throw new ServerError('NOT_FOUND', `token "${id}" not found`)
  }
  await db.delete(schema.tokens).where(eq(schema.tokens.id, id))
  await recordAudit(db, {
    actor_id: identity.id,
    actor_name: identity.username,
    action: 'admin.token.revoke',
    source: 'rpc',
    ip: ctx.ip,
    entity_type: 'token',
    entity_id: id,
    after_json: JSON.stringify({ name: t.name, username: t.user_id }),
  })
  return { ok: true, id }
}
