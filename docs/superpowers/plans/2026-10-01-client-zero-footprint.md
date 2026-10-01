# Client Zero-Footprint Contract (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client install can never read or write a local CRM database — unconfigured data commands fail with fixed guidance copy; local mode requires an explicitly resolvable db path.

**Architecture:** One decision point (`remoteEndpoint()` in `src/remote/dispatch.ts`) owns mode resolution; `loadConfig` stops inventing a default db path (`database.path` becomes `string | undefined`); every host-command entry point guards on a resolvable path before `openDB`. Host commands and the REPL (sub-project C) inherit the contract by going through the same code.

**Tech Stack:** Bun + TypeScript, bun:test functional tests spawning `src/cli.ts` with an isolated `$HOME`, commander, no new dependencies.

## Global Constraints

- Spec: `spec/client-repl.md` §A. Fixed copy, verbatim, asserted by tests (die() prints raw, house prefix is `Error: `):
  - `NOT_CONNECTED` = `Error: not connected — run 'crm login <server>' (get the server address from your admin console), or use --local/--db for the server host`
  - `NEEDS_DB` = `Error: server-host command — needs --db or a [database] path in your config`
  Both exit code 1.
- TDD: write the failing test first, run it to see red, minimal code, green, then mutation-check (temporarily revert the production change, confirm red, restore from a `/tmp` snapshot — never `git checkout` uncommitted work).
- Every commit: `bun run check-types` = 0 errors, `npx ultracite fix` clean (husky runs it), targeted suites green.
- `bun test` writes results to **stderr** — capture with `> /tmp/x.txt 2>&1`.
- Functional tests spawn the real CLI and are load-sensitive; run targeted files, not the full suite, per task.
- Machine surface (`crm <argv>`) is unchanged for everything except the new failure modes defined here.
- Existing `test/helpers.ts` always passes an explicit `--db`, so local functional suites must stay green untouched — verify, don't patch tests to fit.

---

### Task 1: Remove the implicit default db path; guard host-command entry points

**Files:**
- Modify: `src/config.ts` (default at ~140, type at ~56, resolution at ~505)
- Modify: `src/commands/serve.ts`, `src/commands/fuse.ts`, `src/commands/backup.ts`, `src/commands/admin.ts`, `src/lib/helpers.ts`, `src/service/backup.ts` (as compilation requires)
- Test: `test/config.test.ts` (extend), `test/zero-footprint.test.ts` (new, host-copy cases only in this task)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CRMConfig['database']['path']: string | undefined` — `undefined` means "nobody declared a database". Later tasks branch on this. `src/remote/dispatch.ts` exports `const NOT_CONNECTED` / `const NEEDS_DB` string constants (defined here, used in Task 2).

- [ ] **Step 1: Write failing unit tests** in `test/config.test.ts`:

```ts
describe('database path is never invented', () => {
  test('no config file → database.path is undefined', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-cfg-'))
    const cfg = loadConfig({ configPath: join(home, 'absent.toml') })
    expect(cfg.database.path).toBeUndefined()
  })
  test('[database] path in config still resolves', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-cfg-'))
    const p = join(home, 'crm.toml')
    writeFileSync(p, '[database]\npath = "/srv/crm.db"\n')
    expect(loadConfig({ configPath: p }).database.path).toBe('/srv/crm.db')
  })
})
```

- [ ] **Step 2: Run** `bun test test/config.test.ts > /tmp/t1red.txt 2>&1` — expect FAIL on `undefined` (currently `~/.crm/crm.db`). Fix any pre-existing assertions in that file that expected the default path.
- [ ] **Step 3: Minimal implementation.** `src/config.ts`: type `database: { path: string | undefined }`; default `{ path: undefined }`; at the resolution block (~505) delete the "default (~/.crm/crm.db)" fallback comment/line so precedence is `--db` > `CRM_DB` > config > undefined. Then fix every compile consumer by guarding, not by re-defaulting. Shared constants in `src/remote/dispatch.ts`:

```ts
export const NOT_CONNECTED =
  "Error: not connected — run 'crm login <server>' (get the server address from your admin console), or use --local/--db for the server host"
