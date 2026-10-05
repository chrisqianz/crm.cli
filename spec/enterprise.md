# Enterprise Mode — Design Decisions

> **Alignment note (2026-10-06):** `spec/alignment.md` is now the
> construction baseline where the two disagree. The product is a
> **centralized platform** (PostgreSQL 16+ at the center; SQLite is a
> dev/offline/FUSE-cache convenience, not the core) with the organization
> model in scope. The identity-model decision here (no OIDC; local
> accounts + LDAP direct) stands. See alignment §2/§5 for the full
> decision and deviation list.

This spec covers the enterprise adaptation of crm.cli: centralized deployment,
authentication, multi-user access, audit, and the remote service layer. It
builds on the foundations in `architecture.md` (single SQLite file, daemon as
the logic choke point, spec-first methodology) and does not change local-mode
behavior — with one later exception, A1: local mode exists only when you name
the database (see Mode contract below).

Repo forked from `dzhng/crm.cli` (MIT) to `chrisqianz/crm.cli`. npm package
renamed to `@chrisqianz/crm.cli`. Upstream sync: monthly `git fetch upstream`,
no expectation of active upstream development.

## Deployment model: one codebase, two forms

Local mode (today) and enterprise mode (new) share all business logic.

```
Local mode (explicit):
  crm --db ./crm.db contact add ...  →  opens the named file directly (stateless process)

Enterprise mode (new):
  crm serve                    →  long-running daemon: DB + auth + audit + search, one process
  crm contact add ...         →  thin client, identical command surface, talks to server
                                 (CRM_SERVER+CRM_TOKEN env, --remote, [remote] config, or a
                                  saved session; local mode is opt-in — you name the database
                                  with --db, CRM_DB or a config [database] path. Nothing is
                                  invented: no target means no write, see Mode contract below)
```

Reasoning:

1. **The daemon already is the choke point.** `fuse-daemon.ts` centralizes all
   validation, normalization, search, and writes behind a newline-delimited
   JSON protocol. Enterprise mode upgrades that process from a temporary mount
   helper to a persistent service. It is not a second architecture.
2. **Local mode stays.** Personal use and offline use keep working; naming
   the database is now part of it (Mode contract below). The 450 functional
   tests continue to cover both forms because they spawn the CLI, and in
   local mode the CLI behaves exactly as it does today.
3. **No client-side business logic in remote mode.** Validation,
   normalization, dedupe, and search all run server-side. The remote CLI is a
   transport + formatter. This keeps one source of truth for behavior.

**Single tenant per deployment in v1.** One company = one server = one
database. Multi-tenant (tenant_id on every query) is explicitly out of scope —
CRM write volume does not justify it, and "one instance per company" deploys
cleanly for the target scale.

**The central database is Postgres; a file is the personal form.** "One DB
file" was true of v1 and is now the exception rather than the rule: the server
answers many clients at once, and a database it copies into a file on its own
host cannot scale past that host or survive a second writer. So `crm serve` in
a deployed topology runs on **PostgreSQL 16+** (`[database] backend =
"postgres"`, or simply `CRM_DATABASE_URL`, which states the backend as well as
the connection string); SQLite remains for local mode, offline work, and the
FUSE mount. Both forms are the same code — the dialect seam in
`spec/alignment.md` AL-1 is what makes that true rather than aspirational.
The reference stack is [`docker-compose.yml`](../docker-compose.yml): the
database service plus the server, with the server waiting for Postgres to be
*ready* (not merely started) before it creates schema.

## Service layer: `crm serve`

- **Transport:** TCP + TLS (node:crypto). Port 8443 default, configurable.
  Certs: self-signed by default (good enough for internal use), accepts
  enterprise CA certs via config.
- **Protocol:** the existing NDJSON protocol, extended. FUSE bridge clients
  keep using `getattr/readdir/read/write/unlink`; CLI clients use a new RPC
  frame:

  ```json
  → {"id": 1, "method": "contact.add", "params": {"name": "Jane", ...}}
  ← {"id": 1, "result": {...}}
  ← {"id": 1, "error": {"code": "CONFLICT", "message": "...", "details": {...}}}
  ```

  Error codes: `AUTH`, `FORBIDDEN`, `INVALID`, `NOT_FOUND`, `CONFLICT`,
  `INTERNAL`. Machine-readable, same discipline as the existing FUSE errno
  mapping — agents can branch on codes.
- **Limits:** max message size, max concurrent connections per IP, idle
  timeout. NDJSON framing is bounded; the daemon parses one line per read.
- **Health:** the daemon answers `GET /healthz` on the TLS port
  (protocol detection by first byte) — `{"ok": true, "version": ...,
  "db": "ok", "wal": "ok"}` — which is what an external load balancer can
  reach. The admin console's HTTP port additionally answers `GET /health`
  (backend included) and `GET /ready`, which fails while schema creation is
  still in flight. Use `/ready` for container health checks; `/healthz` for
  anything that cannot see the console port.
- **Lifecycle:** [`docker-compose.yml`](../docker-compose.yml) (Postgres +
  server) is the reference deployment; [`Dockerfile`](../Dockerfile) builds the
  image it runs, and [`deploy/crm.service`](deploy/crm.service) covers the
  single-node host install. Backup tooling follows the database: file
  replication (litestream) is the SQLite answer, and `serve` refuses to start
  with a replication target configured against a Postgres backend rather than
  report a green config that copies nothing — a scheduled `pg_dump` is the
  honest answer until AL-8 gives Postgres its own story. No auto-restart of
  sub-processes: the serve process *is* the whole server (no runtime downloads
  — `crm find` is local word-overlap scoring today).

## Authentication and identity

Two client kinds (humans, agents). Two identity sources for humans:
**local accounts** (self-hosted, zero external dependency — always
available) and **LDAP** (the enterprise unified identity: Active Directory
or any RFC 4511 directory). The `users` table remains the single authority
for role and token regardless of where the password was checked — the
directory verifies passwords; the CRM verifies identity, role, and
permission.

OIDC/SSO is deliberately **not** the core model. The target enterprises
already run a directory as their unified identity; putting an OIDC idP in
front of the CRM would add a dependency that usually does not exist. OIDC
is retained only as an optional later add-on (same `users` table, third
`auth_source`) — it changes nothing below.

**Human accounts — local (baseline):**

- The server manages its own accounts. `crm admin user create --username
  jane --display-name "Jane Doe" --role writer` provisions a user; the
  admin sets the initial password (or enforces a first-login reset).
