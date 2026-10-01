---
name: crm-cli
description: Manage contacts, companies, deals, and pipeline with crm.cli — a headless CLI-first CRM backed by SQLite with a virtual filesystem interface
install: curl -fsSL https://raw.githubusercontent.com/dzhng/crm.cli/main/install.sh | sh
---

# crm.cli

A headless, CLI-first CRM. Contacts, deals, and pipeline in a single SQLite file — queryable from your terminal, composable with Unix tools, and mountable as a virtual filesystem.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dzhng/crm.cli/main/install.sh | sh
```

This downloads the precompiled binary to `~/.local/bin` and installs mount dependencies (FUSE on Linux, Rust toolchain on macOS for NFS).

After install, make sure `~/.local/bin` is in your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify:

```bash
crm -V
```

## Configuration

Optional. Create `crm.toml` in your project root or `~/.crm/config.toml`:

```toml
[database]
path = "~/.crm/crm.db"    # declares this machine's local database (see Modes below)

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"

[defaults]
format = "table"

[phone]
default_country = "US"
display = "international"

[mount]
default_path = "~/crm"
```

Config is auto-discovered by walking up from the current directory. Override with `--config <path>` or `CRM_CONFIG` env var.

`[database] path` is what makes a machine a **local** one — writing that line is the declaration; without it (and without `--db`) nothing points at a file. A server-issued `crm.toml` contains `[remote]` only, so a client stays a client.

## Global Flags

Every command accepts:

- `--db <path>` — SQLite database path (env: `CRM_DB`). No default: local
  commands need a path from here or from `[database] path` in your config
- `--format <fmt>` — Output format: `table`, `json`, `csv`, `tsv`, `ids`
- `--config <path>` — TOML config file path
- `--remote [addr]` — run data commands against a server (env: `CRM_SERVER`)
- `--insecure` — skip TLS certificate verification, self-signed certs (env: `CRM_INSECURE`)
- `--no-color` — Disable colored output

## Modes: a server, or a database you name

Every command resolves its target in this order — first match wins:

1. `CRM_SERVER` **and** `CRM_TOKEN` set → remote (the agent/service pattern)
2. `--remote [addr]` or `[remote] server` in config → remote
3. Local intent → local. `--db <path>` names a database and beats a logged-in session; `--local` / `CRM_LOCAL=1` are switches and additionally need a database to point at (`--db`, `CRM_DB` or `[database] path`)
4. A saved `crm login` session → remote; no session but `[database] path` in your own config → local
5. Nothing named → nothing runs. No database is created, no file is guessed

Two failures you will see, both **exit 1** (fixed copy, match on the prefix):

| Error | Means | Do |
|---|---|---|
| `Error: not connected — run 'crm login <server>' (get the server address from your admin console), or use --local/--db for the server host` | No server configured and no database named | Ask the human for the server address (or have them log in), or pass `--db <path>` |
| `Error: server-host command — needs --db or a [database] path in your config` | `serve` / `backup` / `mount` / `export-fs` / `admin` run where the database lives and nothing named it | Re-run on the database host with `--db <path>` |

A remote command is byte-identical to the local one — the same service layer runs on the server. In remote mode no local database is opened: a client machine holds no CRM records (what it does hold is `~/.crm/credentials` — a 0600 token — plus whatever config you put there).

## Contacts

### Create a contact

```bash
crm contact add --name "Jane Doe" \
  --email jane@acme.com \
  --phone "+1-212-555-1234" \
  --linkedin linkedin.com/in/janedoe \
  --company "Acme Corp" \
  --tag hot-lead \
  --set title=CTO
