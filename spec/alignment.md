# Alignment: mysuggest.md Baseline — Construction Baseline

Status: **superseding spec** where it and `enterprise.md` disagree. Written
after the owner review of `spec/mysuggest.md` (v1.0, the reference
baseline) and the product re-positioning of 2026-10-06.

## 1. Product positioning (owner, 2026-10-06)

> The product is a **centralized CRM platform with a TUI as its primary
> human interface, built for humans AND AI agents working together**.

- The **central database is the design starting point**, not a migration
  target. "Local machine" is a development/offline convenience, never the
  axis the product is designed around.
- Everything else (LDAP, email, audit, org model, agents, Web, FUSE)
  exists in service of that central platform.
- **Sequence rule: features first, optimization last.** No phase ships
  pure refactoring with zero user-visible capability.

## 2. Owner decisions

| # | Decision |
|---|----------|
| D1 | The central backend runs on **PostgreSQL 16+** (enterprise-grade). SQLite is a single-machine database — dev tooling, offline mode, FUSE cache — **not** the product's core. ("SQL Server-like" was the class of requirement; the baseline stack targets PostgreSQL. SQL Server is not a supported target.) |
| D2 | Identity model **as currently built**: local self-hosted accounts + LDAP/AD direct bind, hashed long-lived tokens. **No OIDC, no OAuth2/PKCE browser login** (baseline §2/§33–37 not adopted). Web login, when it lands, is username/password against the same identity service with HttpOnly cookies. |
| D3 | **Organization model per the baseline MVP**: `organizations` + `memberships` from day one, `organization_id` on every business entity, tenant filtering on every query, `teams` alongside. |

Already compliant with the baseline (no work): argon2id password hashing
(§61), hashed token storage, ULID IDs (§101), duplicate detection/merge
(§104), audit on every write (§152/8), rate limiting + account lockout.

## 3. Target architecture

```text
                    ┌─────────────────────────┐
   TUI (CLI)  ────▶│        crm serve         │
   Web CRM    ────▶│  auth → actor context   │
   Agents     ────▶│  → RBAC + tenant filter │
   (MCP/REST) ────▶│  → service layer        │
   FUSE cache ────▶│  → repositories         │
                    └─────────────┬───────────┘
                                  ▼
                       PostgreSQL 16+ (the center)
                                  │
                    dev/offline: single SQLite file
```

Non-negotiable properties (baseline §152, applied):

1. **Client ≠ database** — no client touches the central DB directly.
2. **Every query tenant-scoped** — no business row reachable without its
   `organization_id` in the WHERE.
3. **Every write audited** with the full actor tuple.
4. **Agent ≠ human** — agents have their own identities, scoped keys,
   and audit trail; never trust agent-declared identity.

Design notes:

- **Repository layer**: service layer speaks domain-level repositories;
  two implementations (Postgres primary, SQLite for dev/offline) over one
  schema source of truth, kept in lockstep by a CI parity check. Tests
  run against Postgres as the primary matrix.
- **JSON array columns stay `TEXT` on BOTH dialects in AL-1** — the
  service layer round-trips them as strings (`JSON.stringify` on write,
  `safeJSON`/`JSON.parse` on read; spike-verified that JSONB readback
  hands back parsed objects and would break `safeJSON`). JSONB +
  relationalization are AL-6 work, where they belong with the schema
  evolution they require.
- **Search**: FTS5 → PostgreSQL `tsvector` + GIN, same service contract.
- **No Redis in v1** — Postgres-backed job queue, worker loop inside
  `serve`. Redis + separate worker process arrive with scale (AL-8).
- **Deployment**: docker compose = `crm-serve` + `postgres` (+ optional
  `mailpit`); `/health` (process) and `/ready` (DB reachable, LDAP
  optional) on the admin port.
- **Migration**: `crm migrate export` (SQLite → JSON) + existing import
  RPC for the server side, so a standalone installation hands its data to
  a fresh central deployment.

## 4. Phases (features first, optimization last)

Every phase: spec delta → TDD red/green → mutation check → full-suite
gate (Postgres primary matrix).

### AL-1 — Central PostgreSQL (foundation + core feature)

`crm serve` runs the platform on PostgreSQL 16: repository layer, pg
schema + migrations, schema-parity check, FTS port, `[serve] database`
config, docker compose stack, `/health` + `/ready`, `crm migrate export`
+ import path.

**Seam design (spike-verified 2026-10-06, real `postgres:16`)**:

- Drizzle's SQLite and Postgres instance types are **method-level
  incompatible** — `db.select/insert/update/delete` on a
  `LibsqlDB | NodePgDatabase` union does not type-check (tsc spike
  confirmed). So the seam is a **typed repository interface**, not a
  union DB handle.
- **Dual schema, single generic implementation**: the drizzle tables are
  declared per dialect (same names/columns/nullability/defaults;
  `sqliteTable` vs `pgTable`) and the service layer takes the schema as a
  parameter (drizzle "parameterized schema" pattern). The spike verified
  this compiles across both dialects, so the ~133 in-service drizzle call
  sites (~18 files) keep their current shape — no repository rewrite is
  required for AL-1. The type seam is a structural `CrmDb` interface
  (`select/insert/update/delete` + raw ops) that both real instances
  satisfy; the rejected alternative was a `LibsqlDB | NodePgDatabase`
  union (tsc: builder methods are per-dialect incompatible).