- `crm login` prompts for username and password on the TTY — never as a
  command-line argument (no shell-history / process-list leakage). The
  server verifies against the stored **argon2id** hash and issues a session
  token.
- Brute-force defense: per-username failure counter with temporary lockout
  (`auth.lockout_threshold` default 5, `auth.lockout_minutes` default 15).
  Every attempt — success or failure — is an audit row with IP.
  (`action = auth.login` / `auth.login-failed`)
- Password policy: `auth.password_min_length` (default 12), optional
  expiry. Credentials on the client side: OS keychain (macOS Keychain /
  Linux Secret Service), fallback `~/.crm/credentials` chmod 0600.
  `crm whoami`, `crm logout`.
- Token format: `crm_` + 32 random bytes base64url. **Server stores only the
  SHA-256 hash**, never the raw token (same discipline as GitHub PATs).

**Human accounts — LDAP (enterprise unified identity):**

- The directory is the password authority; the CRM never stores or resets
  directory passwords. Server config:

  ```toml
  [auth]
  default_role = "none"        # LDAP user in no mapped group → deny by default

  [ldap]
  url = "ldaps://ldap.company.com:636"    # or ldap:// + starttls = true
  base_dn = "ou=people,dc=company,dc=com"
  bind_dn = "cn=crm-service,ou=svc,dc=company,dc=com"
  bind_password_env = "CRM_LDAP_BIND_PASSWORD"  # never inline in config
  user_filter = "(sAMAccountName={username})"  # AD-style; any RFC 2254 filter
  group_base_dn = "ou=groups,dc=company,dc=com"
  timeout_ms = 5000                      # per bind/search deadline (no ldapts default)
  connect_timeout_ms = 3000
  tls_ca_file = "/etc/crm/ldap-ca.pem"   # trust anchors; system store if unset
  tls_skip_verify = false                # verification is ON unless set true

  [ldap.roles]                       # group DN → CRM role (RBAC bridge)
  "cn=crm-admins,ou=groups,dc=company,dc=com" = "admin"
  "cn=crm-writers,ou=groups,dc=company,dc=com" = "writer"
  ```

  `[auth]` and `[ldap]` must come from a trusted config (`--config` /
  `CRM_CONFIG` / `~/.crm/config.toml`) — never from a `crm.toml` discovered by
  walking up from the cwd.

- Flow is the standard two-step: bind as service account → search under
  `base_dn` with the escaped filter → bind as the found entry to verify the
  password. All user input goes through the library's escaping — no
  hand-built LDAP strings (injection). TLS is mandatory (`ldaps://` or
  StartTLS); plain `ldap://` without StartTLS is refused at boot, and
  certificates are verified unless `tls_skip_verify` says otherwise.
- First successful directory login **JIT-provisions** the local row
  (`auth_source = "ldap"`, `ldap_dn` recorded, username/display/email from
  the entry). Role comes from group membership via `[ldap.roles]`; a user in
  no mapped group gets `auth.default_role` (default `none` = access denied —
  default-deny posture).
- When LDAP is configured, the directory wins for usernames that resolve in
  it; local accounts whose username does not resolve keep local password
  auth. Service accounts (agents) are always local and never touched by the
  directory.
- Library: `ldapts` (actively maintained). `ldapjs` is maintenance-mode and
  is not an option.
- `crm admin user disable` works locally for incident response
  (`disabled_at`) without touching the directory; re-enabling is local.
- Client experience is identical to local accounts — the same `crm login`
  prompt; the server decides which source answers.

**Agents / skills (non-interactive):**

- Env vars: `CRM_SERVER=host:port` + `CRM_TOKEN=crm_...`. This extends the
  existing override chain (`env > config file > defaults`) that already powers
  `CRM_DB`, `CRM_CONFIG`, `CRM_FORMAT` — no new mechanism, two new keys.
- Agent tokens are **service accounts** bound to a user record with a role
  and optional scope restrictions. They are always local, token-only rows
  (`auth_source = "local"`, no password). Default posture: read-only; admins
  grant `writer` per agent. One token per agent, revocable individually,
  per-token `last_used_at` for anomaly spotting.
- `crm.toml` gains a `[remote]` section (`server`, `insecure` for dev) so a
  checked-in project config can point a team at their server without env
  juggling.

**Mode contract (A1 — how a data command picks its target):**

Resolution order, first match wins:

1. `CRM_SERVER` **and** `CRM_TOKEN` are set → remote (the agent pattern).
2. `--remote` / `[remote] server` in config → remote (explicit opt-in).
3. Explicit local intent → local. An explicit `--db <file>` names a database
   and beats a saved session; `--local` / `CRM_LOCAL=1` are switches, not
   targets, so they additionally need a nameable database (`--db`, `CRM_DB` or
   a config `[database] path`) — with none of those they fail like step 5.
4. A saved session from `crm login` → remote. No session, but the user's own
   config declares `[database] path` → local.
5. Nothing named a target → fail, exit 1, no fallback. A data command says:

   ```
   Error: not connected — run 'crm login <server>' (get the server address from your admin console), or use --local/--db for the server host
   ```

   A host command — `serve`, `backup`, `mount`, `export-fs`, the commands that
   run where the database lives — says:

   ```
   Error: server-host command — needs --db or a [database] path in your config
   ```

There is no implicit local mode and no database path is ever invented: the old
`~/.crm/crm.db` default is gone from `loadConfig`, which is what makes a client
install hold no business data (spec/client-repl.md §A). `crm admin` is not a
host command: it is RPC-only and reports "Not logged in. Run 'crm login' first"
when there is no session, so `--db` never applies to it. The login-time
`--insecure` choice is stored in the session and reused, so the flag is never
retyped. `CRM_SERVER` set to a different server than the session is refused,
never mixed. Whenever local mode wins while a session is live, a stderr note
(`note: local mode — you are logged in to …`) says so.

**What is deliberately NOT in v1:** per-request auth on every frame (the
connection authenticates once; frames inherit identity), mTLS, per-command
command-level scope beyond the four roles.

## Roles and access control

Four roles, role-based only — **no per-record ACLs in v1**:

| Role | Read | Write | Users | Audit | Admin cmds |
|---|---|---|---|---|---|
| `owner` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `writer` | ✅ | ✅ | — | own | — |
| `reader` | ✅ | — | — | own | — |

- Actor identity threads through every operation. All ~20 write call sites
  (contact/company/deal/import-export + the daemon write path) and every read
  that can expose data accept `actor` and are checked against the role.
