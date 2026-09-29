/**
 * The web console, as a single self-contained HTML document (no build step,
 * no external deps, no CDN). Served at `GET /` on the admin port. All data
 * flows through `/api/call` (same RBAC + audit as RPC); secrets never appear
 * here. The server address is injected so the "Clients" tab can render the
 * preconfigured config without a fetch round-trip.
 */

interface ConsoleMeta {
  rpcHost: string
  rpcInsecure: boolean
  rpcPort: number
}

export function consoleHtml(meta: ConsoleMeta): string {
  const serverLabel = `${meta.rpcHost}:${meta.rpcPort}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crm.cli console</title>
<style>
:root{
  --bg:#0e1116; --panel:#161b22; --panel2:#1c2330; --line:#2a3140;
  --fg:#e6edf3; --dim:#8b98a9; --acc:#4c9aff; --ok:#3fb950; --warn:#d29922; --err:#f85149;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:24px 20px 60px}
header{display:flex;align-items:center;gap:14px;margin-bottom:20px}
header .logo{font-weight:700;font-size:18px}
header .logo small{color:var(--dim);font-weight:400}
.spacer{flex:1}
.badge{padding:2px 9px;border-radius:999px;background:var(--panel2);color:var(--acc);font-size:12px;border:1px solid var(--line)}
button{cursor:pointer;background:var(--acc);color:#04121f;border:0;border-radius:8px;padding:8px 14px;font-weight:600}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
button.danger{background:var(--err);color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px;width:100%;font:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid var(--acc);border-color:transparent}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.card h2{margin:0 0 4px;font-size:15px}
.card .sub{color:var(--dim);margin:0 0 14px;font-size:12.5px}
.grid{display:grid;gap:10px}
.grid.c2{grid-template-columns:1fr 1fr}
.grid.c3{grid-template-columns:2fr 1fr 1fr}
label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
tr:hover td{background:var(--panel2)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;border:1px solid var(--line)}
.pill.owner{color:var(--warn)} .pill.admin{color:var(--acc)} .pill.writer{color:var(--ok)} .pill.reader{color:var(--dim)}
.pill.off{color:var(--dim)} .pill.on{color:var(--ok)}
.msg{padding:10px 12px;border-radius:8px;margin-top:10px;font-size:13px;display:none;word-break:break-word}
.msg.ok{display:block;background:rgba(63,185,80,.12);border:1px solid var(--ok);color:#c9f0d0}
.msg.err{display:block;background:rgba(248,81,73,.12);border:1px solid var(--err);color:#f6b6b3}
.msg.warn{display:block;background:rgba(210,153,34,.12);border:1px solid var(--warn);color:#f0d49a}
nav.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
nav.tabs button{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:500;border-radius:999px}
nav.tabs button.active{background:var(--panel2);color:var(--fg);border-color:var(--acc)}
.hidden{display:none}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12.5px;line-height:1.5}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.row>div{flex:1;min-width:120px}
.kv td:first-child{color:var(--dim)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">crm.cli <small>console</small></div>
    <span class="badge" id="serverBadge">${serverLabel}</span>
    <div class="spacer"></div>
    <span class="badge hidden" id="whoami"></span>
    <button class="ghost hidden" id="logout">Log out</button>
  </header>

  <!-- LOGIN -->
  <section id="loginView">
    <div class="card" style="max-width:380px;margin:40px auto">
      <h2>Sign in</h2>
      <p class="sub">Uses your CRM account (local or directory).</p>
      <div class="grid" style="gap:12px">
        <div><label>Username</label><input id="loginUser" autocomplete="username"></div>
        <div><label>Password</label><input id="loginPass" type="password" autocomplete="current-password"></div>
      </div>
      <div class="msg" id="loginMsg"></div>
      <div style="margin-top:14px"><button id="loginBtn" style="width:100%">Sign in</button></div>
    </div>
  </section>

  <!-- MAIN -->
  <section id="mainView" class="hidden">
    <nav class="tabs" id="tabs">
      <button data-tab="users" class="active">Users</button>
      <button data-tab="tokens">Tokens</button>
      <button data-tab="audit">Audit</button>
      <button data-tab="config">Config</button>
      <button data-tab="clients">Clients</button>
    </nav>

    <section id="tab-users">
      <div class="card">
        <h2>Create user</h2>
        <p class="sub">Local accounts only. The one-time password is shown once.</p>
        <div class="grid c3">
          <div><label>Username</label><input id="nuUser" placeholder="jane.doe"></div>
          <div><label>Role</label>
            <select id="nuRole"><option>reader</option><option>writer</option><option>admin</option><option disabled>owner (bootstrap only)</option></select>
          </div>
          <div><label>Email (optional)</label><input id="nuEmail" placeholder="jane@corp"></div>
        </div>
        <div style="margin-top:12px"><button id="nuBtn">Create user</button></div>
        <div class="msg" id="nuMsg"></div>
      </div>
      <div class="card">
        <h2>Users</h2>
        <p class="sub">Directory (LDAP) users show their mapped role.</p>
        <table><thead><tr><th>Username</th><th>Role</th><th>Email</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody id="usersBody"></tbody></table>
      </div>
    </section>

    <section id="tab-tokens" class="hidden">
      <div class="card">
        <h2>Create service token</h2>
        <p class="sub">Tokens are shown once. Bind to a user for scoped automation.</p>
        <div class="grid c3">
          <div><label>Name</label><input id="tkName" placeholder="ci-bot"></div>
          <div><label>Username (optional)</label><input id="tkUser" placeholder="default: you"></div>
          <div><label>Expires (s, 0 = never)</label><input id="tkExp" type="number" value="0" min="0"></div>
        </div>
        <div style="margin-top:12px"><button id="tkBtn">Create token</button></div>
        <div class="msg" id="tkMsg"></div>
      </div>
      <div class="card">
        <h2>Tokens</h2>
        <p class="sub">Revoke a leaked token here.</p>
        <table><thead><tr><th>Name</th><th>User</th><th>Created</th><th>Expires</th><th></th></tr></thead>
        <tbody id="tokensBody"></tbody></table>
      </div>
    </section>

    <section id="tab-audit" class="hidden">
      <div class="card">
        <h2>Recent activity</h2>
        <p class="sub">Hash-chained audit log (most recent first).</p>
        <div class="row" style="margin-bottom:12px">
          <div><label>Filter by actor (optional)</label><input id="auActor"></div>
          <div style="flex:0"><button class="ghost" id="auRefresh">Refresh</button></div>
          <div style="flex:0"><button class="ghost" id="auVerify">Verify chain</button></div>
        </div>
        <div class="msg" id="auMsg"></div>
        <table><thead><tr><th>Seq</th><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead>
        <tbody id="auditBody"></tbody></table>
      </div>
    </section>

    <section id="tab-config" class="hidden">
      <div class="card">
        <h2>Server configuration</h2>
        <p class="sub">Read-only view. Secrets are never returned — only "is it set".</p>
        <div id="cfgView"><p class="sub">Loading…</p></div>
      </div>
    </section>

    <section id="tab-clients" class="hidden">
      <div class="card">
        <h2>Onboard a client</h2>
        <p class="sub">Embeds this server's address so colleagues never type <span class="mono">--server</span> / <span class="mono">--insecure</span>.</p>
        <div class="row" style="margin-bottom:14px">
          <div style="flex:0"><a href="/download/crm.toml" download="crm.toml"><button class="ghost">Download crm.toml</button></a></div>
          <div style="flex:0"><a href="/download/install.sh" download="install.sh"><button class="ghost">Download install.sh</button></a></div>
        </div>
        <label>Preconfigured config</label>
        <pre id="clientCfg"></pre>
        <p class="sub">Usage: put <span class="mono">crm.toml</span> at <span class="mono">~/.crm/config.toml</span>, then run <span class="mono">crm login</span>. Or run <span class="mono">install.sh</span> to do both.</p>
      </div>
    </section>
  </section>
</div>

<script>
(function () {
  "use strict";
  var token = localStorage.getItem("crm_token") || null;
  var who = null;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function showMsg(id, kind, text) {
    var m = el(id);
    m.className = "msg " + kind;
    m.textContent = text;
  }
  function fmtDate(s) {
    if (!s) return "—";
    var d = new Date(s);
    return isNaN(d) ? esc(s) : d.toLocaleString();
  }

  async function api(path, opts) {
    var headers = Object.assign({ "Content-Type": "application/json" }, (opts && opts.headers) || {});
    if (token) headers["Authorization"] = "Bearer " + token;
    var r = await fetch(path, Object.assign({}, opts, { headers: headers }));
    var data = null;
    try { data = await r.json(); } catch (e) { data = {}; }
    if (!r.ok) {
      var msg = (data && data.error && data.error.message) || ("HTTP " + r.status);
      var err = new Error(msg);
      err.status = r.status;
      err.code = data && data.error && data.error.code;
      throw err;
    }
    return data;
  }
  function call(method, params) {
    return api("/api/call", { method: "POST", body: JSON.stringify({ method: method, params: params || {} }) });
  }

  function setAuthed() {
    el("loginView").classList.add("hidden");
    el("mainView").classList.remove("hidden");
    el("whoami").classList.remove("hidden");
    el("logout").classList.remove("hidden");
    el("whoami").textContent = (who ? who.username + " · " + who.role : "");
    el("whoami").style.color = who && who.role === "owner" ? "var(--warn)" : "var(--acc)";
    if (who && (who.role === "owner" || who.role === "admin")) {
      loadUsers(); loadTokens(); loadAudit(); loadConfig();
    } else {
      showMsg("auMsg", "warn", "Read-only role — user/token/admin sections are hidden. Audit is available.");
      loadAudit();
    }
    el("clientCfg").textContent = clientCfgText();
  }
  function setLogin() {
    el("mainView").classList.add("hidden");
    el("loginView").classList.remove("hidden");
    el("whoami").classList.add("hidden");
    el("logout").classList.add("hidden");
  }
  function clientCfgText() {
    var host = "${meta.rpcHost}", port = ${meta.rpcPort}, insecure = ${meta.rpcInsecure};
    return "# Generated by crm.cli console — " + host + ":" + port + "\\n" +
      "# Install at ~/.crm/config.toml, then run:  crm login\\n" +
      "[remote]\\nserver = \\"" + host + ":" + port + "\\"\\ninsecure = " + insecure + "\\n";
  }

  // ---- Users ----
  function loadUsers() {
    call("admin.user.list").then(function (d) {
      var rows = (d.result && d.result.users) || [];
      el("usersBody").innerHTML = rows.map(function (u) {
        var status = u.disabled ? '<span class="pill off">disabled</span>'
          : (u.locked ? '<span class="pill on">locked</span>' : '<span class="pill on">active</span>');
        var btns = "";
        if (u.role !== "owner" && !u.disabled) {
          btns = '<button class="ghost" data-aug="1" data-u="' + esc(u.username) + '">disable</button> ';
        }
        if (u.disabled) {
          btns = '<button class="ghost" data-auen="1" data-u="' + esc(u.username) + '">enable</button> ';
        }
        return "<tr><td class='mono'>" + esc(u.username) + "</td>" +
          "<td><span class='pill " + esc(u.role) + "'>" + esc(u.role) + "</span></td>" +
          "<td>" + esc(u.email || "—") + "</td><td>" + status + "</td>" +
          "<td>" + fmtDate(u.created_at) + "</td><td>" + btns + "</td></tr>";
      }).join("");
      el("usersBody").querySelectorAll("button[data-aug]").forEach(function (b) {
        b.onclick = function () { call("admin.user.disable", { username: b.dataset.u }).then(loadUsers, function (e) { showMsg("nuMsg", "err", e.message); }); };
      });
      el("usersBody").querySelectorAll("button[data-auen]").forEach(function (b) {
        b.onclick = function () { call("admin.user.enable", { username: b.dataset.u }).then(loadUsers, function (e) { showMsg("nuMsg", "err", e.message); }); };
      });
    }).catch(function (e) { showMsg("nuMsg", "err", e.message); });
  }

  // ---- Tokens ----
  function loadTokens() {
    call("admin.token.list").then(function (d) {
      var rows = (d.result && d.result.tokens) || [];
      el("tokensBody").innerHTML = rows.map(function (t) {
        var exp = t.expires_at ? fmtDate(t.expires_at) : "never";
        return "<tr><td class='mono'>" + esc(t.name) + "</td><td>" + esc(t.username) + "</td>" +
          "<td>" + fmtDate(t.created_at) + "</td><td>" + exp + "</td>" +
          "<td><button class='ghost danger' data-rev='" + esc(t.id) + "'>revoke</button></td></tr>";
      }).join("");
      el("tokensBody").querySelectorAll("button[data-rev]").forEach(function (b) {
        b.onclick = function () { call("admin.token.revoke", { id: b.dataset.rev }).then(loadTokens, function (e) { showMsg("tkMsg", "err", e.message); }); };
      });
    }).catch(function (e) { showMsg("tkMsg", "err", e.message); });
  }

  // ---- Audit ----
  function loadAudit() {
    var actor = el("auActor").value.trim();
    call("audit.list", actor ? { actor: actor, limit: 100 } : { limit: 100 }).then(function (d) {
      var rows = (d.result && d.result.rows) || [];
      el("auditBody").innerHTML = rows.map(function (a) {
        return "<tr><td>" + esc(a.seq) + "</td><td>" + fmtDate(a.at) + "</td>" +
          "<td class='mono'>" + esc(a.actor_name || "—") + "</td>" +
          "<td class='mono'>" + esc(a.action) + "</td>" +
          "<td class='mono'>" + esc((a.entity_type || "") + (a.entity_id ? ":" + a.entity_id : "")) + "</td>" +
          "<td class='mono'>" + esc(a.ip || "—") + "</td></tr>";
      }).join("");
    }).catch(function (e) { showMsg("auMsg", "err", e.message); });
  }

  // ---- Config ----
  function kv(pairs) {
    return "<table class='kv'>" + pairs.map(function (p) {
      return "<tr><td>" + esc(p[0]) + "</td><td class='mono'>" + esc(p[1]) + "</td></tr>";
    }).join("") + "</table>";
  }
  function onoff(b) { return b ? "yes" : "no"; }
  function loadConfig() {
    api("/api/config").then(function (c) {
      var h = "";
      h += "<h2 style='font-size:13px;margin-bottom:6px'>Serve</h2>" +
        kv([["rpc host:port", "${meta.rpcHost}:${meta.rpcPort}"]]);
      h += "<h2 style='font-size:13px;margin:14px 0 6px'>Auth</h2>" +
        kv([["default_role", c.auth.default_role], ["lockout", c.auth.lockout_threshold + " in " + c.auth.lockout_minutes + "min"],
            ["min password len", c.auth.password_min_length], ["login rate /ip /min", c.auth.login_rate_per_minute],
            ["login rate /user /min", c.auth.login_user_rate_per_minute]]);
      h += "<h2 style='font-size:13px;margin:14px 0 6px'>LDAP directory</h2>";
      if (c.ldap.enabled) {
        var roleLines = Object.keys(c.ldap.roles || {}).map(function (g) { return g + " → " + c.ldap.roles[g]; });
        h += kv([["url", c.ldap.url], ["starttls", onoff(c.ldap.starttls)], ["base_dn", c.ldap.base_dn],
          ["bind_dn", c.ldap.bind_dn], ["bind password", c.ldap.bind_password_set ? "set (" + c.ldap.bind_password_env + ")" : "NOT SET"],
          ["user_filter", c.ldap.user_filter], ["group_base_dn", c.ldap.group_base_dn],
          ["group→role", roleLines.join(", ") || "—"], ["tls_skip_verify", onoff(c.ldap.tls_skip_verify)]]);
      } else {
        h += "<p class='sub'>Not enabled — add [ldap] to the server crm.toml.</p>";
      }
      h += "<h2 style='font-size:13px;margin:14px 0 6px'>Email (SMTP)</h2>";
      if (c.mail.configured) {
        h += kv([["host", c.mail.host + ":" + c.mail.port], ["from", c.mail.from || c.mail.user],
          ["secure", onoff(c.mail.secure)], ["password", c.mail.password_set ? "set (CRM_SMTP_PASSWORD)" : "NOT SET"]]);
      } else {
        h += "<p class='sub'>Not configured — add [mail] to the server crm.toml to enable crm email send.</p>";
      }
      el("cfgView").innerHTML = h;
    }).catch(function (e) { el("cfgView").innerHTML = "<p class='sub'>" + esc(e.message) + "</p>"; });
  }

  // ---- Wire up ----
  function switchTab(name) {
    document.querySelectorAll("nav.tabs button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    ["users", "tokens", "audit", "config", "clients"].forEach(function (t) {
      el("tab-" + t).classList.toggle("hidden", t !== name);
    });
  }

  el("loginBtn").onclick = function () { doLogin(); };
  el("loginPass").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
  async function doLogin() {
    el("loginBtn").disabled = true;
    try {
      var d = await api("/api/login", { method: "POST", body: JSON.stringify({ username: el("loginUser").value, password: el("loginPass").value }) });
      token = d.token;
      localStorage.setItem("crm_token", token);
      who = d.user ? { username: d.user.username, role: d.user.role } : null;
      el("loginPass").value = "";
      setAuthed();
    } catch (e) {
      showMsg("loginMsg", "err", e.message);
    } finally { el("loginBtn").disabled = false; }
  }

  el("logout").onclick = function () {
    localStorage.removeItem("crm_token");
    token = null; who = null;
    setLogin();
  };

  el("nuBtn").onclick = function () {
    call("admin.user.create", {
      username: el("nuUser").value, role: el("nuRole").value,
      email: el("nuEmail").value || undefined,
    }).then(function (d) {
      var u = d.result.user, pw = d.result.initial_password;
      showMsg("nuMsg", "ok", 'Created ' + u.username + ' (' + u.role + '). One-time password: ' + pw);
      el("nuUser").value = ""; el("nuEmail").value = "";
      loadUsers();
    }).catch(function (e) { showMsg("nuMsg", "err", e.message); });
  };

  el("tkBtn").onclick = function () {
    var exp = Number(el("tkExp").value || 0);
    call("admin.token.create", {
      name: el("tkName").value,
      username: el("tkUser").value || undefined,
      expires_in_seconds: exp,
    }).then(function (d) {
      showMsg("tkMsg", "ok", "Token (shown once): " + d.result.token);
      el("tkName").value = "";
      loadTokens();
    }).catch(function (e) { showMsg("tkMsg", "err", e.message); });
  };

  el("auRefresh").onclick = loadAudit;
  el("auVerify").onclick = function () {
    call("audit.verify").then(function (d) {
      var r = d.result;
      if (r.ok) showMsg("auMsg", "ok", "Chain intact (" + r.chained + " rows" + (r.genesis_seq != null ? ", genesis " + r.genesis_seq : "") + ").");
      else showMsg("auMsg", "err", "Chain broken at seq " + r.broken_seq + ": " + (r.reason || "unknown"));
    }).catch(function (e) { showMsg("auMsg", "err", e.message); });
  };

  document.querySelectorAll("nav.tabs button").forEach(function (b) {
    b.onclick = function () { switchTab(b.dataset.tab); };
  });

  // boot
  (function boot() {
    if (!token) { setLogin(); return; }
    api("/api/me").then(function (d) {
      who = { username: d.username, role: d.role };
      setAuthed();
    }).catch(function (e) {
      localStorage.removeItem("crm_token");
      token = null;
      setLogin();
    });
  })();
})();
</script>
</body>
</html>`
}
