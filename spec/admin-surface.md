# Admin Surface Completion (Sub-project B)

Status: spec (2026-10-05); plan to follow in
`docs/superpowers/plans/2026-10-05-admin-surface.md`.

## Background

Sub-projects A (zero-footprint client) and C (human REPL) are shipped. The
client-repl spec defined B as: *"password/role management, audit filters +
diff view, server status, dashboard"* — and left it to its own spec.

Inventory of the as-built admin surface (verified against the code):

| Capability | State |
|---|---|
| `admin user create/list/set-role/disable/enable` | ✅ CLI + RPC + console (create/enable/disable only) |
| `admin token create/list/revoke` (`--expires`) | ✅ CLI + RPC + console |
| Login: local argon2id + lockout + rate limit + audit rows | ✅ |
| LDAP JIT + group→role | ✅ |
| `auth.password_min_length` | ✅ |
| Password reset / self-service change / first-login force / expiry | ❌ none (`NO_RESET` verified) |
| `admin.user.delete` | ❌ |
| Audit before/after snapshots | ✅ recorded (`auditSnapshot`, both RPC + local paths) |
| Audit diff *display*, console audit filters | ❌ CLI has list/verify/export only; console Audit tab is unfiltered |
| Server status RPC / `crm status` / console dashboard | ❌ (`/healthz` + `backup.status` only) |

The spec's own auth section already promised *"enforces a first-login reset"*
and *"optional expiry"* — both unimplemented. This spec closes the loop.

## Scope

| Sub-feature | Content | State |
|---|---|---|
| **B1** | Password management: admin reset, self-service change, must-change flow, optional expiry | plan-ready |
| **B2** | `admin.user.delete` (cascade tokens, owner refs → NULL, self-guard) | plan-ready |
| **B3** | Console Users tab completion: role select, reset, delete | plan-ready |
| **B4** | Audit diff view (CLI `show`/`--diff`) + console Audit filters + diff | plan-ready |
| **B5** | `server.status` RPC + `crm status` + console Dashboard tab | plan-ready |

Machine-surface rule (unchanged from A/C): everything ships as flat-argv CLI
+ RPC first; the console and the REPL are presentation layers over the same
`handleCommand` / `dispatch()` paths — no new business logic per surface.

---

## B1 — Password management

### B1.1 Schema
`users` gains two columns (probe + guarded `ALTER` in `migrateSchema`, same
pattern as the `version` columns):

- `must_change_password INTEGER NOT NULL DEFAULT 0`
- `password_changed_at TEXT` (ISO; NULL = legacy/never)

Set on: `admin.bootstrap`, `admin.user.create`, `admin.user.reset-password`,
`auth.change-password`.

### B1.2 `admin.user.reset-password { username }`
- minRole `admin` (owner + admin). Writes: new argon2id hash (random
  temporary password, satisfies `password_min_length`),
  `must_change_password = 1`, `password_changed_at = now`, and **clears the
  lockout** (`failed_attempts = 0`, `locked_until = null`) — a reset is the
  un-lock path.
- Returns `{ username, temporary_password }` — the raw password is shown
  exactly once (CLI prints it; console displays it in a modal). Only its
  argon2id hash is stored.
- CLI: `crm admin user reset-password --username <name>` (option form —
  same machine-surface convention as the sibling admin user commands).
- Audit row: `admin.user.reset-password`, entity `user/<id>`.

### B1.3 `auth.change-password { current, new }`
- Authenticated session (any role — it is self-service). Verifies
  `current` against the stored hash.
- Policy: `new` meets `password_min_length`; `new !== current`.
- **LDAP-source users are refused** with `AUTH:
  "directory is the password authority for this account"` — the CRM never
  touches directory passwords.
- Success: new hash, `password_changed_at = now`, `must_change_password = 0`.
  Audit `auth.change-password` (entity `user/<id>`). Failure (wrong current):
  audit `auth.change-password-failed`, error `AUTH: current password
  incorrect`. A wrong *current* is **not** a login attempt — no lockout
  counter movement (the caller already holds a session).

### B1.4 Must-change login flow
`auth.login` result gains `must_change: boolean` — true when
`must_change_password = 1` **or** the password is expired (B1.5). The token
is still issued (post-login force, not login block).

Client behavior:

- **`crm login` (CLI)**: after saving the session, if `must_change` → run
  the change flow immediately (secret prompt for the new password on the
  TTY; calls `auth.change-password` with the just-issued token). If the
  prompt is unavailable (non-TTY without piped secret) or the change fails,
  exit with guidance: `password must be changed — run crm password change`.
  The session is saved either way (the user can fix it later).
- **REPL login wizard**: same flow — after `login`, the wizard asks for the
  new password as its final question when `must_change`; failure keeps the
  session and prints the same guidance (the session continues; the flag is
  re-checked on the next login).
- **Console**: login response carries `must_change`; the console shows a
  change-password modal that must succeed (or be dismissed with the warning
  banner) before the tabs are enabled.