- Read filtering in v1 is role-level (reader sees all readable data, writer
  sees all). The per-record ownership model is deferred; CRM practice shows
  team-shared pipelines, not personal inboxes.

## Concurrency: optimistic locking

Today: last-write-wins, 5s busy timeout, "database locked" failure.
Enterprise mode replaces this with compare-and-set:

1. `contacts`, `companies`, `deals` each gain `version INTEGER NOT NULL
   DEFAULT 1`. (Activities are immutable — no version.)
2. Updates are `UPDATE ... WHERE id = ? AND version = ?`; zero rows affected
   → `CONFLICT` error with the current version and last modifier in `details`.
3. The FUSE full-document write path already reads the whole document before
   writing it back — the document carries `version`, so the existing write
   flow gets CAS for free.
4. **New exit code 3 = conflict.** The error model (0 ok, 1 error) gains one
   deliberate extension: conflict is a *recoverable, expected* outcome in a
   shared environment, not a failure. Agents retry-read-merge; humans get
   "your edit collided with <name> at <time> — show current?"
5. SQLite single-writer stays. Team write volume (CRM, not a trading system)
   fits comfortably under WAL + the existing busy_timeout. No multi-master,
   no replication in v1.

## Audit

- `audit_log` table, append-only: `seq` (autoincrement), `at`, `actor_id`,
  `actor_name`, `action` (e.g. `contact.add`, `deal.stage-change`,
  `import.batch`), `entity_type`, `entity_id`, `before_json` (full snapshot,
  null on insert), `after_json`, `source` (`cli-local` / `rpc` / `fuse`),
  `ip`, `prev_hash`, `row_hash`.
- **Hash chain (as-built):** `row_hash` = SHA-256 over the row's canonical
  pipe-joined content (`seq|at|actor_id|actor_name|action|entity_type|
  entity_id|before_json|after_json|source|ip|prev_hash`, nulls as `''`);
  `prev_hash` = the previous chained row's `row_hash`; the first chained row
  points at the genesis (64 zeros). Rows written before P4 (empty hashes)
  are "legacy": `verify` reports their count but excludes them from chain
  validation, so old databases upgrade cleanly. The append runs in a
  write transaction (read-last-hash + insert under one lock) so concurrent
  writers cannot fork the chain.
- Every mutation goes through one audit funnel per transport, all calling
  the same `recordAudit` (hash chain) + snapshot helpers:
  - **remote/RPC** — the server's registry handler (one funnel for all
    ~20 write methods); `before`/`after` snapshots captured around the
    service call.
  - **local** — the CLI dispatch funnel audits every registry write method
    (`source = cli-local`, actor = OS user).
  - **FUSE** — the daemon's document-write path audits `fuse.write.*`
    (actor = `fuse`).
  A failed audit record never fails the data write (best-effort, logged).
  The acting user is injected into write-method params server-side; read
  methods never receive it (so `audit list --actor` filters by name).
- `crm audit list --limit --actor --action --entity --since` and
  `crm audit verify` (walks the chain, exit 1 + first broken seq on
  tamper) round it out. `crm audit export` dumps the full chain in
  table/json/csv/tsv; retention policy is operational (WAL backup archives
  retain history).
- Note: local mode also writes audit rows (actor = OS user, source =
  `cli-local`) — the habit and the table shape are identical across modes.

## Data model additions

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- ULID
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  auth_source TEXT NOT NULL DEFAULT 'local',  -- local | ldap (| oidc later)
  password_hash TEXT,             -- argon2id; NULL for ldap / token-only rows
  ldap_dn TEXT,
  role TEXT NOT NULL DEFAULT 'reader',   -- owner|admin|writer|reader
  created_at TEXT NOT NULL,
  disabled_at TEXT                 -- soft-disable, never delete (audit refs)
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,            -- ULID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,             -- e.g. 'sales-agent-prod'
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT
);

CREATE TABLE audit_log ( /* as above */ );

-- version columns:
ALTER contacts/companies/deals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

Migrations go through the existing Drizzle flow (drizzle-kit generated,
versioned) — no hand-rolled ALTER in `serve` boot.

## Agent / skill mode

The filesystem-as-API surface stays the product's differentiator; remote mode
extends it rather than replacing it.

- **Skill content is stable.** `skills/SKILL.md` teaches the agent the command
  surface, which is byte-identical in local and remote mode. The remote skill
  variant adds exactly two sections: remote configuration (`CRM_SERVER`,
  `CRM_TOKEN`, or `[remote]` in `crm.toml`) and authentication
  (`crm whoami` before mutating).
- **The agent IS the AI layer.** Free-text intent → structured flags is the
  agent's job, per the skill. The daemon's machine-readable errors
  (`INVALID` with field-level detail, `CONFLICT` with current state) are the
  feedback loop the agent iterates on. No server-side LLM in v1.
- **Read path for agents:** `crm ... --format json` is the primary surface.
  The existing `export-fs` machinery is available later if agents want a
  browsable tree without mounting.
- Default agent posture is read-only tokens; a pipeline agent gets `writer`;
  a reporting agent never does. Admins manage this with
  `crm admin token create --user bot-pipeline --role writer --name prod`.

## Client installation

Remote mode removes the mount stack from the client entirely:

- No FUSE, no Rust toolchain, no gcc, no libfuse3-dev, no first-use
  auto-compilation. The client is one static binary (`bun build --compile`).
- `curl -fsSL <mirror>/install.sh | sh` → binary in `~/.local/bin` →
  interactive `crm login` → done. No other dependencies.
- Windows: the server-mode client gets a native Windows build (Bun compile
  target). Local mount mode remains WSL-only; that is documented, not
  blockable.
- Air-gapped / internal distribution: prebuilt tarballs per platform +
  optional internal npm registry. The client downloads nothing at runtime —
  `crm find` is local word-overlap scoring today (the README/architecture
  ONNX semantic model is not implemented in code; if it lands later, the
  model ships server-side only).
- Prebuilt FUSE/NFS bridges ship in the release for local-mode users, so
  even local mounts stop auto-compiling on first use (build matrix work,
  phase P5).

## Input ergonomics

Structured flags stay canonical (agents depend on them). Two additions:

1. **`--raw` deterministic parsing** (no LLM, no network):

   ```bash
   crm contact add --raw "Jane Doe, jane@acme.com, 212-555-1234, linkedin.com/in/janedoe, Acme, CTO"
   ```

   Parser: email regex, `libphonenumber-js` (already a dependency, handles
   messy phones natively), `normalize-url` (already a dependency) for
   websites/social URLs, remainder split into name/company. Parsed fields
   feed the **same Zod validation + normalization pipeline** as flags.
   Unparseable fragments produce field-level `INVALID` errors — nothing is
   silently dropped.
