import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse as parseTOML } from 'toml'

export interface CRMConfig {
  /**
   * P9: which activity types `crm activity log` accepts. Defaults to the
   * four classic types; add domain-specific ones (wechat, visit,
   * entertainment, dingtalk, ...) so a team's real cadence is capturable
   * without patching the binary. The list is the single source of truth
   * for validation and for the CLI help text.
   */
  activity: { types: string[] }
  auth: {
    lockout_threshold: number
    lockout_minutes: number
    password_min_length: number
    /**
     * P6: role assigned to a JIT-provisioned directory user whose group
     * membership maps to nothing. "none" (default) = deny everything.
     */
    default_role: string
    /**
     * Login attempts accepted per client IP per minute (0 = unlimited).
     * Directory-backed logins never touch the CRM lockout counters (the
     * directory owns that policy), so this is the only ceiling on how
     * fast one client can push attempts at the directory.
     */
    login_rate_per_minute: number
    /** Same, per (client IP, username) pair. 0 = unlimited. */
    login_user_rate_per_minute: number
  }
  /**
   * P5 litestream backup. When `destination` is set (local path or
   * s3://bucket/prefix), `crm serve` spawns a continuous `litestream
   * replicate` child process at startup; one-shot operations use
   * `crm backup sync`.
   */
  backup: { destination: string }
  /**
   * Where the effective config came from. Resolved by `loadConfig`, never
   * read from a config file. `trusted` means explicitly selected
   * (--config / CRM_CONFIG) or the global ~/.crm/config.toml; a config
   * found by walking up from the cwd is only semi-trusted, and
   * `dropped_auth_authority` records whether it tried to define login
   * authority anyway (see spec/enterprise.md, "Config discovery").
   */
  config_meta: {
    dropped_auth_authority: boolean
    path: string
    trusted: boolean
  }
  database: { path: string }
  defaults: { format: string }
  hooks: Record<string, string>
  /**
   * P6 LDAP directory integration. When `enabled`, usernames that resolve
   * in the directory authenticate against it (two-step bind); local
   * accounts whose username does not resolve keep local password auth.
   */
  ldap: {
    enabled: boolean
    url: string
    starttls: boolean
    base_dn: string
    bind_dn: string
    bind_password_env: string
    user_filter: string
    group_base_dn: string
    /** group DN (exact, case-insensitive) → CRM role */
    roles: Record<string, string>
    /**
     * PEM file holding the CA(s) that signed the directory certificate.
     * Empty = the system trust store.
     */
    tls_ca_file: string
    /**
     * Skip certificate *verification* (self-signed lab directories).
     * Never the default; `crm serve` logs a warning when it is set, and
     * it is unrelated to `starttls`/`ldaps`, which stay mandatory.
     */
    tls_skip_verify: boolean
    /**
     * Per-operation (bind/search) deadline in ms. ldapts defaults to no
     * timeout, which turns a black-holed directory into a hung login.
     */
    timeout_ms: number
    /** TCP connect deadline in ms. */
    connect_timeout_ms: number
  }
  /**
   * Outbound SMTP for `crm email send`. The relay password is never stored
   * in config — it comes from the server process env (CRM_SMTP_PASSWORD),
   * matching the LDAP bind-password trust model.
   */
  mail: {
    host: string
    port: number
    user: string
    from: string
    secure: boolean
  }
  mount: {
    default_path: string
    readonly: boolean
    /**
     * Mount with `-o allow_other` so processes running as a different uid
     * (e.g. root, container orchestrators) can read/write the FUSE filesystem.
     * Requires `user_allow_other` in /etc/fuse.conf when the mount is invoked
     * by a non-root user. Linux-only; ignored by the macOS NFS path.
     */
    allow_other: boolean
    max_recent_activity: number
    search_limit: number
  }
  phone: { default_country?: string; display: string }
  pipeline: { stages: string[]; won_stage: string; lost_stage: string }
  remote: { server: string; insecure: boolean }
  serve: { port: number; host: string; cert: string; key: string }
}

export const SEARCH_MODEL = 'mxbai-embed-xsmall-v1'

const DEFAULT_STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'closed-won',
  'closed-lost',
]

