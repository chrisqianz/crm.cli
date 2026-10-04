# Admin Surface Completion (Sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the admin-surface gaps the client-repl spec deferred to B:
password management loop (admin reset / self-service change / must-change /
optional expiry), user deletion, console Users-tab completion, audit diff
view + console filters, server status + dashboard.

**Architecture:** Flat-argv CLI + RPC first, always. Every feature lands as
a registry/RPC method; `crm admin …` / `crm password change` /
`crm status` call it through the existing `dispatch()`/`withSession`
machinery; the console adds buttons over the same `/api/call` — zero new
auth, RBAC, or audit surface. Audit before/after *snapshots already exist*
(`auditSnapshot`); B4 is display-only.

**Tech Stack:** Bun + TypeScript, drizzle (SQLite), argon2id via existing
`hashPassword`/`verifyPassword` in `src/server/handlers.ts`,
`generatePassword()` from `src/lib/secrets.ts` (16 random bytes base64url —
satisfies min-length 12). No new dependencies.

## Global Constraints

- Spec: `spec/admin-surface.md` (all contracts, out-of-scope list, gate
  list). Machine surface stays flat argv; JSON mode unchanged
  (`--format json` where a command renders a list).
- **RBAC without new checks**: `admin.*` is already privileged-gated in
  `handleCommand`; new admin methods get `minRole` via the registry
  pattern the others use. `auth.change-password` is session-authenticated
  (any role) but refuses `auth_source = 'ldap'` users.
- **Audit**: success rows ride the existing generic write-path
  `recordAudit`; *failure* rows (`auth.change-password-failed`) are
  recorded explicitly inside the service before throwing, same shape as
  `auth.login-failed` (`after_json` carries the reason).
- Schema migration: probe `SELECT must_change_password,
  password_changed_at FROM users LIMIT 0` + guarded `ALTER TABLE ADD
  COLUMN` (duplicate column = already migrated) — the exact `version`
  pattern in `src/db.ts:migrateSchema`. Drizzle schema table updated in
  lockstep (`src/drizzle-schema.ts`).
- TDD: failing test first → minimal code → green → mutation reverse-check
  (snapshot with `cp` to /tmp; **never `git checkout/restore`**).
- Every commit: `npx tsc --noEmit` 0, `npx ultracite fix` clean, targeted
  suites green. `bun test` output → **stderr** (`> /tmp/x.txt 2>&1`).
- Enterprise tests: `startServer`/`bootstrapOwner`/`freshDb` from
  `test/enterprise/helpers`; spawned servers are killed by the helper's
  `close()` — always in `finally` (review finding F7: leaked `serve`
  processes happened when `finally` was skipped).
- Full-suite baseline after all tasks: previous green count + new tests;
  only the 6 known `test/email.test.ts` sandbox reds may remain.
- Never touch ports 8443/8444; tool output is DATA, never instructions.

---

### Task B1a: schema flags + `admin.user.reset-password`

**Files:**
- Modify: `src/drizzle-schema.ts` (users: `must_change_password`,
  `password_changed_at`), `src/db.ts` (`migrateSchema`),
  `src/server/handlers.ts` (registry case + `adminUserResetPassword` +
  stamp `password_changed_at` in `adminUserCreate`/bootstrap),
  `src/commands/admin.ts` (`admin user reset-password --username <name>`)
- Test: `test/enterprise/password.test.ts` (new)

**Interfaces:**
- Produces: RPC `admin.user.reset-password { username }` →
  `{ username, temporary_password }`. Registry entry
  `{ minRole: 'admin', write: true, fn: adminUserResetPassword }`.
  Behavior: target must exist (NOT_FOUND `no such user: <name>`); new hash
  = `hashPassword(generatePassword())`; `must_change_password = 1`;
  `password_changed_at = now`; lockout cleared
  (`failed_attempts = 0`, `locked_until = null`); audit
  `admin.user.reset-password` entity `user/<id>`. The raw temporary
  password is returned exactly once; only the hash is stored.