2. **Dedupe prompt on add:** when the Dice-score duplicate check (already
   implemented) fires, `add` does not fail silently or merge silently — it
   prints the existing entity and offers `--merge` / `--anyway` / abort.

The optional human-facing `--ai` flag (LLM completes dirty input locally) is
deferred: it conflicts with the data-stays-on-the-box ethos and the skill
already gives agents an AI front-end.

## Security quick wins (phase P0, independent of serve)

These are defects in today's code, fixed immediately on the fork:

1. **Daemon socket moves out of `tmpdir()`.** Today the socket lives at
   `tmpdir()/crm-fuse-<mount>.sock` — fine on macOS (per-user tmpdir), a
   same-host access risk on Linux (`/tmp`). Move to
   `~/.crm/sockets/`, chmod 0600, parent dir 0700.
2. **Hooks opt-in + documented.** `hooks.ts` runs config values with
   `shell: true`, and `crm.toml` is discovered by walking up from cwd — a
   hostile repo's `crm.toml` executes commands. Hooks stay, but: a project
   `crm.toml` may only define hooks if it contains an explicit
   `hooks.enabled = true` marker; global config always works. Documented as
   "hooks are code execution; review them like you would review a Makefile".
3. **Dependency audit** before first enterprise release. Completed
   2026-09-25: all 7 direct dependencies at their bun.lock-pinned versions
   (`@libsql/client@0.17.2`, `commander@13.1.0`, `drizzle-orm@0.45.2`,
   `libphonenumber-js@1.12.41`, `normalize-url@9.0.0`, `toml@3.0.0`,
   `ulid@2.4.0`) — 0 vulnerable ranges via the npm audit endpoint. No
   install-time or runtime network calls exist in `src/` at all (the
   ONNX model download described in the docs is not implemented).

## Email (P7, as-built)

Outbound only in v1. `crm email send <contact> --subject ... --body ...`:

- Sends through the configured SMTP relay with a dependency-free client
  (plain TCP, optional STARTTLS, implicit TLS on `secure = true`,
  AUTH LOGIN, dot-stuffed DATA, 30s guard).
- Recipient defaults to the contact's first email address; `--to` overrides,
  `--cc` repeats, `--body-file <path|->` reads the body (stdin with `-`).
- Every send auto-logs an `email` activity on the contact — and on the deal
  when `--deal <ref>` is given — so the record stays the source of truth
  for "what did we tell this customer".
- Trust model: `[mail]` in the **trusted** config carries routing only
  (`host`, `port`, `user`, `from`, `secure`); the relay password comes from
  the **server process environment** `CRM_SMTP_PASSWORD` (same posture as
  the LDAP bind password) and never touches the config file or the DB.
- Remote mode: the send executes server-side — the client never sees the
  relay address or password. `email.send` is `write: true` (auto-audited)
  with `minRole: writer`.
- Unconfigured relay / missing password fail cleanly before any network
  round-trip.

Follow-up (not v1): inbound — IMAP/Gmail inbox sync, auto-logging received
mail as activities, contact/deal matching by address.

## Web admin console (P8, as-built)

`crm serve --admin-port <port>` (omit to disable) serves a single-file web
console on a separate plain-HTTP port — the data port stays RPC-only TLS.

- **One auth surface:** the console calls `handleAuth` / `handleCommand`
  directly, so login (local + LDAP + bootstrap), role checks, and audit
  recording are byte-for-byte the same as the RPC surface. `POST /api/call`
  (`{"method", "params"}` + bearer token) is the generic JSON endpoint; the
  HTML UI is just a client of it.
- **Tabs:** Users (create with one-time password, enable/disable), Tokens
  (create/revoke), Audit (recent rows + verify chain), Config (read-only;
  secrets are never returned — only "is it set" flags), Clients (download).
- **Client onboarding:** `GET /download/crm.toml` and `/download/install.sh`
  embed the RPC address (`[remote] server = "host:port"`, `insecure` only
  when the default self-signed material is in use), closing the
  "ordinary users shouldn't juggle `--server`" gap. The token still comes
  from `crm login` — a session artifact, never baked into the download.
- **Transport:** plain HTTP by design (ops tool on a trusted interface,
or behind a TLS proxy). HTTP status mapping: AUTH→401, FORBIDDEN→403,
  INVALID→400, NOT_FOUND→404, else 500. Body cap 1 MiB.

## Data model completion (P9, as-built)

Three additions close the "this is not a real CRM yet" gaps: ownership,
follow-up tasks, and a team-shaped activity vocabulary.

**Ownership (`owner` + `--mine`).**
- `contacts` and `deals` gain an `owner` column (a username; null =
  unassigned). Settable via `--owner` on add/edit; filterable via
  `--owner <name>` (case-insensitive exact) on list.
- `--mine` filters a list to the caller's own rows. In remote mode the
  server injects the authenticated username as a **server-owned** `caller`
  param (stripping any caller-supplied `caller`/`actor` first, then
  re-injecting its own last, so a client cannot impersonate another user's
  view). In local single-user mode there is no caller, so `--mine` keeps
  every row (one user owns all rows).
- `actor` stays write-only threading metadata; `caller` is the extra
  identity read services may use as a filter.

**Tasks (`crm task`).** A lightweight `tasks` table (title, due_at,
status open|done, owner, contact, deal) answers "what do I do about Acme
today":
- `task add <title> [--due YYYY-MM-DD] [--owner u] [--contact ref] [--deal ref]`
- `task list [--status open|done] [--due-today] [--overdue] [--owner u]
  [--mine] [--contact ref]` — open by default; due-date filters only apply
  to open tasks.
- `task show / task done / task rm <ref>` — ref is an id or a
  case-insensitive exact title (ambiguity → exit 3).
- `task.*` methods are registered with `write: true` (auto-audited) and
  `entity_type: 'task'` in the audit chain.

**Configurable activity types.** `activity.log` validates against
`[activity] types` in config (default `note, call, meeting, email`) instead
of a hard-coded list, so a team can capture its real cadence (wechat, visit,
entertainment, dingtalk, …) — or replace the defaults — without patching the
binary. The same list drives the CLI help text.

## Admin surface (B, as-built)

Completes the ops story the P-phase console only half-covered. Full spec:
[spec/admin-surface.md](admin-surface.md). All console paths go through the
same `/api/call` JSON endpoint as the RPC wire — no parallel auth or audit
surface.