function defaultConfig(): CRMConfig {
  return {
    backup: { destination: '' },
    activity: { types: ['note', 'call', 'meeting', 'email'] },
    database: { path: join(homedir(), '.crm', 'crm.db') },
    pipeline: {
      stages: [...DEFAULT_STAGES],
      won_stage: 'closed-won',
      lost_stage: 'closed-lost',
    },
    defaults: { format: 'table' },
    phone: { display: 'international' },
    remote: { server: '', insecure: false },
    mail: { host: '', port: 587, user: '', from: '', secure: false },
    serve: { port: 8443, host: '127.0.0.1', cert: '', key: '' },
    auth: {
      lockout_threshold: 5,
      lockout_minutes: 15,
      password_min_length: 12,
      default_role: 'none',
      login_rate_per_minute: 60,
      login_user_rate_per_minute: 15,
    },
    config_meta: {
      dropped_auth_authority: false,
      path: '',
      trusted: true,
    },
    ldap: {
      enabled: false,
      url: '',
      starttls: false,
      base_dn: '',
      bind_dn: '',
      bind_password_env: '',
      user_filter: '(uid={username})',
      group_base_dn: '',
      roles: {},
      tls_ca_file: '',
      tls_skip_verify: false,
      timeout_ms: 5000,
      connect_timeout_ms: 3000,
    },
    hooks: {},
    mount: {
      default_path: join(homedir(), 'crm'),
      readonly: false,
      allow_other: false,
      max_recent_activity: 10,
      search_limit: 20,
    },
  }
}

function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir)
  while (true) {
    const candidate = join(dir, 'crm.toml')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  const global = join(homedir(), '.crm', 'config.toml')
  if (existsSync(global)) {
    return global
  }
  return null
}