```

All flags are optional except `--name`. Phones are normalized to E.164, LinkedIn URLs are extracted to handles, companies are auto-created if they don't exist. `--email`, `--phone`, `--company`, `--tag`, and `--set` are all repeatable.

Social handle flags: `--linkedin`, `--x`, `--bluesky`, `--telegram`. All accept raw handles or full URLs.

### List contacts

```bash
crm contact list
crm contact list --tag hot-lead --company "Acme Corp"
crm contact list --filter "title~=CTO AND company=Acme" --sort name --limit 20
crm contact list --format json | jq '.[].name'
```

Filter operators: `=`, `!=`, `~=` (contains), `>`, `<`. Combine with `AND` / `OR`.

### Show a contact

Look up by ID, email, phone, or social handle:

```bash
crm contact show ct_01J8ZVXB3K...
crm contact show jane@acme.com
crm contact show "+12125551234"
crm contact show janedoe          # LinkedIn handle
```

### Edit a contact

```bash
crm contact edit jane@acme.com --name "Jane Smith"
crm contact edit "+12125551234" --add-email jane2@acme.com --rm-tag old-tag
crm contact edit janedoe --add-company "New Corp" --set title=CEO --unset source
```

Add/remove flags: `--add-email`, `--rm-email`, `--add-phone`, `--rm-phone`, `--add-company`, `--rm-company`, `--add-tag`, `--rm-tag`. Social handles set directly: `--linkedin`, `--x`, `--bluesky`, `--telegram`.

### Delete a contact

```bash
crm contact rm jane@acme.com
crm contact rm "+12125551234" --force    # skip confirmation
crm contact rm janedoe                   # by social handle
```

### Merge contacts

Merge two contacts into one. First contact survives, second is absorbed and deleted. Accepts any reference type:

```bash
crm contact merge ct_01A... ct_01B...
crm contact merge jane@acme.com jane.doe@acme.com
crm contact merge "+12125551234" "+14155559876"
crm contact merge janedoe jane-doe-linkedin
```

Combines emails, phones, companies, tags, custom fields, and relinks all deals and activity.

## Companies

### Create a company

```bash
crm company add --name "Acme Corp" \
  --website acme.com \
  --phone "+1-800-555-0000" \
  --tag enterprise \
  --set industry=SaaS
```

`--website`, `--phone`, `--tag`, `--set` are repeatable.

### List / show / edit / delete

```bash
crm company list --tag enterprise
crm company show acme.com                        # by website
crm company show "+18005550000"                  # by phone
crm company edit acme.com --name "Acme Inc" --add-website acme.io
crm company rm acme.com --force
```

### Merge companies

```bash
crm company merge co_01A... co_01B...
crm company merge acme.com acme.io
crm company merge "+18005550000" "+18005550001"
```

Relinks all contacts and deals from second to first.

## Deals

### Create a deal

```bash
crm deal add --title "Acme Enterprise" \
  --value 50000 \
  --stage qualified \
  --contact jane@acme.com \
  --company acme.com \
  --expected-close 2026-06-15 \
  --probability 60 \
  --tag enterprise