- **Password lifecycle (B1):** `admin.user.reset-password` reuses the
  one-time-initial-password flow (same must_change_password flag, same
  shown-once display); `auth.change-password` (server-only method, current
  password required) powers `crm password change`. Login enforces
  must-change (no data methods until changed) and optional `password_max_age_days`
  expiry (0 = off; legacy NULL rows are treated as "never expired" so
  existing deployments are not blindsided). Failed change attempts do not
  move the lockout counter. LDAP-provisioned users are refused local
  self-service changes — the directory is the password authority.
- **User deletion (B2):** `admin.user.delete` (admin/owner) refuses
  self-delete, NULLs `owner` in contacts/deals/tasks (rows survive,
  unowned), and deletes the row — tokens die via the existing FK cascade.
  One audit row with a before snapshot.
- **Console users tab (B3):** role select, per-row reset (one-time password
  modal), per-row delete (confirm) — the viewer's own row has no delete.
- **Audit diff (B4):** `audit.get` (reader) + `crm audit show <seq> --diff`
  render before/after snapshots as changed-fields only; `audit.list` gains
  an entity filter; the console Audit tab filters by actor/action/entity and
  diffs inline. Display-only — the chain and `audit verify` are untouched.
- **Server status (B5):** `server.status` (reader) reports version, uptime,
  live connections (socket accept/close counters), user/token counts, db
  file size, audit seq, and litestream backup state (best-effort; nulls
  when unconfigured). `crm status` prints it; the console Dashboard tab
  shows it with 30s auto-refresh.
- **recordAudit serialization:** audit writes on a shared in-process libsql
  client run through a per-client promise chain — the SQLite write lock is
  per process, so concurrent recordAudit calls on one client used to
  interleave their write transactions and fail with SQLITE_BUSY.

## Out of scope for v1

- Multi-tenancy (per-tenant rows in one DB)
- Per-record ACLs / ownership
- Remote FUSE/NFS mounting (mounts stay local; remote = CLI/skill). A
  remote-mount bridge is a separate project if ever needed.
- Two-way sync / offline merge (local mode *is* the offline story; the
  server is the single source of truth in remote mode)
- Server-side LLM input completion (`--ai`)
- Fine-grained command scopes beyond roles
- Read replicas / HA (single file + WAL + litestream backup is the DR story
  at this scale)

## Phased roadmap

Each phase ships standalone and keeps the test suite green. Functional-test
pattern extends to the server: tests spawn `crm serve` on a real TLS port and
drive the CLI client against it.

| Phase | Content | Exit criteria |
|---|---|---|
| **P0** ✅ (0.5 wk) | Socket perms, hooks marker, dep audit | `bun test` green; new tests prove socket is 0600 and project hooks are inert without marker |
| **P1** ✅ (2.5–3.5 wk) | `crm serve`: TCP+TLS, **local accounts** (argon2id, lockout, login audit rows), `users`/`tokens` tables, token issuance (hash store), connection limits, `/healthz`, systemd/Docker | `crm admin user create` + `crm login` (username/password on TTY) issues a token; wrong password increments lockout counter + audit row; bad token → `AUTH`; health endpoint answers; server survives restart with existing DB — all covered by `test/enterprise/serve.test.ts` + `auth.test.ts` |
| **P2** ✅ (2–3 wk) | Service-layer refactor (commands → pure modules), RPC surface, `--remote`/`CRM_SERVER` client mode | All existing commands work identically in local and remote mode (proven by `test/enterprise/remote.test.ts`, which diffs normalized local vs remote output for the full data surface); scenario tests run against both (`remote-scenarios.test.ts`); remote CLI has zero local DB access (proven by test with an isolated `HOME` that gains no `.crm`); RBAC enforced per-method; server-side hooks fire on remote writes |
| **P3** ✅ (3–4 wk) | `version` column + CAS on all data rows, exit code 3 on conflict, actor threading (who-did-what on entity rows), conflict-recovery UX | Two concurrent writers → one wins, other gets exit 3 with current state; `crm contact edit` after a conflict shows the server's current values and retries; RBAC matrix test (4 roles × read/write/admin) codified as a table-driven test — all proven by `test/cas.test.ts` + `test/enterprise/concurrency.test.ts` + `test/enterprise/rbac.test.ts` |
| **P4** ✅ (1–2 wk) | audit_log + hash chain, `crm audit list/verify/export` | Every mutation produces a row; `audit verify` detects a single-row tamper; audit covers all ~20 write sites (test per site) |
| **P5** ✅ (2–3 wk) | litestream WAL backup → S3/NAS, prebuilt FUSE/NFS bridges in release, Windows client build, internal-mirror install doc | Restore test: kill server, restore from archive, `audit verify` passes; mounts work with zero local compilation on Linux + macOS |
| **P6** (6–10 wk) | **LDAP directory integration** ✅ (two-step bind, JIT provisioning, group→role mapping, in-docker LDAP in CI); field-level encryption for sensitive columns, data-subject export/delete, token expiry policy; OIDC device-code as optional add-on | Directory user logs in via `crm login`, JIT-provisions with the correct group role; no-group user hits `auth.default_role` (deny); injection-style username rejected; unreachable directory → clean `AUTH` error, no fallback to local password; right-to-erasure removes a person's data + relinks references; expired tokens rejected |
| **P7** ✅ (0.5–1 wk) | Outbound email: dependency-free SMTP client, `[mail]` routing config + `CRM_SMTP_PASSWORD` env secret, `crm email send` with activity auto-logging, server-side send in remote mode | Mock-relay tests prove the message (from/to/cc/subject/body/auth) on the wire; activity + audit rows appear; reader refused / writer allowed; unconfigured and missing-secret fail cleanly (`test/email.test.ts` + `test/enterprise/email.test.ts`) |
| **P8** ✅ (1–2 wk) | Web admin console on a separate HTTP port: login, Users/Tokens/Audit/Config/Clients tabs, `/api/call` JSON surface reusing RPC RBAC+audit, secret-free config view, `crm.toml`/`install.sh` client downloads with embedded server address | Console login + bearer identity; admin calls over HTTP create user/token; reader 403 on admin + config; secrets never in the response; downloads embed the RPC (not admin) port; audit rows written for console-originated writes (`test/enterprise/admin-console.test.ts`) |
| **P9** ✅ (1–2 wk) | Data model completion: `owner` + `--mine` on contacts/deals (server-injected, tamper-proof `caller`), follow-up `tasks` entity (`add/list/show/done/rm`, `--due-today`/`--overdue`/`--owner`/`--mine`, contact/deal links, audited), configurable `[activity] types` | `--mine` returns only the caller's rows in remote mode and a forged `caller` param is ignored; task due-date filters + exit-3 title ambiguity; a configured non-default activity type is accepted while an unconfigured one is rejected (`test/ownership.test.ts`, `test/tasks.test.ts`, `test/activity-types.test.ts`, `test/enterprise/ownership.test.ts`, `test/enterprise/tasks.test.ts`) |