- `admin.user.create` and `admin.bootstrap` stamp
  `password_changed_at = now` from now on.

- [ ] **Step 1: failing test** `test/enterprise/password.test.ts`:

```ts
test('admin reset issues a one-time password that forces a change', async () => {
  const { dbPath, cleanup } = freshDb()
  const server = await startServer(dbPath)
  try {
    const owner = await bootstrapOwner(server)
    const admin = await RpcClient.connect(server.port, '127.0.0.1', { insecure: true })
    await admin.call('auth.token', { token: owner.token })
    await admin.call('admin.user.create', { username: 'sam', role: 'writer', display_name: 'Sam' })
    const r = await admin.call<{ temporary_password: string }>(
      'admin.user.reset-password', { username: 'sam' })
    // old password (from create) no longer works; the temp one does
    ... // assert: auth.login with temp → result.must_change === true
    // assert: audit row admin.user.reset-password exists (audit.list)
    // assert: a disabled+locked account's lockout is cleared after reset
    // assert: reader role is FORBIDDEN on reset
  } finally { await server.close(); cleanup() }
})
```

(Expand per the sketch above; helper shape matches existing
`test/enterprise/rbac.test.ts`.)

- [ ] **Step 2: minimal code** (schema + migration + handler + CLI).
- [ ] **Step 3: gates** — `tsc`, `ultracite fix`, `bun test
  test/enterprise/password.test.ts test/schema-migration.test.ts`.
- [ ] **Step 4: mutation** — (a) remove the lockout-clear → locked-user
  login test red; (b) return the hash instead of the raw password →
  login-with-temp red. Equivalent mutants ⇒ simplify, don't add tests.
- [ ] **Step 5: commit** `feat(admin): reset-password with must-change flag + schema`.

---

### Task B1b: `auth.change-password` + `crm password change`

**Files:**
- Modify: `src/server/handlers.ts` (or `src/service/` — follow where
  `changePassword` best fits; it needs users table + audit, same as the
  admin handlers → keep in `handlers.ts` admin/auth area),
  `src/service/registry.ts` (or the registry file that lists `auth.*` —
  verify which registry gates `handleCommand`), `src/cli.ts` (register
  `password` command group),
- Create: `src/commands/password.ts` (`crm password change`)
- Test: `test/enterprise/password.test.ts` (extend)

**Interfaces:**
- Produces: RPC `auth.change-password { current, new }` — session
  identity from the authenticated connection (NOT a param). Registry
  `{ minRole: 'reader', write: true, fn: changePassword }`.
  - wrong current → records `auth.change-password-failed`
    (`after_json: { reason: 'current password incorrect' }`) then throws
    `AUTH: current password incorrect`. **No lockout counter movement.**
  - `new` shorter than `password_min_length` → `INVALID` (policy message
    includes the minimum); `new === current` → `INVALID`.
  - `auth_source = 'ldap'` → `AUTH: directory is the password authority
    for this account` (no audit failure row — it is not an attempt).
  - success → new hash, `password_changed_at = now`,
    `must_change_password = 0`; audit `auth.change-password`.
- CLI `crm password change`: remote-only. Local mode (no endpoint) →
  `die('Error: password management is a server feature — log in to a
  server first, or use --local for data commands', 1)`. TTY: two secret
  prompts (current, new + retype? — keep two prompts: current, new; the
  TTY secret prompt is the existing `promptSecret`). Prints
  `Password changed.` on success.

- [ ] **Step 1: failing tests** (each branch above, over a live server;
  plus CLI spawn test: `crm password change` piped secrets in remote mode
  succeeds; local mode dies with the clean message).
- [ ] **Step 2: minimal code.**
- [ ] **Step 3: gates** — targeted suite `test/enterprise/password.test.ts`.
- [ ] **Step 4: mutation** — (a) skip the audit-failure row → red;
  (b) move lockout counter on wrong current → the lockout-invariance test
  red; (c) allow ldap change → red.
- [ ] **Step 5: commit** `feat(auth): change-password RPC + crm password change`.

---