- **`crm password change`** (new command): remote-mode only; prompts
  current + new (secrets, TTY), calls `auth.change-password`. Local mode
  fails clean: `password management is a server feature — run it against the
  server (crm login first) or use --local for data commands`.

### B1.5 Optional expiry
Config `auth.password_max_age_days` (default `0` = off; added to the
`[auth]` config section + config trust tests + console config view).
Expired = `password_changed_at` set and older than the max age → login
returns `must_change: true`. Legacy rows (`password_changed_at = NULL`)
force-change on first login **when the setting is enabled** — one-time
migration friction, documented here.

### B1.6 Audit
New rows: `admin.user.reset-password`, `auth.change-password`,
`auth.change-password-failed` (the last one carries the failure reason in
`after_json`, same shape as `auth.login-failed`).

## B2 — User deletion

`admin.user.delete { username }`:

- minRole `admin`; **cannot delete your own account** (`FORBIDDEN: cannot
  delete your own account`) — no self-service off-ramp, deliberately.
- Tokens cascade (existing FK `ON DELETE CASCADE`).
- Business rows are **kept**: `contacts.owner` / `deals.owner` pointing at
  the username are set to NULL (ownership data survives the person; erasure
  is a P6 data-subject question, not this one).
- Audit row: `admin.user.delete`, entity `user/<id>`, `before_json` = the
  public user row.
- CLI: `crm admin user delete --username <name>` (typed confirmation, not a flag —
  the username must be re-typed).
- Console: delete button, `confirm()` gate (B3).

## B3 — Console Users tab completion

The Users tab renders, per row (owner's own row included, with delete
disabled on it):

- **Role select** (owner/admin/writer/reader) → `admin.user.set-role`
- **Reset** → `admin.user.reset-password`, one-time password shown in a
  modal (copyable, "shown once" note)
- **Delete** (B2; `confirm()`)

Existing create/enable/disable stay. All calls go through the existing
`/api/call` — RBAC + audit are inherited, no new console auth surface.

## B4 — Audit diff view + console filters

The snapshots already exist in the rows (`before_json` / `after_json`,
full-row JSON; insert = before NULL, delete = after NULL). B4 is
**display-only** — zero new write paths:

- **`src/lib/diff.ts`** — pure `jsonDiff(before: object|null,
  after: object|null): FieldDiff[]` (added / removed / changed, with
  old→new values; null handling = insert/delete). Unit-tested as a pure
  function (the repo's mutation-verification culture applies).
- **CLI `crm audit show <seq>`** — one row: actor/action/entity/source/ip,
  then the human field diff (`email: a@x → b@x`; `+ field` / `- field` for
  insert/delete rows). `--json` prints the full raw row.
- **CLI `crm audit list --diff`** — appends a one-line compact diff under
  each row (changed fields only; insert/delete marked).
- **Console Audit tab** — filter inputs (actor, action, since → the
  existing `audit.list` params) and click-to-expand rows showing the same
  field diff (client-side reuse of the diff logic in the console HTML).
- No change to `audit.list` RPC shape (rows already carry the snapshots).

## B5 — Server status + dashboard

- **`server.status` RPC** — minRole `reader` (liveness/overview, not
  sensitive: no config, no secrets, no host paths):
  `{ server_version, now, connections, users, tokens, db_bytes,
  audit_seq, backup: { last_sync_at, in_sync } }`.
- **CLI `crm status`** — remote mode: formatted key/value view of
  `server.status`. Local mode fails clean per the mode contract
  (`not connected — run 'crm login <server>' …`).
- **Console Dashboard tab** (first tab): cards for version, users, tokens,
  audit seq, last backup sync, connections; refresh button + 30 s
  auto-refresh; reuses `server.status`.

## Out of scope (recorded, not built)

- Multi-tenant, OIDC device-code, fine-grained token scopes, HA/replication
  posture beyond litestream backup (all tracked elsewhere).
- Data-subject export/erasure (P6 "right-to-erasure"): deleting a user
  keeps their authored data; true erasure is a separate feature.
- Per-user session inventory UI: `admin.token.list`/`revoke` already
  covers session tokens (`session-<ulid>` names).
- Password history, complexity policy beyond min-length, email-based
  reset links (no outbound email to unverified addresses in this scope).

## Acceptance (gate list for the plan)

1. Reset → login → `must_change` forced → change → next login clean;
   temporary password never reused, never stored raw.
2. `crm password change` over remote works; LDAP user refused; wrong
   current → `auth.change-password-failed` audit row + no lockout counter
   movement.
3. `password_max_age_days` expiry forces change on login; `0` disables.
4. Delete: tokens cascade, owner refs NULL, self-delete refused, audit row.
5. Console: role/reset/delete all live over `/api/call`; reader console is
   refused (existing RBAC, no new checks needed).
6. `audit show`/`--diff`/console expand render real before/after for an
   edit, insert, and delete; diff is a pure tested function.
7. `crm status` + dashboard show live counts; `server.status` is
   reader-accessible and carries no config/secrets/paths.
8. Full suite green (767+ baseline; only the known email-sandbox reds),
   tsc 0, ultracite 0, per-task mutation gate.