```

Contacts and companies are auto-created if they don't exist. `--contact` and `--tag` are repeatable.

### List deals

```bash
crm deal list --stage qualified --min-value 10000
crm deal list --contact jane@acme.com --sort value --reverse
crm deal list --format ids | wc -l    # count deals
```

### Move a deal through the pipeline

```bash
crm deal move dl_01... --stage proposal --note "Sent pricing deck"
crm deal move dl_01... --stage closed-won --note "Signed 2-year contract"
```

Stage transitions are recorded as activity with timestamps. Use `deal move`, not `deal edit --stage`.

### Edit / delete

```bash
crm deal edit dl_01... --value 75000 --add-contact bob@acme.com --probability 80
crm deal rm dl_01... --force
```

### Pipeline overview

```bash
crm pipeline
```

Shows count, total value, and weighted value per stage.

## Activity Logging

### Log an activity

```bash
crm log note "Had coffee with Jane, discussed Q3 expansion" --contact jane@acme.com
crm log call "Demoed product, she wants a proposal" --contact jane@acme.com --deal dl_01...
crm log meeting "Quarterly review" --company acme.com --at 2026-04-01
crm log email "Sent follow-up pricing" --contact jane@acme.com --set channel=outbound
```

Types: any configured type (`[activity] types` in `crm.toml`; default `note`,
`call`, `meeting`, `email`). Add a team's real cadence (wechat, visit,
entertainment, dingtalk) in config — no code change. Contacts and companies
are auto-created. `--contact` is repeatable. `--at` overrides the timestamp.

### List activities

```bash
crm activity list --contact jane@acme.com --since 2026-01-01
crm activity list --type call --limit 10
crm activity list --deal dl_01... --format json
```

## Tasks

Follow-up to-dos (open by default). Link to a contact/deal so the "what next"
is traceable.

```bash
crm task add "Call Acme re: renewal" --due 2026-07-01 --owner lin
crm task list --due-today            # open tasks due today
crm task list --overdue              # open tasks past due
crm task list --mine                 # my tasks (remote mode)
crm task done "Call Acme re: renewal"
crm task rm "Call Acme re: renewal" --force
```

`task show/done/rm` take an id (`tk_…`) or an exact title; ambiguous titles
exit 3.

## Ownership

Assign contacts/deals/tasks to a person and filter by it:

```bash
crm contact add 'Acme 张' --owner lin
crm contact list --mine              # my rows (remote mode)
crm deal add 'Q3 报价' --owner lin --stage qualified
crm deal list --owner lin
```

`--mine` is server-authoritative in remote mode (a client can't forge the
caller). Locally there is one user, so `--mine` keeps all rows.

## Tags

```bash
crm tag jane@acme.com hot-lead enterprise      # add tags
crm untag jane@acme.com old-tag                 # remove tags
crm tag list                                     # all tags with counts
crm tag list --type contact                      # contact tags only
```

Tags work on contacts, companies, and deals.

## Search

### Exact keyword search (FTS5)

```bash
crm search "acme CTO"
crm search "jane" --type contact
```

### Fuzzy / semantic search

```bash
crm find "fintech startup London"
crm find "that CTO I met at the conference" --limit 5 --threshold 0.3
```

### Rebuild search index

```bash
crm index rebuild
crm index status
```

Index updates automatically on writes. Manual rebuild only needed after corruption.

## Duplicate Detection

```bash
crm dupes
crm dupes --type contact --threshold 0.5
crm dupes --type company --limit 20
```

Uses combined Levenshtein + Dice coefficient similarity. Detects: similar names, shared emails, shared phones, shared websites, shared social handles. Review then merge:

```bash
crm dupes --type contact
# → Jane Doe ↔ J. Doe: similar name, shared email
crm contact merge ct_01A... ct_01B...
```

## Reports

```bash
crm report pipeline                                  # stage counts & values
crm report activity --period 30d --by type           # activity volume
crm report stale --days 14 --type contact            # no recent activity
crm report conversion --since 2026-01-01             # stage-to-stage rates
crm report velocity --won-only                       # time per stage
crm report forecast --period 2026-Q2                 # weighted forecast
crm report won --period 90d                          # closed-won summary
crm report lost --period 90d                         # closed-lost summary
```

## Import / Export

### Import from CSV or JSON

```bash
crm import contacts leads.csv
crm import contacts leads.json --update     # update existing by email match
crm import companies companies.csv --dry-run
crm import deals deals.csv --skip-errors
cat data.json | crm import contacts -        # import from stdin
```

CSV headers: `name`, `email`/`emails`, `phone`/`phones`, `address`/`addresses`, `company`/`companies`, `tags`, `linkedin`, `x`, `bluesky`, `telegram`. Unrecognized columns become custom fields.

### Export

```bash
crm export contacts --format csv > contacts.csv
crm export companies --format json > companies.json
crm export deals --format tsv
crm export all --format json > full-backup.json
```

## Virtual Filesystem (Mount)

Mount the CRM as a live read/write filesystem. Any tool that reads files gets full CRM access — AI agents, grep, jq, vim, scripts.

### Mount

```bash
crm mount ~/crm
crm mount ~/crm --db ./team.db
crm mount ~/crm --readonly
```

Mounting reads the database directly, so it is a host command: it needs the path named (`--db`, or `[database] path` in the config you pass) and fails with the `server-host command` error otherwise.

On Linux this uses FUSE. On macOS this uses an NFS v3 server (no kernel extensions needed).

### Filesystem layout

```
~/crm/
├── llm.txt                           # Instructions for AI agents
├── contacts/
│   ├── ct_01...jane-doe.json         # Contact JSON files
│   ├── _by-email/                    # Lookup by email
│   ├── _by-phone/                    # Lookup by E.164 phone
│   ├── _by-linkedin/                 # Lookup by LinkedIn handle
│   ├── _by-x/                        # Lookup by X handle
│   ├── _by-company/                  # Grouped by company
│   └── _by-tag/                      # Grouped by tag
├── companies/
│   ├── co_01...acme-corp.json
│   ├── _by-website/
│   ├── _by-phone/
│   └── _by-tag/
├── deals/
│   ├── dl_01...acme-enterprise.json
│   ├── _by-stage/
│   ├── _by-company/
│   └── _by-tag/
├── activities/
│   ├── _by-contact/
│   ├── _by-company/
│   ├── _by-deal/
│   └── _by-type/
├── reports/                          # Pre-computed analytics
│   ├── pipeline.json
│   ├── forecast.json
│   ├── stale.json
│   ├── conversion.json
│   ├── velocity.json
│   ├── won.json
│   └── lost.json
├── pipeline.json                     # Quick pipeline overview
├── tags.json                         # All tags with counts
└── search/                           # Search by reading files
    └── <query>.json                  # cat search/"acme CTO".json