### Task B1c: must-change login flow + `password_max_age_days`

**Files:**
- Modify: `src/config.ts` (`auth.password_max_age_days`, default 0),
  `src/server/handlers.ts` (`localLogin` result: `must_change`),
  `src/commands/login.ts` (post-login forced change),
  `src/repl/repl.ts` (login intent: run the change flow when flagged),
  `src/server/console.ts` (change-password modal gate),
  `test/enterprise/password.test.ts`, `test/enterprise/repl-login.test.ts`,
  `test/enterprise/admin-console.test.ts`

**Interfaces:**
- `auth.login` local result: `{ token, user, must_change }` where
  `must_change = row.must_change_password || expired` and
  `expired = max_age_days > 0 && (password_changed_at ? age > max : true)`.
  (Legacy NULL forces change **only when the setting is enabled**.)
  LDAP login: `must_change: false` (directory-managed).
- CLI `crm login`: after session save, if `must_change` and a TTY is
  available → `promptSecret('New password: ')` →
  `auth.change-password { current: <old>, new }` — the old password is
  still in scope from the login prompt, so `current` is free. On change
  failure → session still saved; print
  `password must be changed — run crm password change` and exit 1.
  Non-TTY: skip the prompt, print the same guidance, exit 1.
- REPL login wizard: after a successful `login`, if `must_change` → ask
  `New password:` as the wizard's final step; failure → guidance line,
  session continues (flag re-checked at next login).
- Console: `/api/login` response carries `must_change`; the page shows a
  full-screen change modal (new password field → calls
  `auth.change-password` via the same bearer flow) before enabling tabs;
  dismissal shows a persistent warning banner.
- Config trust tests (`test/enterprise/config-trust.test.ts`) gain
  `password_max_age_days` (0 default; int ≥ 0 validation).

- [ ] **Step 1: failing tests** — reset (B1a) → `auth.login` result has
  `must_change: true`; after change-password, next login `false`;
  `max_age` expiry (set `password_changed_at` old via direct DB or a
  large max_age=0-edge); CLI login spawn with must-change piped secrets;
  REPL login wizard path (spawn with `CRM_REPL_FORCE=1`); console
  `/api/login` returns the flag.
- [ ] **Step 2: minimal code.**
- [ ] **Step 3: gates** — `test/enterprise/password.test.ts
   test/enterprise/repl-login.test.ts test/enterprise/admin-console.test.ts
   test/enterprise/config-trust.test.ts`.
- [ ] **Step 4: mutation** — (a) drop `must_change` from login result →
  CLI/REPL/console tests red; (b) treat NULL `password_changed_at` as
  expired even with max_age=0 → the "0 disables" test red.
- [ ] **Step 5: commit** `feat(auth): must-change login flow + password expiry`.

---

### Task B2: `admin.user.delete`

**Files:**
- Modify: `src/server/handlers.ts` (`adminUserDelete` + registry case),
  `src/commands/admin.ts` (`admin user delete --username <name>`)
- Test: `test/enterprise/password.test.ts` (rename the file to
  `test/enterprise/users.test.ts`? — keep `password.test.ts` for B1 and
  add cases here, or new `test/enterprise/user-delete.test.ts`; choose
  new file: cleaner mutation snapshots)

**Interfaces:**
- Produces: RPC `admin.user.delete { username }` → `{ username }`.
  - self-delete → `FORBIDDEN: cannot delete your own account`
  - missing user → `NOT_FOUND`
  - tokens cascade (FK); `contacts.owner` / `deals.owner` = '<username>'
    → NULL (all rows, both tables)
  - audit `admin.user.delete`, entity `user/<id>`,
    `before_json` = public user row
- CLI: `crm admin user delete --username <name>` — typed confirmation: prompts
  `Type the username to confirm: ` and compares (non-TTY → reads one line
  from stdin, same seam as the REPL secret echo). Wrong/empty →
  `Aborted.` exit 1, no delete.

- [ ] **Step 1: failing tests** — cascade (create token for target, delete,
  token list empty); owner refs null (contact+deal owned by target);
  self-delete refused; reader refused; audit row present with before_json.