Sequencing note: P1 introduced `users`/`tokens` + local password login; P2 already
enforces method-level RBAC (role rank vs method minimum) and writes an audit row
per RPC write. P3 adds optimistic concurrency (CAS) and actor threading across
the ~20 write sites; P4 extends audit to a hash chain. P3 and P4 share the
write-site touch points — plan them as one pass over the same ~20 locations. If
the target customer requires directory login at go-live, promote LDAP from P6
to the slot right after P3 — it depends only on the P1/P2 users/roles model.

## Backups (P5)

Continuous WAL replication to a replica destination via **litestream**
(v0.5.x, pinned): local directory (NAS/share) or S3. The replica is a
chain of LTX files; `restore` rebuilds a full SQLite file from it.

- **Binary**: resolved as `LITESTREAM_BIN` env → `litestream` on PATH →
  `~/.crm/bin/litestream` → optional auto-download from the GitHub release
  (pinned version + SHA-256 verified against the official checksums).
- **Config** is written next to the DB (`<dbdir>/.litestream.yml`):

  ```yaml
  dbs:
    - path: /data/crm.db
      replica:
        type: file          # or s3 (bucket/prefix/region)
        path: /backups/crm
  ```

- **Commands** (server-host operations, local only — a remote client gets a
  clear "run on the server host" error):
  - `crm backup init --destination <path|s3://bucket/prefix>` — write the
    config, register the DB, take the first snapshot (add `--download` to
    fetch the binary when none is installed).
  - `crm backup sync` — one-shot replication pass (`replicate -once`).
  - `crm backup status` — per-DB replication status (local txid, WAL size).
  - `crm backup restore --to <path>` — rebuild a fresh DB file from the
    replica (`restore -o`); refuses to overwrite an existing file.
  - `crm backup check` — restore to a temp file, run `audit verify` +
    row-count comparison against the live DB, report.
- **Server**: `[backup] destination = "..."` in the server config makes
  `crm serve` spawn `litestream replicate` as a child process at startup
  (continuous WAL sync, its own sync-interval) and stop it on shutdown.
- **RPC**: `backup.status` and `backup.sync` are admin methods (an operator
  or agent can force a sync remotely); `restore` is deliberately local-only.
- Backup operations write `audit_log` rows (`backup.init` / `backup.sync` /
  `backup.restore`) like any other mutation.
- **Deferred to release engineering** (needs CI): prebuilt FUSE/NFS bridge
  binaries, Windows client build, internal-mirror install doc. The backup/
  restore surface above is the testable DR story: kill the server, restore
  from the replica, `audit verify` passes on the restored file.

**P2 as-built notes:**

- **Activation:** data commands go remote when (in order) `--remote [addr]` is
  given, or `CRM_SERVER` **and** `CRM_TOKEN` are both set (agent pattern), or
  `[remote] server` is in config. A saved `crm login` session supplies the
  **token** (and powers `admin.*`/`whoami`) but does not by itself switch
  data commands to remote — remote is always explicit, so a machine with a
  stored token stays local until `--remote` or `[remote]` is set.
  `CRM_SERVER` alone (no `CRM_TOKEN`) does **not** switch data commands to
  remote — deliberate, so developers with `CRM_SERVER` set for `crm login`
  don't lose their local DB.
  *Superseded in part by A1 (spec/client-repl.md): a saved session now routes
  data commands to its server by default, and local mode exists only when you
  name a database. See **Mode contract** above; `CRM_SERVER` alone still does
  not switch.*
- **`rm` in remote mode requires `--force`**: the server has no TTY to confirm.
  Local interactive `rm` still prompts; its refusal messages are
  byte-identical in both modes.
- **`import` parses on the client** (CSV/JSON/`--raw`) and sends the parsed
  records over the wire; validation, dedupe, and writes happen server-side.
  The 1 MB frame cap is ample for v1 batch sizes.
- **Hooks run server-side** with the server's config; a client machine's
  project hooks do not apply to remote writes (remote = the server's policy).
- **`admin.*`, `whoami`** accept the env-var pattern as well as a saved
  session, so a service token can do full administration non-interactively.

Known flaky test (pre-existing, verified by A/B on f9bdc95 vs 3100ca6):
`test/db-busy-timeout.test.ts` (40 parallel writers, 5s busy_timeout) failed
intermittently under machine load — one writer exceeded the 5s lock wait.
P3 raised `PRAGMA busy_timeout` from 5000 to 30000, which has stabilized it;
the CAS machinery (below) makes write-conflict retry a first-class flow.

**P3 as-built notes:**

- **CAS is opt-in per write**: `--version <n>` on `contact/company/deal
  edit` and `deal move` makes the write compare-and-set (`WHERE id = ? AND
  version = ?`); without it, last write wins. Every write to
  `contacts`/`companies`/`deals` (CLI, RPC, FUSE document, tag, merge,
  import-update) bumps `version` — so an unversioned write invalidates a
  version someone else was holding, exactly like a concurrent reader.
- **Exit code 3 = any conflict**: stale `--version`, duplicate email/website
  rejection, or any other write lost to a data change underneath. The error
  message carries the current version (CAS) so the retry loop is: re-read
  (`crm contact show`), retry with the new `--version`. Wire code stays
  `CONFLICT` either way.
- **`--version` collision**: the program-level version flag is now `-V`
  only; `--version` belongs to the subcommands (commander would otherwise
  swallow it).
- **Actor threading**: RPC writes record `updated_by = <username>` on the
  rows they touch (add/edit/move/merge/tag/import); local mode records none
  (single user, no identity). `updated_by` is visible in `show`.
- **FUSE documents carry `version`**: the daemon accepts it in writes and
  rejects stale ones with `ECONFLICT` (proven by
  `test/enterprise/daemon-cas.test.ts` driving the NDJSON socket); the NDJSON
  response echoes the request `id` when present (FUSE clients send none).
- **RBAC matrix** is table-driven in `test/enterprise/rbac.test.ts` —
  owner reuses the bootstrap token (owner cannot be provisioned via
  `admin.user.create`), the other three roles are provisioned per row.

**P4 as-built notes:**

- **Chain shape**: `row_hash` covers the row's own content **and**
  `prev_hash`, so a tampered row N breaks at N (content mismatch) and the
  chain walk stops there with the first broken seq — later rows are not
  reported individually. `verify` exits 1 on tamper, 0 on intact, and
  prints `OK: audit chain intact — N row(s) verified; genesis seq K;
  M legacy row(s) before the chain` when applicable.
- **Append under a write transaction**: libsql's local client exposes no
  `lastInsertRowid` on transaction results, so the row is read back inside
  the same `write` transaction (matched by at/action/prev_hash) to get its
  `seq` before the hash is computed and stored. Transaction mode is
  `write` (libsql has no `exclusive`); the write lock is what serializes
  concurrent chain appends.
- **Snapshots** use shared helpers (`auditMeta`/`auditSnapshot`/
  `auditEntityRow` in `src/lib/audit.ts`): insert → `before_json` null,
  `after_json` = created row; delete → `after_json` null; edit → both;
  batch/meta writes (import, index rebuild) carry the operation result
  instead of an entity row.
- **Actor injection is write-only**: the server injects
  `actor = identity.username` into write-method params (services record
  `updated_by`); read methods get raw params — this is what lets
  `audit list --actor <name>` filter by actor name instead of being
  shadowed by the caller's identity (a P4 bug caught by the reader test:
  the injected actor made every remote `audit list` return the caller's
  own rows only).