function mergeConfig(
  base: CRMConfig,
  // biome-ignore lint/suspicious/noExplicitAny: TOML parse output has no static type
  override: Record<string, any>,
): CRMConfig {
  const result = { ...base }
  // Booleans and numbers must be tested for presence, not truthiness: a
  // config that says `starttls = false` or `login_rate_per_minute = 0`
  // means something, and ignoring it silently is how a security knob
  // quietly stops meaning what it says.
  const given = (v: unknown): boolean => v !== undefined && v !== null
  if (override.database?.path) {
    result.database = { ...result.database, path: override.database.path }
  }
  if (override.activity?.types) {
    result.activity = {
      ...result.activity,
      types: override.activity.types.map((t: unknown) => String(t).trim()),
    }
  }
  if (override.pipeline) {
    result.pipeline = { ...result.pipeline }
    if (override.pipeline.stages) {
      result.pipeline.stages = override.pipeline.stages
    }
    if (override.pipeline.won_stage) {
      result.pipeline.won_stage = override.pipeline.won_stage
    }
    if (override.pipeline.lost_stage) {
      result.pipeline.lost_stage = override.pipeline.lost_stage
    }
  }
  if (override.defaults?.format) {
    result.defaults = { ...result.defaults, format: override.defaults.format }
  }
  if (override.phone) {
    result.phone = { ...result.phone }
    if (override.phone.default_country) {
      result.phone.default_country = override.phone.default_country
    }
    if (override.phone.display) {
      result.phone.display = override.phone.display
    }
  }
  if (override.hooks) {
    result.hooks = { ...result.hooks, ...override.hooks }
  }
  if (override.mount) {
    result.mount = { ...result.mount, ...override.mount }
  }
  if (override.remote) {
    result.remote = {
      ...result.remote,
      ...(override.remote.server ? { server: override.remote.server } : {}),
      ...(override.remote.insecure
        ? { insecure: override.remote.insecure }
        : {}),
    }
  }
  if (override.mail) {
    result.mail = {
      ...result.mail,
      ...(override.mail.host ? { host: override.mail.host } : {}),
      ...(override.mail.port ? { port: override.mail.port } : {}),
      ...(override.mail.user ? { user: override.mail.user } : {}),
      ...(override.mail.from ? { from: override.mail.from } : {}),
      ...(override.mail.secure ? { secure: true } : {}),
    }
  }
  if (override.backup) {
    result.backup = {
      ...result.backup,
      ...(override.backup.destination
        ? { destination: override.backup.destination }
        : {}),
    }
  }
  if (override.serve) {
    result.serve = {
      ...result.serve,
      ...(override.serve.port ? { port: override.serve.port } : {}),
      ...(override.serve.host ? { host: override.serve.host } : {}),
      ...(override.serve.cert ? { cert: override.serve.cert } : {}),
      ...(override.serve.key ? { key: override.serve.key } : {}),
    }
  }
  if (override.auth) {
    result.auth = {
      ...result.auth,
      ...(override.auth.lockout_threshold
        ? { lockout_threshold: override.auth.lockout_threshold }
        : {}),
      ...(override.auth.lockout_minutes
        ? { lockout_minutes: override.auth.lockout_minutes }
        : {}),
      ...(override.auth.password_min_length
        ? { password_min_length: override.auth.password_min_length }
        : {}),
      ...(override.auth.default_role
        ? { default_role: override.auth.default_role }
        : {}),
      ...(given(override.auth.login_rate_per_minute)
        ? {
            login_rate_per_minute: override.auth.login_rate_per_minute,
          }
        : {}),
      ...(given(override.auth.login_user_rate_per_minute)
        ? {
            login_user_rate_per_minute:
              override.auth.login_user_rate_per_minute,
          }
        : {}),
    }
  }
  if (override.ldap) {
    result.ldap = {
      ...result.ldap,
      ...(given(override.ldap.enabled)
        ? { enabled: override.ldap.enabled === true }
        : {}),
      ...(override.ldap.url ? { url: override.ldap.url } : {}),
      ...(given(override.ldap.starttls)
        ? { starttls: override.ldap.starttls === true }
        : {}),
      ...(given(override.ldap.tls_skip_verify)
        ? { tls_skip_verify: override.ldap.tls_skip_verify === true }
        : {}),
      ...(override.ldap.tls_ca_file
        ? { tls_ca_file: override.ldap.tls_ca_file }
        : {}),
      ...(given(override.ldap.timeout_ms)
        ? { timeout_ms: override.ldap.timeout_ms }
        : {}),
      ...(given(override.ldap.connect_timeout_ms)
        ? { connect_timeout_ms: override.ldap.connect_timeout_ms }
        : {}),
      ...(override.ldap.base_dn ? { base_dn: override.ldap.base_dn } : {}),
      ...(override.ldap.bind_dn ? { bind_dn: override.ldap.bind_dn } : {}),
      ...(override.ldap.bind_password_env
        ? { bind_password_env: override.ldap.bind_password_env }
        : {}),
      ...(override.ldap.user_filter
        ? { user_filter: override.ldap.user_filter }
        : {}),
      ...(override.ldap.group_base_dn
        ? { group_base_dn: override.ldap.group_base_dn }
        : {}),
    }
    if (override.ldap.roles) {
      result.ldap.roles = { ...result.ldap.roles, ...override.ldap.roles }
    }
  }
  return result
}

