import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestContext } from '../helpers.ts'

/**
 * P0 security: hooks run arbitrary commands (`shell: true`) and `crm.toml`
 * is discovered by walking up from the cwd — a config checked into a
 * hostile repo could otherwise execute commands on every `crm` invocation.
 *
 * Contract under test:
 * - A config discovered by walking up (project config) only enables hooks
 *   when it explicitly sets `[hooks] enabled = true`.
 * - Explicitly selected configs (`--config` / `CRM_CONFIG`) and the global
 *   `~/.crm/config.toml` are trusted as-is (covered by test/hook.test.ts,
 *   which always passes --config).
 */
function setup() {
  // noConfig: no CRM_CONFIG env var, so a crm.toml in cwd is discovered
  // by the upward walk — the exact path a cloned repo takes over.
  const ctx = createTestContext({ noConfig: true })
  const hookOutput = join(ctx.dir, 'hook-output.json')
  const hookScript = join(ctx.dir, 'hook.sh')
  writeFileSync(hookScript, `#!/bin/sh\ncat > ${hookOutput}\n`, {
    mode: 0o755,
  })
  return { ctx, hookOutput, hookScript }
}

function writeProjectConfig(ctxDir: string, body: string) {
  writeFileSync(
    join(ctxDir, 'crm.toml'),
    `[phone]\ndefault_country = "US"\n\n${body}`,
  )
}

describe('hooks: project config opt-in (P0 security)', () => {
  test('project-discovered hooks are inert without [hooks] enabled = true', () => {
    const { ctx, hookOutput, hookScript } = setup()
    writeProjectConfig(ctx.dir, `[hooks]\npost-contact-add = "${hookScript}"\n`)
    const result = ctx.run('contact', 'add', '--name', 'Jane')
    expect(result.exitCode).toBe(0)
    expect(existsSync(hookOutput)).toBe(false)
    expect(result.stderr).toContain('hooks')
  })

  test('project-discovered hooks run with [hooks] enabled = true', () => {
    const { ctx, hookOutput, hookScript } = setup()
    writeProjectConfig(
      ctx.dir,
      `[hooks]\nenabled = true\npost-contact-add = "${hookScript}"\n`,
    )
    ctx.runOK('contact', 'add', '--name', 'Jane')
    expect(existsSync(hookOutput)).toBe(true)
  })

  test('explicit enabled = false keeps project hooks inert', () => {
    const { ctx, hookOutput, hookScript } = setup()
    writeProjectConfig(
      ctx.dir,
      `[hooks]\nenabled = false\npost-contact-add = "${hookScript}"\n`,
    )
    ctx.runOK('contact', 'add', '--name', 'Jane')
    expect(existsSync(hookOutput)).toBe(false)
  })

  test('contact add still succeeds when hooks are suppressed', () => {
    const { ctx, hookScript } = setup()
    writeProjectConfig(ctx.dir, `[hooks]\npost-contact-add = "${hookScript}"\n`)
    const out = ctx.runOK('contact', 'add', '--name', 'Jane')
    expect(out.trim().length).toBeGreaterThan(0)
  })
})