- **Raw SQL is dialected at the seam**: a `RawDB` wrapper
  (`rawQuery(sql, args)`, `withTransaction(fn)`) with libsql and pg
  implementations, exposing rows as plain objects. This is the only home
  for dialect-specific SQL: FTS (FTS5 `MATCH` vs Postgres FTS
  `to_tsquery`/`plainto_tsquery` + `ts_rank`, GIN index), the audit
  hash-chain transaction, and the backup raw client escape hatch
  (`src/service/backup.ts:288`/`:326`).
- **Migrations**: drizzle-kit `migrations/` (pg) + a SQLite parity
  script; a CI check asserts both schemas define identical
  table/column sets (names, nullability, defaults).
- **Search port**: Postgres table `search_index(entity_type, entity_id,
  content tsvector generated)`; the existing `findSemantic` JS scoring
  stays dialect-free; `searchFts` gets the `rawQuery` FTS path per
  dialect with the same LIKE fallback.
- **Config**: `[database] backend = "sqlite"` (default, existing
  behavior byte-identical; `path` unchanged) or
  `backend = "postgres"` + `url` (also overridable via env
  `CRM_DATABASE_URL`). A bare `url` without `backend` implies
  postgres; `backend = "postgres"` without `url` is a boot error.
- **Health**: `/health` (process alive) and `/ready` (configured DB
  reachable) on the admin port.
- **Migration path**: `crm migrate export` reads the SQLite file and
  emits the JSON the existing import RPC consumes, so a standalone
  installation hands its data to a central deployment.
- **Test matrix**: full enterprise suite green against real
  `postgres:16` (docker, available on the dev host) and green against
  SQLite (regression, byte-identical for single-file mode).
- **Deploy**: docker compose (`crm-serve` + `postgres` + optional
  `mailpit`); Dockerfile gains a Postgres entrypoint variant; the
  systemd+SQLite single-machine path stays.

**Acceptance**: the full enterprise test suite green against a real
`postgres:16` container; `crm serve --db` single-file mode still works
(dev/offline); admin console shows DB backend + readiness.

### AL-2 — Organization model

`organizations`, `memberships`, `teams`/`team_members`; owner's
bootstrap creates the first organization; admin creates orgs, assigns
members with per-membership roles; `organization_id` on every business
entity; tenant filter enforced in repositories; audit carries
organization_id; console org/membership management; migration backfills a
default org for existing rows.

**Acceptance**: two organizations on one server; a writer in org A cannot
read org B's contacts by id or list; single-org deployment migrates
without data loss.

### AL-3 — Agent identity + MCP (AI collaboration)

`agents` + `api_keys` (prefix + hash, scopes, expiry, rotation,
`crm token create|list|revoke`); agent actor type in audit; **`crm-mcp`**
server exposing the CRM over MCP with server-side authorization
(§50–52, §127); agent skills docs updated for token usage.

**Acceptance**: an agent token scoped to `contact:read` cannot create;
n8n drives the CRM via REST and via MCP; every agent write lands in audit
as `actor_type=agent`.

### AL-4 — Web CRM

Full web client (React) alongside the console: daily loop of contacts,
companies, deals, activities, search, reports. Web login =
username/password + HttpOnly/Secure/SameSite cookies (no OIDC, D2).
Profile page: sessions, API keys, organizations (§118).

**Acceptance**: a salesperson completes their full daily workflow from
the browser; console remains the admin surface.

### AL-5 — Session hardening + MFA

Session metadata (device, ip, user-agent, expiry, revocation,
force-logout per device, login history); TOTP MFA with hashed one-time
recovery codes; password policy for local accounts.

**Acceptance**: revoking one session kills only that device; MFA
challenge on login; recovery code works exactly once.

### AL-6 — Data-model hardening

JSON arrays → relational tables (`contact_emails`, `contact_phones`,
`contact_companies`, `tags`, `deal_contacts`, …) with dual-driver
migrations (baseline §100 mapping); soft delete + admin hard delete
(§73); optimistic locking via `version` (§107); `Idempotency-Key` on
create endpoints (§108).

**Acceptance**: export/import round-trip identical; concurrent update
conflicts loudly (not silent overwrite); duplicate POST with the same
idempotency key creates one row.

### AL-7 — FUSE remote client

FUSE → local SQLite cache → server API, online-only first (baseline §41
phase 1). The filesystem stays "the universal API"; it is no longer the
database.

**Acceptance**: a fresh machine mounts a remote CRM's contacts/deals via
FUSE with no local business data; CLI and FUSE agree on content.

### AL-8 — Optimization (not committed, order as needed)

Redis + separate worker process; pgvector semantic search (§49); MinIO/S3
attachments; Prometheus metrics (§111); Postgres RLS defense-in-depth
(§67); PgBouncer; HA/K8s (§97 phase 3); GDPR export/erasure;
field-level encryption; email mailbox connector (§55–58); data
retention policy (§74).

## 5. Ratified deviations from mysuggest.md

1. **No OIDC / OAuth2-PKCE** — D2.
2. **No Redis in v1** — Postgres job queue, in-process worker; single
   process until AL-8 needs more.
3. **TEXT, not JSONB, for JSON array columns in AL-1** — the service
   layer's string round-trip requires it; JSONB arrives with the AL-6
   relational migration that needs it.
4. **No refresh-token rotation** — hashed long-lived tokens with expiry,
   naming, scoping, revocation.
5. **PostgreSQL, not SQL Server** — see D1.
6. **Console precedes full Web CRM** — the shipped admin console is the
   web admin surface until AL-4.
7. **TEXT, not JSONB, for JSON array columns in AL-1** — see §3 (read
   path compat).

## 6. Open items

- None blocking AL-1. Docker is available on the dev host
  (verified 2026-10-06, `postgres:16` pulls clean) for the test matrix.