```

### Read via filesystem

```bash
ls ~/crm/contacts/
cat ~/crm/contacts/ct_01...jane-doe.json | jq .
cat ~/crm/contacts/_by-email/jane@acme.com.json
cat ~/crm/deals/_by-stage/qualified/
cat ~/crm/reports/forecast.json
cat ~/crm/search/"enterprise deals".json
```

### Write via filesystem

```bash
# Create a contact
echo '{"name":"Bob Smith","emails":["bob@globex.com"]}' > ~/crm/contacts/new.json

# Update (read → modify → write back)
cat ~/crm/contacts/ct_01...jane-doe.json | jq '.tags += ["vip"]' > ~/crm/contacts/ct_01...jane-doe.json

# Delete
rm ~/crm/contacts/ct_01...jane-doe.json
```

### Unmount

```bash
crm unmount ~/crm
```

### Static export (no mount needed)

```bash
crm export-fs ./crm-snapshot
```

Exports the same directory structure as a static copy — useful in containers or sandboxes where FUSE isn't available. Host command: name the database (`--db <path>`) or declare it in your config.

## Bulk Operations

Use `--format ids` to pipe into other commands:

```bash
# Tag all contacts from Acme as enterprise
crm contact list --company "Acme Corp" --format ids | xargs -I{} crm tag {} enterprise

# Move all qualified deals over $50k to proposal
crm deal list --stage qualified --min-value 50000 --format ids | \
  xargs -I{} crm deal move {} --stage proposal

