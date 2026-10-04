# Server public identity + config surface (D)

Console/agent review of the admin surface (sub-project B) exposed two
gaps in the enterprise onboarding story. This spec covers both; A is the
identity fix, B is the config-surface completion.

## A — `[serve] public_host` / `public_port`

**Problem.** The client-facing address that the server advertises
(`crm login <addr>` hint at startup, the console Clients tab,
`/download/crm.toml`, `/download/install.sh`) is derived from the
*bind interface*: `--host 0.0.0.0` falls back to `127.0.0.1`. In the
standard enterprise topology (bind `0.0.0.0`, exposed as
`crm.internal:8443` behind DNS/VPN/proxy) every remote user would be
handed `127.0.0.1:8443` and could never log in. This breaks the P8
promise that ordinary users never type `--server`.

**Contract.**

```toml
[serve]
public_host = "crm.internal"  # optional; empty/absent = bind-derived (today's behavior)
public_port = 443             # optional; empty/absent = the actual bound port
```

- When set, the advertised address is `public_host:public_port`
  (either may be set independently: `public_host` alone keeps the
  real bound port; `public_port` alone keeps the bind-derived host).
- Propagation points (all share one computed value — no per-site logic):
  1. `serve` startup hint: `clients: crm login <advertised>`
  2. console Clients tab one-liner
  3. `/download/crm.toml` — `[remote] server = "<advertised>"`
  4. `/download/install.sh` — same
  5. config view — `serve.rpc_host` / `serve.rpc_port` already
     surface the advertised value, so the Config tab follows.
- **Not changed, deliberately:**
  - `crm status` keeps showing the address the *client* dialed (it is a
    client-side view of the session, not the server's self-introduction).
  - The `insecure` flag in downloads is still derived from the TLS
    material (default self-signed → `insecure = true`); a proxy that
    terminates TLS in front of the RPC port would set
    `public_port` accordingly and manage trust itself.
  - No Host-header sniffing: it is fragile behind load balancers and
    conflates the admin-port host with the RPC host. The explicit
    config value is the only source of the public identity.
- Backward compatible: absent fields reproduce today's behavior
  exactly.

## B — Config surface completion

**Problem.** The console Config tab (a) shows only
`serve/auth/ldap/mail` while the server also acts on `[database]`,
`[backup]`, `[activity]`, `[pipeline]`; and (b) never says *where* the
config lives or *how* to change it, so an operator cannot act on what
they see.

**Contract.**

- The config view gains the missing sections, sanitized like the rest
  (no secret material; boolean "is it set" flags only):
  `database.path`, `backup.destination`, `activity.types`,
  `pipeline.stages/won_stage/lost_stage`. `[mount]` and `[remote]` are
  client-side/host-side and stay out of the server view.
- The view carries `path` (the resolved config file path, or `"(defaults)"`
  when running pure defaults) so the tab answers "which file?".
- The Config tab renders: the path, a copyable **sanitized TOML** of the
  current effective config (secrets shown as `已设置/omitted`), and a
  visible note that changes take effect after a restart (the server
  reads config once at boot).
- **No HTTP write path in v1.** Editing config from the console is
  deferred: changes need a restart to take effect (editing would be
  silently inert), secrets live in host environment variables the
  console cannot set, and writing a config file over the plain-HTTP
  admin port enlarges the attack surface. This is a deliberate
  product decision, not an omission.

## Out of scope

- Config hot-reload (prerequisite for any console write path).
- Per-request Host-header address inference.
- Public-identity-aware `crm status` output.
