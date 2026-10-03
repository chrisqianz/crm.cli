# Client Zero-Footprint Contract + Interactive REPL (UX v2)

Status: A and C implemented (2026-10-03); B remains backlog. Machine
surface (`crm <flat argv>`) is unchanged — verified by the untouched
functional suites.

## Background

The product is a centralized CRM: one authoritative server, thin clients.
Two findings from user acceptance drove this spec, both verified by
reproduction:

1. **Clients write locally.** With no server configured, `crm contact add`
   silently creates `~/.crm/crm.db` and writes to it. Local mode is the
   implicit fallback for any unconfigured/unauthenticated invocation. In a
   centralized data-management model, the client must hold no business data.
2. **The one-shot CLI is hostile to humans.** `crm contact add --name abc
   --email x@y.z` asks a person to memorize grammar and flags. Users want
   incremental interaction: enter `crm`, log in, then type short commands
   and answer simple questions.

## Scope

| Sub-project | Content | State |
|---|---|---|
| **A. Client zero-footprint** | mode contract change; no implicit local db | this spec, plan-ready |
| **C. Interactive REPL** | `crm` human shell: short verbs, wizard fill-in, fuzzy completion | this spec, plan after A |
| **B. Admin console completion** | password/role management, audit filters + diff view, server status, dashboard | backlog; own spec later |

Machine surface is unchanged everywhere: `crm <flat argv>` remains the
automation/agent interface (SKILL.md, scripts, JSON). The REPL is a human
presentation layer over the same `dispatch()` path — zero new business
logic, so RBAC, CAS, audit and the A-contract apply to it automatically.

---

## Sub-project A: zero-footprint mode contract

### A1. Resolution order (new mode contract)

`remoteEndpoint()` in `src/remote/dispatch.ts` becomes:

1. `CRM_SERVER` + `CRM_TOKEN` env pair → remote (unchanged)
2. `--remote` / config `[remote] server` → remote (unchanged)
3. **explicit local intent** → local. An explicit `--db` names a database and
   beats a saved session; `--local` / `CRM_LOCAL=1` are switches, not targets,
   so they additionally need a nameable database (`--db`, `CRM_DB` or a config
   `[database] path`) — with none of those they fail like step 5
4. a saved session from `crm login` → remote (unchanged)
5. with no session, **local iff** the user's own config file declares
   `[database] path` (writing it into the file *is* the explicit declaration;
   admin-distributed `crm.toml` contains only `[remote]`, so clients are clean
   by construction). Otherwise → **error, no fallback**:

```
Error: not connected — run 'crm login <server>' (get the server address from
your admin console), or use --local/--db for the server host
```

Exit code 1. The message is fixed copy and is asserted by tests.

Which fixed copy a failure takes follows the class of the command that asked:
a **data command** with no target — including a failed explicit `--local` with
nothing to point at — gets this `NOT_CONNECTED`; a **host command** that cannot
name a database gets the `NEEDS_DB` copy from A2. Both exit 1.

- **A project-discovered `crm.toml` counts as "the user's own config", by
  decision.** `loadConfig` finds the nearest `crm.toml` by walking up from the
  cwd, so a `[database] path` checked into a repo enables local mode inside it
  (`loadConfig` strips `[auth]`/`[ldap]`/hooks from such an untrusted config,
  never `[database]`). A `crm.toml` you cd into is a database declaration
  someone authored; the zero-footprint claim covers paths `crm` *invents*, and
  nothing is invented here. Pinned by `test/zero-footprint.test.ts`.
- `--local` / `CRM_LOCAL=1` remain override switches for "logged in but
  target local"; they can no longer conjure local mode by themselves.
  With neither `--db`, `CRM_DB` nor a config `[database] path` they fail with
  the same error (a local target must be nameable).
- The implicit default database path (`~/.crm/crm.db`) is removed from
  `loadConfig` defaults. Config resolution: explicit `--db` > config
  `[database] path` > *unset*. Code that needs a db must handle unset.

### A2. Command classes

- **Data commands** (contact/deal/task/company/log/search/report/dupes/…):
  rule above via `dispatch()`.
- **Host commands** (`serve`, `backup`, `mount`, `unmount`, `export-fs`): run
  where the database lives. `crm admin` is **not** one of them — it is RPC-only
  and reports "Not logged in. Run 'crm login' first" without a session, so it
  never takes this error. They resolve a db path by
  `--db` > config `[database] path`; when unresolvable they fail:
  `Error: server-host command — needs --db or a [database] path in your
  config` (exit 1).
  The filesystem mirror (`crm fs` family) therefore exists only on server
  hosts; client installs cannot produce local data mirrors.
- **Stateless commands** (login/whoami/logout/completion/suggest/config/
  help/version): unchanged; they never touch a database.

### A3. Local-file whitelist (client)

