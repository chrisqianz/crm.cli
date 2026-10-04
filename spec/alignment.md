# Alignment: mysuggest.md Baseline vs. sh

Status: **superseding spec** for the clauses listed in §2. Written after the
owner review of `spec/mysuggest.md` (v1.0, the reference baseline) against the
shipped v0.4.0 implementation. Where this document and `enterprise.md`
disagree, this document wins.

## 1. Owner decisions (2026-10-05)

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | The centralized backend **must run on an enterprise-grade database — PostgreSQL**. SQLite is a single-machine database only. | `crm serve` gains a PostgreSQL backend behind a repository abstraction. SQLite is retained for local mode, standalone single-file use, and the FUSE local cache. |
| D2 | The current identity model **stays**: local self-hosted accounts + LDAP/AD direct bind, long-lived hashed tokens. No OIDC, no OAuth2/PKCE browser login. | `enterprise.md` L88 (OIDC rejection) stands. `mysuggest.md` §2/§33–37 (OIDC bus, PKCE CLI login, HttpOnly-cookie web SSO) is **not** adopted. Web login (when the Web CRM lands) uses username/password against the same identity service. |
| D3 | Organization model: **to be implemented per the baseline MVP** (`organizations` + `memberships` from day one, `organization_id` on every business entity, tenant filtering on every query). *(Owner answer pending final confirmation — this spec assumes yes.)* | New schema + actor context plumbing + tenant isolation. See P-AL3. |

Notes:

- "enterprise-grade database like SQL Server" was cited as the *class* of
  requirement; **PostgreSQL 16+ is the target** (the baseline's stack, and
  drizzle/pgvector/FTS/RLS all assume it). SQL Server is explicitly **not**
  a supported target; if a deployment mandates it, that is a separate
  tracked effort, not an alignment item.
- Already compliant with the baseline (no work): argon2id password hashing
  (`mysuggest.md` §61), hashed token storage (§60), ULID-style IDs (§101),
  duplicate detection/merge (§104), audit on writes (§152/8).

## 2. Superseded clauses

- `enterprise.md` L46 — "Multi-tenant … is explicitly out of scope" →
  superseded by D3.
- `enterprise.md` DB layer (serve on SQLite/libSQL + litestream) →
  superseded by D1 for the **centralized** deployment. Litestream remains
  valid for the standalone single-file server.
- `mysuggest.md` §2/§33–37 OIDC/PKCE architecture → not adopted (D2).
- `mysuggest.md` §69 (Redis as session/rate-limit/cache store) → v1
  deviates, see §5.

## 3. Target architecture

```text
                     ┌────────────────────────┐
   Web (console) ───▶│        crm serve        │
   CLI (remote) ────▶│  auth → actor context   │
   MCP (later) ─────▶│  → RBAC + tenant filter │
   n8n (REST) ──────▶│  → service layer        │
                     │  → repositories         │
                     └────────────┬───────────┘
                                  │
                     ┌────────────┴───────────┐
                     ▼                        ▼
              PostgreSQL 16+             (v1 only: SQLite
              central data               single-file server
                                         for standalone use)
```

Non-negotiable properties (baseline §152):

1. **Client ≠ database** — no client (CLI, MCP, n8n, Web) ever touches the
   central database directly.
2. **Every query is tenant-scoped** once D3 lands — no query path may read
   or write a business row without its `organization_id` in the WHERE.
3. **Every write is audited** with the full actor tuple.
4. SQLite survives as: local mode (`--db`), standalone single-machine
   server, and the FUSE local cache (§39–41). It is **not** the central
   store.

### 3.1 Dual-driver repository layer

The service layer today calls drizzle over the libSQL client directly.
P-AL1 introduces:

```text
src/service/*.ts  →  repository interfaces (domain-level)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     SqliteRepository (existing        PostgresRepository
     behavior, single machine)          (central, `crm serve`)
```

- One schema source of truth; two drizzle schema files generated/maintained
  in lockstep (`drizzle-schema.ts` for sqlite-core, `drizzle-schema-pg.ts`
  for pg-core). CI check: table/column parity.
- Search: FTS5 (sqlite) → PostgreSQL FTS `tsvector` + GIN (pg) per
  baseline §103, same service-level contract (typed results, scores).
- Arrays (`emails[]`, `companies[]`, `tags[]` …): stored as **JSONB on
  PostgreSQL in P-AL2** to keep service behavior byte-identical during the
  driver switch; relationalization (`contact_emails`, …) is its own later
  phase (P-AL6) because it changes query shapes, not drivers.
- Jobs/email: **no Redis in v1** (baseline deviation). Outbound email and
  future background jobs use a Postgres-backed queue table with a
  in-process worker loop inside `serve`. Redis becomes relevant only at
  multi-node scale (HA phase, out of scope here).
- Single process in v1: `crm serve` hosts RPC + console + worker loop.
  Splitting `worker`/`mcp` into separate processes/apps happens with the
  phases that need them (MCP, Web CRM), not before.

### 3.2 Connection & operations

- `[serve] database` config section (or `DATABASE_URL` env):
  `postgres://…`. Absent → SQLite single-file (current behavior, unchanged).
- Migrations: drizzle-kit managed; the server refuses to start on a schema
  it does not recognize (no silent auto-migration of a central DB).
- Deployment: `docker compose` stack = `crm-serve` + `postgres` (+ optional
  `mailpit` for local mail); reverse proxy docs for TLS termination.
  `deploy/crm.service` (systemd, SQLite) stays for the standalone case.
- Baseline §112–113: add `GET /health` (process) and `GET /ready`
  (database reachable, LDAP optional) to the admin port.

### 3.3 Migration from existing SQLite data