# Delete all stale contacts
crm report stale --days 90 --type contact --format ids | xargs -I{} crm contact rm {} --force
```

## Custom Fields

All entities support arbitrary key-value fields:

```bash
crm contact add --name "Jane" --set title=CTO --set source=conference
crm contact edit jane@acme.com --set "json:score=85" --set "json:verified=true"
crm contact edit jane@acme.com --unset source
crm contact list --filter "title~=CTO"
```

Prefix with `json:` for typed values (numbers, booleans, arrays).

## Hooks

Configure shell hooks in `crm.toml` that fire on mutations:

```toml
[hooks]
post-contact-add = "~/.crm/hooks/notify-slack.sh"
post-deal-stage-change = "~/.crm/hooks/deal-moved.sh"
pre-contact-rm = "~/.crm/hooks/confirm-delete.sh"
```

Entity data is passed as JSON on stdin. Pre-hooks abort on non-zero exit.

> **Security:** a `crm.toml` discovered by walking up from the current directory (e.g. checked into a repo) only runs hooks when it explicitly sets `[hooks] enabled = true`. Explicit configs (`--config`) and the global `~/.crm/config.toml` are trusted as-is. Never add the marker to a config you have not reviewed.

Available hooks: `{pre,post}-{contact,company,deal}-{add,edit,rm}`, `{pre,post}-deal-stage-change`, `{pre,post}-activity-add`.

## Tips for AI Agents

- **Mount first:** `crm mount ~/crm` gives you filesystem access — read JSON files directly instead of running CLI commands. It reads the database locally, so it needs the path named and does not work against a remote server
- **Read `llm.txt`:** The mount point contains `llm.txt` with structure docs and tips
- **Use `_by-*` directories** for fast lookups: `_by-email`, `_by-phone`, `_by-linkedin`, `_by-tag`, `_by-stage`
- **Use `--format json`** for all CLI output when processing programmatically
- **Use `--format ids`** + `xargs` for bulk operations
- **Read `reports/`** for pre-computed analytics — don't recompute from raw data
- **Search via filesystem:** `cat ~/crm/search/"your query".json`
- **Write via filesystem:** Create/update entities by writing JSON files
- **All JSON files are self-contained** — no need to join across files
- **Phone numbers** accept any format on input; stored as E.164 internally
- **Social handles** accept full URLs; stored as clean handles
- **Refs** — `show`/`edit`/`rm`/`move` and `--contact`/`--company`/`--deal` accept id, name, email, phone, website, social handle, or deal title (case-insensitive, exact). Names match exactly only; a prefix of another name does NOT match.
- **Ambiguous ref → exit 3** lists every candidate with its id; re-run with the id (or email) to pick one. Exit 3 always means "recoverable — read the printed candidates/version and retry".
- **Positional name:** `crm contact add "Jane Doe" --email jane@acme.com` (the name/title can be the first argument instead of `--name`/`--title`).
- **Addresses:** `crm contact add --address "..."` (repeatable) / `crm contact edit --add-address` / `--rm-address`; exposed as `addresses[]` in rows.
- **`open_deal` column:** every `contact list` row carries `open_deal` — the contact's open (non won/lost) deal as `title (stage, value)`, biggest first, `+N more` when several. Use it to answer "who do I chase this week" without a join.
- **Modes:** see [Modes: a server, or a database you name](#modes-a-server-or-a-database-you-name). After `crm login`, data commands default to the server; local mode needs a database you named (`--db`, or `--local` with one). Agents should keep using the env pattern (`CRM_SERVER` + `CRM_TOKEN`) — a session file is a human artifact. A command that names neither fails with exit 1 (`not connected`); ask the human rather than guessing a path.
- **Charts:** `crm report pipeline|activity|conversion|velocity|forecast|won|lost --chart` prints a terminal bar chart; `--chart out.svg` writes a standalone SVG (no deps). Use it when the user wants a visual.
- **`crm suggest <words>`** finds the command for a fuzzy description (English or Chinese, e.g. `suggest 删除 客户` → `crm contact rm`). If a command fails with `unknown command`, the printed `hint:` block already lists the closest matches — read it instead of guessing.
- **Outbound email:** `crm email send <contact> --subject ... --body ...` sends through the server's SMTP relay (needs `[mail]` + `CRM_SMTP_PASSWORD` on the server) and auto-logs an `email` activity — prefer it over shelling out to `mail`/SMTP so the CRM record stays current. Recipient defaults to the contact's first email; `--to`/`--cc`/`--body-file`/`--deal` available. Writer+ only.
- **Web console JSON API:** when a server runs `--admin-port`, `POST http://<admin>/api/call` with `Authorization: Bearer <token>` and body `{"method":"...","params":{...}}` invokes any RPC method (same RBAC + audit) — handy for automation that already has a token. `GET /download/crm.toml` on the admin port returns the preconfigured client config for onboarding humans.