Allowed on a client machine: `~/.crm/credentials` (token file, 0600), the
config file, and user-addressed artifacts (explicit `crm export > file`,
`--chart out.svg`). Everything else is a violation. Enforced by an
automated test: fresh `$HOME`, no server, run data commands + REPL
session, then assert `find $HOME -name '*crm*' -o -name '*.db*'` is empty
(bun's own cache excluded).

### A4. Touch points

`src/remote/dispatch.ts` (case 4 → die), `src/config.ts` (drop default
db path; `[database]` presence becomes meaningful), `src/lib/paths.ts`
(no change), `src/commands/fuse.ts` + `src/export-fs.ts` + host commands
(path guard), `src/server/serve.ts` (`--init` renderConfig already writes
`[database]` — keep), admin console client downloads (`install.sh`/
`crm.toml` already `[remote]`-only — verify copy mentions `crm login`).

### A5. Tests

- New `test/zero-footprint.test.ts` per A3 (functional, fresh HOME).
- `test/enterprise/mode-contract.test.ts` rewritten for the 5-step order
  (existing 4 cases update; add "no fallback" + "CRM_LOCAL alone fails").
- Every existing functional suite passes because `test/helpers.ts` always
  passes explicit `--db`; verify, do not assume.

---

## Sub-project C: interactive REPL

### C1. Entry and session

- `crm` with TTY stdin and no subcommand → REPL. Non-TTY → current usage
  error (machine surface untouched). Hidden `CRM_REPL_FORCE=1` enters the
  REPL regardless of TTY (test seam).
- Prompt `crm>`; right-side status: `not logged in` or
  `admin@host:port ✓`. Line history is in-memory only (readline
  `historySize`) — nothing is persisted from the prompt. Works offline
  until a data command needs a server, then prompts to `login`.
- `login` wizard: server address (skipped when one is already known —
  `CRM_SERVER` or a saved session) → username → password (masked on a TTY;
  on a pipe the prompt echoes and the next line is read plainly, since
  piped input is already visible) → token stored via existing session file
  (A3 whitelist). The wizard hands complete argv to the real `login`
  command — token exchange and session writes live in one place. Dispatch
  holds one `RpcClient` per server for the session's life (one TLS
  handshake per session; transport failures reconnect exactly once before
  reporting an error — structured RPC errors are answers, never retried).
- `--db` at entry: REPL targets the local database directly (server-host
  operators); remote and local REPL share the same command layer because
  both go through `dispatch()`.

### C2. Command grammar

```
crm> login                        wizard login
crm> add                          asks entity, then missing fields
crm> contact 张三                 open contact
crm> contact                      list contacts
crm> log 刚给张三打完电话…        one-line activity; fuzzy-matches the subject
crm> today                        due tasks + stale contacts + pipeline deltas
crm> done                         pick from today's open tasks → mark done
crm> find 张                      global fuzzy search across entities
crm> status / logout / ? / q      session control
```

- Verb-first everywhere: `add|show|edit|rm|list <entity> [ref] [flags...]`.
  Bare verb or unknown entity → wizard asks.
- `log <body>` is a pseudo-entity line: the body is free text, the subject
  is fuzzy-matched and linked; it never enters the verb+entity plane
  where a second token would be read as a flag.
- Entity-first shorthand: `<entity> <ref>` opens; `<entity>` alone lists;
  bare fuzzy-unique word (`张`) opens the unique match across entities,
  ambiguity prints a numbered pick list.
- Aliases: `new`=add, `s`=show, `ls`=list, `e`=edit, `me`=whoami,
  `q`=quit, `?`=help. Flags from one-shot mode keep working (power users).
- Every rendered result ends with one dim "next likely actions" line
  (existing `lib/suggest.ts` scoring, retargeted).

### C3. Wizard engine (missing-args-asked)

Field specs live in `src/repl/fields.ts` — an explicit, REPL-only table and
the wizard's single source of truth (commander flags remain the machine
contract; the registry has no machine-readable param schema, verified).
Behavior: ask missing required fields in table order; entity-typed fields
offer a fuzzy pick from live data (unique match auto-selects); optional
fields skip on empty; required re-asks on empty; `edit` prints a current
value preview and keeps it on empty Enter. The engine is a pure function
over an injected `ask()` interface so it is unit-testable without a TTY.

### C4. Fuzzy layer

- v1: Tab completion over three planes — verbs/aliases (static), flags
  (static), entity refs (dynamic: fetched via RPC, LRU-cached, prefetch
  contacts/tasks at session start). Scoring reuses `lib/suggest.ts`
  (fixes the `contact lst → crm log` class of junk hints by scoping
  candidates to the current plane).
- v1.1 (explicitly deferred): inline ghost-text suggestions accepted with
  →; needs a custom line editor, kept out of v1 scope.

### C5. Architecture (`src/repl/`)

| File | Responsibility |
|---|---|
| `session.ts` | status line, known-server resolution (env → saved session) |
| `parser.ts` | tokenize, alias map, verb/entity resolution, one-shot flag passthrough |
| `fields.ts` | the wizard field-spec table (REPL-only source of truth) |
| `wizard.ts` | table-driven ask-sequence over injected `ask()` |
| `cache.ts` | `RefCache`: warmed entity refs, TTL, inflight coalescing, login re-warm |
| `complete.ts` | plane detection + fuzzy candidate ranking (bun-safe self-drawing completion) |
| `guard.ts` | exit interception (`execGuarded`/`callGuarded`) — a bad line costs the line, never the session |
| `repl.ts` | readline loop wiring the pieces; `handleLine()`-style dispatch, macros, footer |

### C6. Testing

- Unit: parser (aliases/ambiguity), wizard (scripted answers via fake
  `ask()`), completion (fixture rows, plane scoping).
- Functional: real server + `CRM_REPL_FORCE=1`, scripted stdin drives
  login → add → find → done → logout; asserts server-side audit rows.
- A's zero-footprint suite also runs the REPL path.
- Repo gates apply: TDD red→green→mutation-check, ultracite,
  `check-types`, spec docs (README + SKILL.md gain a REPL section and the
  new contract).

---

## Delivery order

**A (≈1–2 days) → C (main body) → B (admin console, separate spec).**
B's final tab set depends on the client surface C ships with.