Baseline §98–99: `crm migrate export` (SQLite → JSON) then import into the
central server. The existing `crm import` RPC surface is reused for the
server side; P-AL2 ships `crm migrate export|status` so a standalone
installation can hand its data to a fresh central deployment.

## 4. Phases

Each phase follows repo culture: spec delta → TDD red/green → mutation
check → full-suite gate (dual-driver matrix where applicable).

### P-AL1 — Repository abstraction (baseline Phase 0)

Extract repository interfaces from the service layer; SQLite path stays the
only driver, behavior unchanged. Repository interfaces are designed with
the actor/tenant context from the start (organization_id parameter shape)
so P-AL3 does not reshape them.

Acceptance: full suite green on SQLite; zero behavior change; service files
no longer import the db client directly.

### P-AL2 — PostgreSQL backend

`PostgresRepository`, pg schema + migrations, FTS port, `[serve] database`,
schema-parity CI check, `crm migrate export`, docker compose with
postgres. All service tests run against **both** drivers.

Acceptance: the full enterprise suite green on a real `postgres:16`
container; `crm serve` on Postgres passes every remote-mode scenario test;
standalone SQLite mode byte-identical (regression gate); `/health` +
`/ready` live.

### P-AL3 — Organization model *(pending D3 confirmation)*

`organizations`, `memberships` (role per membership), owner picks org at
bootstrap / admin assigns; every business entity gains `organization_id`;
actor context resolves org; tenant filter enforced in repositories (not in
commands); console org + membership management; migration backfills a
default org for existing rows. Baseline §18–20, §66; teams
(`teams`/`team_members`) included in this phase (MVP-adjacent, needed by
object-level scope later).

Acceptance: two organizations in one server; a writer in org A cannot read
org B contacts by id or list; audit carries organization_id; existing
single-org deployment migrates without data loss.

### P-AL4 — Agent identity + MCP

`agents` table; `crm token create|list|revoke` (api_keys: prefix + hash,
scopes, expiry, rotation — baseline §30–32, §128); agent actor type in
audit; `crm-mcp` server (MCP tool surface over the same service layer with
server-side authorization, baseline §50–52, §127 — agent-declared identity
is never trusted).

Acceptance: an agent token with `contact:read` only cannot create; n8n can
drive the CRM via REST and via MCP; every agent write lands in audit with
`actor_type=agent`.

### P-AL5 — Session hardening + MFA

Token → session metadata (device name, ip, user_agent, revocation,
last_seen) per baseline §62; admin "force logout" per session (§117);
TOTP MFA (baseline §64, second phase there — we take it here) with hashed
recovery codes. Refresh-token rotation stays out (long-lived tokens with
expiry + rotation commands cover the CLI; baseline §63 makes rotation
conditional on refresh-token use).

Acceptance: revoking one session kills only that device; MFA challenge on
login with a TOTP app; recovery codes work exactly once.

### P-AL6 — Data-model hardening

JSON arrays → relational tables (`contact_emails`, `contact_phones`,
`contact_companies`, `tags`/`contact_tags`, `deal_contacts`, …) with
dual-driver migrations and the baseline §100 mapping; soft delete
(`deleted_at`) + admin hard delete (§73); optimistic locking (`version`)
(§107); `Idempotency-Key` on create endpoints (§108).

Acceptance: import/export round-trip identical before/after; concurrent
update loses-wound (409-class error), not silently overwritten; duplicate
POST with same idempotency key creates one row.

### P-AL7 — Web CRM

Full web client (React) alongside the console; web login is
username/password against the identity service with HttpOnly/Secure/SameSite
cookies (baseline §34, minus OIDC per D2); profile page with sessions,
API keys, orgs (baseline §118).

Acceptance: a salesperson runs their full daily loop (contacts, deals,
activities, search, reports) from the browser; console remains the admin
surface.

### P-AL8 — FUSE remote client (baseline Phase 9)

FUSE → local SQLite cache → server API, online-only first
(baseline §41 phase 1); filesystem stays "the universal API", but no
longer equal to the database.

Acceptance: a fresh machine mounts a remote CRM's contacts/deals via FUSE
with no local business data; CLI and FUSE agree on content.

### P-AL9 — Scale & polish (as needed, not committed)

Redis at multi-node, worker process split, pgvector semantic search
(baseline §49), MinIO/S3 attachments, Prometheus metrics (§111), RLS
defense-in-depth (§67), PgBouncer, HA/K8s (baseline §97 phase 3),
GDPR export/erasure, field-level encryption, email inbox connector
(§55–58, baseline phase 2+).

## 5. Explicit deviations from mysuggest.md (ratified)

1. **No OIDC / OAuth2-PKCE CLI login** — D2, owner decision.
2. **No Redis in v1** — Postgres-backed job queue, in-process worker;
   single-node deployment is the v1 target.
3. **JSONB before relational tables** — driver switch first, schema
   evolution after (P-AL2 vs P-AL6).
4. **No refresh-token rotation** — hashed long-lived tokens with expiry,
   naming, scoping, and admin/CLI revocation.
5. **Single process** until MCP/Web CRM need their own.
6. **PostgreSQL, not SQL Server** — see §1 notes.
7. **Console before Web CRM** — the admin console (shipped) is the web
   surface until P-AL7.

## 6. Open items

- D3 final confirmation (org model yes/no, and whether teams ride along).
- P-AL2 needs a real `postgres:16` in the test environment (docker) —
  confirm the host runs docker for the test matrix.
- `mysuggest.md` §135 second-version items (agents/api_keys, security
  events, pgvector) are covered by P-AL4/P-AL5/P-AL9 above; confirm
  ordering if priorities differ.