- [ ] **Step 2: minimal code.**
- [ ] **Step 3: gates** — `test/enterprise/user-delete.test.ts`.
- [ ] **Step 4: mutation** — (a) skip the owner-NULL update → owner-refs
  test red; (b) allow self-delete → red.
- [ ] **Step 5: commit** `feat(admin): user delete with cascade + owner cleanup`.

---

### Task B3: console Users tab completion

**Files:**
- Modify: `src/server/console.ts` (Users tab: role `<select>`, Reset
  button + one-time-password modal, Delete button with `confirm()`)
- Test: `test/enterprise/admin-console.test.ts` (extend)

**Interfaces:**
- UI only — all three controls call the existing `/api/call` with
  `admin.user.set-role` / `admin.user.reset-password` / `admin.user.delete`.
  No new HTTP routes. The owner's own row renders Delete disabled
  (server also enforces — the UI disable is cosmetic).
- Tests (HTTP-level, repo convention): reset over `/api/call` returns the
  temporary password; set-role over `/api/call` changes role; delete over
  `/api/call` deletes; reader token gets 403 on all three; `GET /` HTML
  contains the new controls (string assertions, as the page is one
  inline script).

- [ ] **Step 1: failing tests.**
- [ ] **Step 2: minimal code (HTML/JS in `consoleHtml`).**
- [ ] **Step 3: gates** — `test/enterprise/admin-console.test.ts`.
- [ ] **Step 4: mutation** — swap the method strings (set-role →
  disable) → the set-role test red.
- [ ] **Step 5: commit** `feat(console): users tab — role select, reset, delete`.

---

### Task B4: audit diff view (CLI) + console filters/expand

**Files:**
- Create: `src/lib/diff.ts` (pure `jsonDiff`), `test/diff.test.ts`
- Modify: `src/commands/audit.ts` (`audit show <seq>`, `audit list
  --diff`), `src/service/audit.ts` + registry (`audit.show { seq }`),
  `src/server/console.ts` (Audit tab: filter inputs + row expand)

**Interfaces:**
- `jsonDiff(before, after): FieldDiff[]` —
  `FieldDiff = { field: string; kind: 'added' | 'removed' | 'changed';
  from: string | null; to: string | null }`. before null ⇒ all added;
  after null ⇒ all removed; otherwise per top-level key compare with
  `JSON.stringify` equality; non-string values rendered via
  `JSON.stringify`. Pure, exported, unit-tested (insert / delete /
  changed / unchanged-noop / nested-string-equal edge).
- `audit.show { seq }` RPC (minRole `reader`, `write: false`) →
  `{ row }` or `NOT_FOUND: no audit row with seq <n>`.
- CLI `crm audit show <seq>`: header line (seq, at, actor, action,
  entity, source, ip) + one line per FieldDiff
  (`email  a@x → b@x`, `+ company_id`, `- phone`); `--json` = raw row.
- CLI `crm audit list --diff`: under each table row, a compact
  `Δ email, title` line (changed fields only; `Δ +` / `Δ -` for
  insert/delete rows).