export const NEEDS_DB =
  'Error: server-host command — needs --db or a [database] path in your config'
```

Guard pattern (serve/fuse/backup/admin and any `openDB(config.database.path)` site):

```ts
if (!config.database.path) {
  die(NEEDS_DB)
}
const db = await openDB(config.database.path) // narrowed to string
```

For `src/service/backup.ts` (5 reads): the backup commands run through the same guard at the command layer; inside the service, add a local `const dbPath = requireDbPath(config)` helper:

```ts
function requireDbPath(config: CRMConfig): string {
  if (!config.database.path) {
    die(NEEDS_DB)
  }
  return config.database.path
}
```

(`serve --init` keeps working: it generates a config that declares `[database]`; if invoked without any resolvable path it now dies with `NEEDS_DB` — this is intended per spec A2.)

- [ ] **Step 4: Add failing functional test** to new `test/zero-footprint.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function cli(home: string, args: string[]) {
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    NO_COLOR: '1',
  } as Record<string, string>
  for (const k of ['CRM_SERVER', 'CRM_TOKEN', 'CRM_LOCAL', 'CRM_DB', 'CRM_CONFIG']) {
    delete env[k]
  }
  const p = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: join(import.meta.dir, '..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: p.exitCode ?? -1,
    out: p.stdout.toString() + p.stderr.toString(),
  }
}