/** Detect the user's country code from system locale (e.g. "en_US" → "US") */
function detectCountry(): string | undefined {
  try {
    // macOS: AppleLocale gives e.g. "en_US"
    if (process.platform === 'darwin') {
      const locale = execSync('defaults read NSGlobalDomain AppleLocale', {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .toString()
        .trim()
      const match = locale.match(/_([A-Z]{2})/)
      if (match) {
        return match[1]
      }
    }
    // Linux/other: LANG or LC_ALL (e.g. "en_US.UTF-8" → "US")
    const lang = process.env.LC_ALL || process.env.LANG || ''
    const match = lang.match(/_([A-Z]{2})/)
    if (match) {
      return match[1]
    }
  } catch {
    // detection failed
  }
  return undefined
}

function createDefaultConfig(configPath: string): void {
  const country = detectCountry() || 'US'
  const content = `# CRM CLI configuration
# Docs: https://github.com/dzhng/crm.cli#configuration

[phone]
default_country = "${country}"
display = "national"

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"
`
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, content)
  console.log(`Created default config at ${configPath}`)
  console.log(
    `  phone.default_country = "${country}" (detected from system locale)`,
  )
  console.log('  Edit this file to customize.\n')
}

/**
 * The one place that explains the config trust boundary, so `crm serve`
 * (fatal) and every other command (warning) say the same thing.
 */
export function projectAuthConfigWarning(configPath: string): string {
  return (
    `ignoring [auth]/[ldap] from the project-discovered config ${configPath}. ` +
    'They decide who may log in and with what role, and a config found by ' +
    'walking up from the cwd is not trusted to define that. Move them into a ' +
    'config selected with --config / $CRM_CONFIG, or into ~/.crm/config.toml.'
  )
}

export function loadConfig(opts: {
  configPath?: string
  dbPath?: string
  format?: string
}): CRMConfig {
  let config = defaultConfig()

  // Resolve config file — auto-create with sensible defaults on first run.
  // Explicit selection (--config / CRM_CONFIG) is trusted; otherwise the
  // nearest crm.toml found by walking up from cwd wins, and the global
  // ~/.crm/config.toml is the fallback.
  const globalPath = join(homedir(), '.crm', 'config.toml')
  const explicitPath = opts.configPath || process.env.CRM_CONFIG

  let configPath: string
  if (explicitPath) {
    configPath = explicitPath
  } else {
    const found = findConfigFile(process.cwd())
    if (found) {
      configPath = found
    } else {
      configPath = globalPath
      createDefaultConfig(globalPath)
    }
  }

  // Hooks are arbitrary code execution, and project configs are discovered
  // by walking up from the cwd — a crm.toml checked into a hostile repo
  // must not be able to execute commands. A project-discovered config may
  // therefore only enable hooks with an explicit `[hooks] enabled = true`
  // marker. Explicitly selected configs and the global config are trusted.
  const isProjectConfig = !explicitPath && configPath !== globalPath

  let droppedAuthAuthority = false
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = parseTOML(raw)
    // [auth] and [ldap] decide who is trusted to log in. Unlike [phone]
    // or [pipeline], getting them wrong is not a preference mismatch but
    // an authentication bypass, and there is no legitimate reason for
    // them to live in a per-checkout config: the directory a server
    // authenticates against is a deployment fact.
    if (parsed && isProjectConfig && (parsed.auth || parsed.ldap)) {
      droppedAuthAuthority = true
      console.error(`Warning: ${projectAuthConfigWarning(configPath)}`)
      parsed.auth = undefined
      parsed.ldap = undefined
    }
    if (parsed?.hooks && typeof parsed.hooks === 'object') {
      const hooksEnabled = parsed.hooks.enabled === true
      parsed.hooks.enabled = undefined
      const hasHookEntries = Object.values(parsed.hooks).some(
        (v) => v !== undefined,
      )
      if (isProjectConfig && !hooksEnabled && hasHookEntries) {
        console.error(
          `Warning: ignoring hooks from project config ${configPath}. ` +
            'Hooks execute arbitrary commands — review the config and add ' +
            '[hooks] enabled = true only if you trust it.',
        )
        parsed.hooks = undefined
      }
    }
    config = mergeConfig(config, parsed)
  } catch (_e) {
    console.error(`Warning: could not parse config file ${configPath}`)
  }

  // Env var overrides (take priority over config file)
  if (process.env.CRM_PHONE_DEFAULT_COUNTRY) {
    config.phone.default_country = process.env.CRM_PHONE_DEFAULT_COUNTRY
  }
  if (process.env.CRM_PHONE_DISPLAY) {
    config.phone.display = process.env.CRM_PHONE_DISPLAY
  }

  // DB path resolution: --db flag > CRM_DB env > config file > default (~/.crm/crm.db)
  if (opts.dbPath) {
    config.database.path = opts.dbPath
  } else if (process.env.CRM_DB) {
    config.database.path = process.env.CRM_DB
  }

  // Format: --format flag > CRM_FORMAT env > config > default
  if (opts.format) {
    config.defaults.format = opts.format
  } else if (process.env.CRM_FORMAT) {
    config.defaults.format = process.env.CRM_FORMAT
  }

  config.config_meta = {
    dropped_auth_authority: droppedAuthAuthority,
    path: configPath,
    trusted: !isProjectConfig,
  }

  return config
}