- **Migration hardening**: `migrateSchema` skips the ALTER pass entirely
  on a freshly created, empty database (SCHEMA_SQL already has every
  column) — an exclusive-lock ALTER during 40 parallel first-writes was
  head-of-line-blocking the bootstrap DDL (SQLITE_BUSY); schema init
  statements now also run through a `busyExec` retry with backoff.
- **Reads**: `audit list` (newest first, default limit 50, filters
  actor/action/entity/since), `audit verify`, `audit export` (full chain,
  table/json/csv/tsv) are all `reader`+ methods; a remote client renders
  them locally (same as every other command).

**P5 as-built notes:**

- **litestream pin**: v0.5.17 (last release in the 0.5 line). Config is
  the v0.5 shape — top-level `dbs:` list with `- path:` / `replica:` (the
  older map-style `dbs: { path: ... }` is rejected by the binary); the
  config file is generated, never parsed by hand — `restore`/`check`
  read the destination back out of our own generated
  `<dbdir>/.litestream.yml`.
- **Binary**: resolved as `LITESTREAM_BIN` → PATH → `~/.crm/bin/litestream`
  (0700 dir, 0755 binary). `crm backup init --download` fetches the
  pinned release tarball and verifies SHA-256 against the official
  `checksums.txt` when a local pinned checksum is not yet recorded.
- **Remote surface**: `backup.status` (admin, read) and `backup.sync`
  (admin, write — audited as `backup.sync`) are registry methods, so a
  remote admin can inspect/force replication; `init`/`restore`/`check`
  have **no** RPC surface (`localOnly` in `src/remote/dispatch.ts`) — a
  remote client gets "runs on the server host".
- **Audit rows**: `backup.init` / `backup.sync` / `backup.restore` write
  audit rows (source `cli-local`, actor `backup`) with the destination/
  config in `after_json`; a failed audit never fails the operation.
- **Exit codes**: `backup restore --to <existing>` is a `CONFLICT` →
  exit 3 (consistent with P3: any write that lost to existing state);
  `backup check` exits 1 when the replica is stale or the chain is
  broken, 0 when the restored temp DB matches the live row counts.
- **serve integration**: `[backup] destination` makes `crm serve` write
  the managed config and spawn `litestream replicate --config …` as a
  child (stdio detached); the child is SIGTERMed on server shutdown. A
  broken destination logs `backup: continuous replication disabled` and
  does not fail the server start.
- **Deferred to release engineering** (needs CI + target machines):
  prebuilt FUSE/NFS bridge binaries, Windows client build, internal-
  mirror install doc. The DR exit criterion is testable now: kill the
  server, restore from the replica, `audit verify` passes on the
  restored file (`test/enterprise/backup.test.ts`).

## LDAP directory login (P6, as-built)

The directory is the **password authority**; the CRM `users` table remains the
authority for role and token. Flow on every `auth.login` when `[ldap] enabled`:

1. **Service-account search** — bind as `bind_dn` (password read from the env
   var named by `bind_password_env`, never from config), search `base_dn` with
   the escaped `user_filter` (default `(uid={username})`). The filter is built
   with `ldapts.escapeFilter`, so injection-style usernames can never break
   out of it.
2. **User verification** — bind as the found entry with the presented password.
   A clean `InvalidCredentialsError` → `AUTH` (no local fallback, even when a
   same-named local account exists). Any *other* failure (connection drop, TLS
   error) → `AUTH: directory is unreachable`, with an audit row
   `auth.login-failed { reason: "ldap-unreachable" }`. Connection-layer errors
   retry twice with backoff on the **service-account** operations only; the
   user's password bind is exactly one request and never retries (a directory
   that reports some wrong passwords as a generic error would otherwise see
   three binds per login). Every operation carries `timeout_ms` /
   `connect_timeout_ms`, because ldapts itself defaults to *no* timeout and a
   black-holed directory would otherwise hold the login open indefinitely.
3. **Identity** — the CRM username comes from the entry's `uid`
   (`sAMAccountName` on AD), lowercased and trimmed, not from whatever the
   caller typed. Directories match `uid` with `caseIgnoreMatch` while SQLite's
   `UNIQUE` is case-sensitive, so `users.username` also carries a
   case-insensitive unique index (added best-effort at open: a database that
   already holds both spellings is reported rather than silently keeping two
   accounts, and a case-insensitive lookup prefers the disabled row).
4. **Role from groups** — the entry's group memberships are read from
   `group_base_dn` (AD-style `member`, plus `uniqueMember`) and mapped through
   `[ldap.roles]` (highest ranked mapped group wins); no mapped group →
   `auth.default_role` (default `none`, which grants **no** data access).
   Role names in `[ldap.roles]` / `auth.default_role` are validated against
   `VALID_ROLE_NAMES` at boot — a typo must not silently mean "no
   privileges". One ranking ladder (`roleRank`) serves both RBAC and this
   mapping.