describe('zero footprint: host commands', () => {
  test('crm serve without any db path fails with NEEDS_DB', () => {
    const r = cli(mkdtempSync(join(tmpdir(), 'crm-zf-')), ['serve', '--host', '127.0.0.1', '--port', '1'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('server-host command — needs --db')
  })
})
```

- [ ] **Step 5: Run** `bun test test/zero-footprint.test.ts test/config.test.ts > /tmp/t1.txt 2>&1` — expect all green. Then `bun run check-types` → 0 errors.
- [ ] **Step 6: Regression** `bun test test/enterprise/serve.test.ts test/enterprise/backup.test.ts test/config.test.ts > /tmp/t1reg.txt 2>&1` — green (serve helper passes `--db`; fix any test that relied on the invented default by adding an explicit `--db`/config, never by restoring the default).
- [ ] **Step 7: Mutation check** — restore a one-line default `{ path: join(homedir(), '.crm', 'crm.db') }` from a `/tmp` snapshot, confirm the new config test goes red, restore the fix, confirm green. Commit: `git commit -m "feat(client): database path is never invented; host commands need an explicit one"`.

---

### Task 2: New mode contract in `remoteEndpoint()` — no implicit local fallback

**Files:**
- Modify: `src/remote/dispatch.ts` (`remoteEndpoint()` cases 3–4, `getLocalCtx`, `localOnly`, header docstring)
- Test: `test/zero-footprint.test.ts` (new cases)

**Interfaces:**
- Consumes: `config.database.path: string | undefined` (Task 1), `NOT_CONNECTED`/`NEEDS_DB` constants.
- Produces: contract used by Task 3 and sub-project C: local mode ⟺ `--db`/`CRM_DB` set, or `CRM_LOCAL/--local` with a resolvable path, or config `[database]` declared **and** no session wins first. Data commands with no server and no path die with `NOT_CONNECTED`.

- [ ] **Step 1: Write failing tests** (append to `test/zero-footprint.test.ts`, adding `readdirSync, statSync` and `writeFileSync` to the node:fs import):

```ts
/** Every path under `dir` that looks like crm state; bun's own cache is
 * excluded because it is the runtime, not the product. */
function leaked(dir: string): string[] {
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

describe('zero footprint: no implicit local mode', () => {
  test('no server, no login: data command fails with guidance and leaks no files', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const r = cli(home, [
      'contact', 'add', '--name', 'Ghost', '--email', 'g@x.io',
    ])
    expect(r.code).toBe(1)
    expect(r.out).toContain("run 'crm login")
    expect(leaked(home)).toEqual([])
  })
  test('CRM_LOCAL=1 alone fails with the same guidance, no files', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const env: Record<string, string> = {
      ...process.env, HOME: home, CRM_LOCAL: '1', NO_COLOR: '1',
    } as Record<string, string>
    for (const k of ['CRM_SERVER', 'CRM_TOKEN', 'CRM_CONFIG', 'CRM_DB']) {
      delete env[k]
    }
    const p = Bun.spawnSync(['bun', 'run', 'src/cli.ts', 'contact', 'list'], {
      cwd: join(import.meta.dir, '..'), env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(p.exitCode).toBe(1)
    expect((p.stderr.toString() + p.stdout.toString())).toContain("run 'crm login")
    expect(leaked(home)).toEqual([])
  })
  test('explicit --db still works', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    const r = cli(home, [
      '--db', join(home, 'explicit.db'),
      'contact', 'add', '--name', 'Local', '--email', 'l@x.io',
    ])
    expect(r.code).toBe(0)
  })
  test('user-declared [database] in config still enables local mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'crm-zf-'))
    writeFileSync(
      join(home, 'crm.toml'),
      `[database]\npath = "${join(home, 'declared.db')}"\n`,
    )
    const r = cli(home, [
      '--config', join(home, 'crm.toml'),
      'contact', 'add', '--name', 'Declared', '--email', 'd@x.io',
    ])
    expect(r.code).toBe(0)
  })
})
```

- [ ] **Step 2: Run** `bun test test/zero-footprint.test.ts -t 'implicit' > /tmp/t2red.txt 2>&1` — the guidance/CRM_LOCAL cases FAIL (today they create a local db and exit 0).
- [ ] **Step 3: Implementation.** In `remoteEndpoint()` replace cases 3–4 (keep 1–2 byte-identical). After `const config = loadConfig(...)` and the `[remote]` block, `config.database.path` already merges `--db` and `CRM_DB`:

```ts
  // 3. Explicit local intent: --db (already merged into config.database.path)
  //    always means local; --local/CRM_LOCAL need a resolvable path.
  if (gDb || config.database.path) {
    if (!forcedLocal && !gDb) {
      // a bare user-declared [database] only enables local when nothing
      // claimed the session below — fall through to the session check first
    } else {
      return null
    }
  }
  const sess = loadSession()
  if (sess?.server && sess.token) {
    if (envServer && envServer !== sess.server) {
      die(`Error: CRM_SERVER (${envServer}) does not match the logged-in server (${sess.server}) — log in to ${envServer}, unset CRM_SERVER, or use --local`)
    }
    return { server: sess.server, insecure: envInsecure || sess.insecure === true }
  }
  if (forcedLocal && !config.database.path) {
    die(NOT_CONNECTED)
  }
  // 4. Explicit local only: a [database] path the user wrote themselves.
  if (config.database.path) {
    return null
  }
  // 5. No server, no declared database: there is no implicit local mode.
  die(NOT_CONNECTED)
```

Then simplify: the first block reduces to `if (gDb) { return null }` plus `if (forcedLocal) { if (!config.database.path) die(NOT_CONNECTED); return null }` placed **before** the session check (both are explicit local intent that overrides a session, matching today's `--db` behavior and the logged-in note in `dispatch()`). Clean final order: `gDb → forcedLocal(need path) → session → config.database.path → die`. Update the file's header docstring to the 5-step contract from `spec/client-repl.md` A1. In `getLocalCtx()` and `localOnly()`, guard `config.database.path` with `NEEDS_DB` before `openDB` (defense in depth; unreachable through the guards above but enforced).
- [ ] **Step 4: Run** the whole file green: `bun test test/zero-footprint.test.ts > /tmp/t2.txt 2>&1`.
- [ ] **Step 5: Mutation check** — comment out the `die(NOT_CONNECTED)` (return null as before), guidance tests go red; restore; green. Commit: `git commit -m "feat(client): no implicit local mode — unconfigured data commands fail with guidance"`.

---

### Task 3: Rewrite the mode-contract suite for the new five-step order

**Files:**
- Modify: `test/enterprise/mode-contract.test.ts`
- Test: same file (it is the contract)

**Interfaces:**
- Consumes: `startServer`/`bootstrapOwner` from `test/enterprise/helpers.ts`; copy constants.
- Produces: the authoritative living documentation of the contract for sub-project C.

- [ ] **Step 1: Rewrite cases** (keep the spawn helper and `homeWithSession()`):
  1. session, no flags → targets server (unchanged case).
  2. `--local` **without** any db path → exit 1, contains `run 'crm login`.
  3. `--local --db <file>` → local write succeeds **and** stderr contains the logged-in note `note: local mode — you are logged in to` (unchanged behavior).
  4. bare `--db <file>` (no `--local`) → local + note (unchanged).
  5. session + config `[database]` declared → **session wins** (targets server): write a `crm.toml` with `[database] path` into the HOME, set `CRM_CONFIG`, run `contact add`, then assert the name is in the server (`audit list` via token) and **not** in that db file (`sqlite` file absent or lacks the row).
  6. `CRM_SERVER` mismatch die case (unchanged).
- [ ] **Step 2: Run** `bun test test/enterprise/mode-contract.test.ts > /tmp/t3.txt 2>&1` — adapt expectations only where the new contract genuinely changed (cases 2/5); cases 3/4/6 must pass untouched, proving the overrides survived.
- [ ] **Step 3: Commit** `git commit -m "test(contract): mode contract rewritten for explicit-local-only resolution order"`.

---

### Task 4: Copy, docs, console, downloads

**Files:**
- Modify: `spec/enterprise.md` (mode-contract paragraph), `README.md` (quickstart: "installed but not logged in" note), `skills/SKILL.md` (mode section + new error table row: exit 1 not-connected, exit 1 needs-db), `src/commands/serve.ts` (`--init` success text mentions the `[database]` line and `crm login` for clients), `src/server/console.ts` (Clients tab: add line `Run: crm login <server>` next to the downloads).

**Interfaces:** Consumes: fixed copy from Global Constraints. Produces: nothing consumed later.

- [ ] **Step 1: Apply doc/copy edits** (English; match each file's tone; SKILL.md keeps its command-table format).
- [ ] **Step 2: Verify** console test still green: `bun test test/enterprise/admin-console.test.ts > /tmp/t4.txt 2>&1`; `grep -rn "crm.db" README.md skills/SKILL.md spec/*.md` shows no doc claiming an implicit default db path (serve/examples with explicit paths are fine).
- [ ] **Step 3: Commit** `git commit -m "docs: zero-footprint contract copy in README, SKILL, spec, console"`.

---

### Task 5: Verification pass (no features)

- [ ] `bun run check-types` → 0 errors; `npx ultracite check` clean.
- [ ] Targeted: `bun test test/zero-footprint.test.ts test/config.test.ts test/enterprise/mode-contract.test.ts test/enterprise/serve.test.ts test/enterprise/backup.test.ts test/enterprise/admin-console.test.ts test/enterprise/rbac.test.ts test/enterprise/auth.test.ts > /tmp/t5.txt 2>&1` → 0 fail (under external load, triage by "timed out after 5000ms" signature before suspecting regressions).
- [ ] `bun run build` clean; smoke the built client: `HOME=$(mktemp -d) bun dist/cli.js contact list` → NOT_CONNECTED copy, exit 1.
- [ ] Full suite on an idle moment; commit any stragglers. Push `enterprise/base`.

## Spec coverage self-check

A1 order → Tasks 2+3; A2 classes → Tasks 1+2; A3 whitelist → Task 2 (`leaked()` file-walk assertions on both failure paths); A4 touch points → Tasks 1–4; A5 tests → Tasks 1–3, 5.