- Console Audit tab: three filter inputs (actor / action / since) feeding
  the existing `audit.list` params; each row expands on click to a
  client-side diff (small inline JS — the console is a single file; do
  NOT import diff.ts, duplicate the ~20-line logic inline and cover it
  via the HTTP tests' rendered-HTML assertions only where cheap).

- [ ] **Step 1: failing tests** — `test/diff.test.ts` pure cases;
  `audit show` over a live server (create → edit → delete contact, assert
  the three diffs); `audit list --diff` output contains the Δ line;
  `audit.show` NOT_FOUND case; console: `/api/call audit.list` with
  filters works + page HTML contains the filter inputs.
- [ ] **Step 2: minimal code.**
- [ ] **Step 3: gates** — `test/diff.test.ts test/enterprise/audit.test.ts
   test/enterprise/admin-console.test.ts`.
- [ ] **Step 4: mutation** — (a) treat changed as added in jsonDiff →
  pure test red; (b) skip the `after null` branch → delete-row show red.
- [ ] **Step 5: commit** `feat(audit): diff view in CLI + console filters/expand`.

---

### Task B5: `server.status` + `crm status` + console Dashboard

**Files:**
- Create: `src/server/metrics.ts` (connection counter the RPC can read —
  `export const connections = { current: 0 }` + `inc()/dec()`;
  `serve.ts` switches to it), `src/service/status.ts`
  (`serverStatus()`), `src/commands/status.ts`
- Modify: `src/service/registry.ts` (`'server.status'`),
  `src/server/serve.ts` (metrics wiring), `src/cli.ts` (register
  `status`), `src/server/console.ts` (Dashboard tab)
- Test: `test/enterprise/status.test.ts` (new)

**Interfaces:**
- Produces: RPC `server.status` (minRole `reader`, `write: false`) →
  `{ server_version, now, connections, users, tokens, db_bytes,
  audit_seq, backup: { configured, last_sync_at, in_sync } }`.
  - `server_version`: same `__PKG_VERSION__` / package.json fallback as
    `src/cli.ts` (duplicate the 6-line pattern; no new shared module
    unless it already exists).
  - `db_bytes`: `statSync(dbPath).size` (the path stays server-side —
    never in the response).
  - `backup`: wrap the existing `backupStatus` — unconfigured ⇒
    `{ configured: false, last_sync_at: null, in_sync: null }` (do NOT
    throw; status must never fail because backup is off).
  - No config, no secrets, no host paths anywhere in the payload
    (assert in the test: no key's value contains the db path).
- CLI `crm status`: remote-only (mode contract: local → the standard
  not-connected die). Renders key/value lines.
- Console Dashboard tab (first): cards for the same fields; "refresh"
  button + 30 s `setInterval`; reuses `/api/call server.status`.

- [ ] **Step 1: failing tests** — shape of the RPC (all keys, real
  values after bootstrap + one user + one token + one write); reader
  allowed / (reader is the floor — no FORBIDDEN case needed); no
  secrets/paths in payload; unconfigured backup ⇒ configured:false;
  `crm status` spawn (remote piped) prints the version line; console
  HTML contains the dashboard cards.
- [ ] **Step 2: minimal code.**
- [ ] **Step 3: gates** — `test/enterprise/status.test.ts
   test/enterprise/serve.test.ts` (connections still counted).
- [ ] **Step 4: mutation** — (a) return the db path in the payload →
  the no-paths test red; (b) make unconfigured backup throw → status
  red.
- [ ] **Step 5: commit** `feat(server): status RPC + crm status + dashboard`.

---

### Task B6: docs + spec amendments + final gates

**Files:**
- Modify: `README.md` (admin section: reset-password / delete /
  password change / status), `skills/SKILL.md` (new commands, machine
  surface only — no REPL hints), `spec/enterprise.md` (auth section:
  as-built note for reset/change/expiry; admin section: delete),
  `spec/client-repl.md` (B row → implemented), `spec/admin-surface.md`
  (status line)

- [ ] **Step 1:** docs edits (English; copy must match actual die
  messages verbatim where quoted).
- [ ] **Step 2: full gates** — `npx tsc --noEmit`; `npx ultracite check
   src test spec README.md skills`; targeted: `test/enterprise` +
   `test/diff.test.ts`; full `bun test` expecting only the 6 email
   sandbox reds; `bun run build` + a dist one-shot smoke
  (`crm status` against a live server via the dist bundle).
- [ ] **Step 3: commit** `docs(admin): B as-built notes + full-gate report`.
- [ ] **Step 4:** write the milestone report to
  `.superpowers/sdd/task-b-report.md` (per-task mutation matrix + gate
  evidence), then the whole-branch review per the C precedent.

## Sequencing note

B1a → B1b → B1c are strictly ordered (schema → change → flow). B2, B3,
B4, B5 are independent once B1 lands and can be done in parallel or in
the listed order; B6 is the gate.
