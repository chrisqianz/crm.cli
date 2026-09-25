import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse as parseTOML } from 'toml'

export interface CRMConfig {
  auth: {
    lockout_threshold: number
    lockout_minutes: number
    password_min_length: number
  }
  database: { path: string }
  defaults: { format: string }
  hooks: Record<string, string>
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
    database: { path: join(homedir(), '.crm', 'crm.db') },
    pipeline: {
      stages: [...DEFAULT_STAGES],
      won_stage: 'closed-won',
      lost_stage: 'closed-lost',
    },
    defaults: { format: 'table' },
    phone: { display: 'international' },
    serve: { port: 8443, host: '127.0.0.1', cert: '', key: '' },
    auth: {
      lockout_threshold: 5,
      lockout_minutes: 15,
      password_min_length: 12,
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
  if (override.database?.path) {
    result.database = { ...result.database, path: override.database.path }
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

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = parseTOML(raw)
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

  return config
}