- **JIT provisioning** — first successful directory login creates the row
  (`auth_source = "ldap"`, `ldap_dn` recorded, username/display/email from the
  entry, `password_hash = NULL`). Each subsequent login refreshes the
  directory-sourced fields, so a group change is picked up on the next login.
- **Local disable is authoritative** — `admin.user.disable` on a directory user
  is enforced locally (`disabled_at`), giving incident response without
  touching the directory.
- **Ambiguous identity is refused** — `user_filter` is searched with
  `sizeLimit = 2`; more than one match ends the login with
  `AUTH: … ambiguous in the directory` + an
  `auth.login-failed { reason: "ambiguous-identity" }` row. Taking
  `searchEntries[0]` would authenticate one person as another.
- **Login throttling** — `auth.login` is capped at
  `auth.login_rate_per_minute` attempts per client IP and
  `login_user_rate_per_minute` per (IP, username) pair (defaults 60 / 15,
  `0` disables), sliding 60s window, in-process, counted on *attempts* so it
  is not a username oracle. The key is the socket address, not
  `X-Forwarded-For` — a client-chosen header would make the limit evadable,
  at the cost of one shared bucket behind a proxy (raise the per-IP figure
  there). Directory logins deliberately skip the CRM lockout
  counters, so this is the only thing between a client and your directory's
  own lockout policy. Throttling writes `auth.rate-limited`.
- **`set-role` does not apply to directory users** — their role is recomputed
  from group membership on every login, so `admin.user.set-role` refuses with
  a pointer to the group mapping instead of writing a value that the next
  login would undo. `disable` remains the immediate local kill switch.
- **TLS** — plain `ldap://` without `starttls = true` is refused **at boot**
  (`crm serve` fails to start). `ldaps://` and StartTLS both work. An explicit
  `CRM_ALLOW_INSECURE_LDAP=1` escape hatch exists for local/in-docker test
  directories only. Certificate **verification** is on by default: trust
  anchors come from the system store or `tls_ca_file`, and only
  `tls_skip_verify = true` turns verification off — which `crm serve` shouts
  about at boot rather than doing quietly.
- **Config trust boundary** — `[auth]` and `[ldap]` are honoured only from a
  trusted config (`--config` / `CRM_CONFIG`, or `~/.crm/config.toml`). A
  `crm.toml` discovered by walking up from the cwd is stripped of both
  sections (`loadConfig` warns; `crm serve` refuses to start), because
  discovery reaches files that arrive with a cloned repository and
  `[ldap]`/`default_role` decide who may log in and as what — a
  same-named-directory attack on any server started from a checkout. This is
  the same reasoning that already gates `[hooks]`, applied more strictly:
  a self-declared marker would not do, since the marker lives in the
  untrusted file too. `config.config_meta` records `{ path, trusted,
  dropped_auth_authority }`.
- **`none` is a real role** — `roleAllows` now treats `none` (and any
  unrecognized role) as rank 0, below `reader`, so a default-role-`none` user
  gets `FORBIDDEN` on every data method.
- Library: `ldapts`. No YAML/extra deps; config merges through the existing
  TOML `[ldap]` / `[ldap.roles]` sections.

Remaining P6 items (not yet built): field-level column encryption,
data-subject export/delete, token expiry policy, optional OIDC device-code.

## Test additions (spec-first, before each phase's code)

- `test/enterprise/auth.test.ts` — auth handshake, wrong token, expired
  token, token revocation, hash-at-rest (raw token never in DB file),
  local-account login (success / wrong password / lockout), login-failure
  audit rows
- `test/enterprise/ldap.test.ts` — two-step bind against in-docker LDAP
  (e.g. osixia/openldap), JIT provisioning + dn/email capture, group→role
  mapping, no-group default-deny, injection-style usernames rejected,
  unreachable directory → clean `AUTH` error (no crash, no fallback to
  local password), case-variant login cannot step around `disable`,
  ambiguous filter refused, stalled directory fails within its deadline
  instead of hanging, `set-role` refused for a directory user
- `test/enterprise/ldap-config.test.ts` — `[ldap]` boot validation without a
  directory (transport refusal, required fields, role-name typos, CA file,
  timeouts), TLS defaults, timeout bounds, group→role ladder
- `test/enterprise/config-trust.test.ts` — discovered configs cannot supply
  `[auth]`/`[ldap]` (serve refuses, nested cwd, other commands warn and
  continue), identical content accepted from an explicit config
- `test/enterprise/rate-limit.test.ts` — per-username and per-IP caps, `0`
  disables, throttling neither locks the account nor invalidates issued
  tokens
- `test/enterprise/rbac.test.ts` — full role matrix, incl. cross-role read
  filtering
- `test/enterprise/concurrency.test.ts` — two clients, same entity, same
  moment: exactly one succeeds; loser gets exit 3 + current version;
  retry-with-new-version succeeds
- `test/enterprise/audit.test.ts` — one row per mutation, before/after
  correct, chain verifies, tamper detected (content edit → seq reported,
  row deletion → chain break), legacy rows tolerated, local-mode rows
  (`source=cli-local`, actor = OS user), FUSE daemon writes audited
  (`source=fuse`), reader-role remote `audit list/verify/export` access
- `test/audit-commands.test.ts` — `audit list` output + filters
  (`--limit/--actor/--action/--entity/--since`), JSON shape, `verify`
  exit codes (0 intact / 1 tampered, first broken seq), `export` json/csv
  parity
- `test/backup-dest.test.ts` + `test/enterprise/backup.test.ts` — (P5)
  destination parsing (file/s3/invalid), init snapshot, sync advancing the
  replica, **restore exit criterion** (kill server → restore → `audit
  verify` green on the restored file + row counts), check, missing-binary
  guidance, invalid destination, serve spawning continuous replication,
  remote status/sync via admin RPC + host-only rejection
- `test/enterprise/serve.test.ts` — boot/health/TLS/cert-reload/restart-
  persistence
- `test/enterprise/remote.test.ts` — (P2) local-vs-remote output parity
  across the data surface, writes landing in the server DB only, duplicate
  rejection, rm `--force` semantics, CSV import over the wire, zero local
  DB access (isolated HOME), RBAC per role, server-side hook rejection
- `test/enterprise/remote-scenarios.test.ts` — (P2) a full scenario
  (`devrel-outreach`) green against a live server via the test env hooks
- `test/enterprise/raw-input.test.ts` — dirty free-text parses to the same
  normalized values as equivalent structured flags (golden pairs)

Every new flag, error code, and env var in this spec gets a test before its
implementation — same discipline as the original 337→450.
