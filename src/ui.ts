// agent-oauth UI — login, dashboard, tenant wizard, audit log
import { Hono } from "hono";
import { auth } from "./auth.js";
import { prisma } from "./db.js";
import { encrypt } from "./crypto.js";
import { PROVIDERS, getProvider, listProviders, toolsForProvider } from "./connectors/registry.js";

export const dashboardApp = new Hono();

// Separate Hono app for OAuth flows (mounted at /oauth in server.ts).
// Not under /ui because GitHub's OAuth callback URL needs to be a stable
// public path; keeping it outside the UI mount makes the contract cleaner.
export const oauthApp = new Hono();
// Minimal HTML escape — used for user-supplied strings in error messages.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;"
  );
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0e0f12; color: #e1e3e6; margin: 0; line-height: 1.5; }
  a { color: #6ea8fe; text-decoration: none; }
  a:hover { text-decoration: underline; }
  nav { display: flex; gap: 16px; padding: 12px 24px; border-bottom: 1px solid #2a2d33; background: #14161a; }
  nav .brand { font-weight: 700; }
  nav a { color: #c8ccd2; padding: 6px 10px; border-radius: 4px; }
  nav a:hover, nav a.active { background: rgba(110,168,254,0.1); color: #6ea8fe; text-decoration: none; }
  main { max-width: 960px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 28px; margin: 0 0 24px; }
  h2 { font-size: 18px; margin: 24px 0 12px; color: #c8ccd2; }
  .card { background: #14161a; border: 1px solid #2a2d33; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .row { display: flex; gap: 12px; align-items: center; }
  .row.spread { justify-content: space-between; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.scoped { background: rgba(110,168,254,0.16); color: #6ea8fe; }
  .badge.unscoped { background: rgba(160,160,160,0.16); color: #aaa; }
  .badge.denied { background: rgba(255,107,107,0.16); color: #ff6b6b; }
  .badge.ok { background: rgba(81,207,102,0.16); color: #51cf66; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2a2d33; font-size: 14px; }
  th { color: #8a8d93; font-weight: 500; }
  code, pre { background: #1a1c20; padding: 2px 6px; border-radius: 3px; font-size: 13px; font-family: ui-monospace, monospace; }
  pre { padding: 12px 16px; overflow-x: auto; border: 1px solid #2a2d33; }
  input[type=text], input[type=password], input[type=email], select, textarea {
    width: 100%; padding: 8px 10px; background: #1a1c20; color: #e1e3e6;
    border: 1px solid #2a2d33; border-radius: 4px; font-family: inherit; font-size: 14px;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #6ea8fe; }
  label { display: block; font-size: 13px; color: #c8ccd2; margin-bottom: 4px; }
  .field { margin-bottom: 12px; }
  .field-hint { font-size: 12px; color: #8a8d93; margin-top: 4px; }
  .field-primary input { font-size: 18px !important; padding: 12px 14px !important; border: 2px solid #6ea8fe !important; background: rgba(110,168,254,0.06) !important; }
  .field-primary input:focus { background: rgba(110,168,254,0.12) !important; }
  .field-secondary { margin-top: 16px; padding-top: 16px; border-top: 1px dashed #2a2d33; }
  .field-secondary summary { cursor: pointer; color: #8a8d93; font-size: 13px; padding: 4px 0; user-select: none; }
  .field-secondary summary:hover { color: #c8ccd2; }
  .field-secondary[open] summary { color: #6ea8fe; margin-bottom: 8px; }
  button, .btn {
    padding: 8px 16px; background: #6ea8fe; color: #0e0f12; border: 0; border-radius: 4px;
    font-weight: 600; cursor: pointer; font-size: 14px; text-decoration: none; display: inline-block;
  }
  button:hover, .btn:hover { background: #5a96e8; text-decoration: none; color: #0e0f12; }
  button.secondary, .btn.secondary { background: #2a2d33; color: #c8ccd2; }
  button.secondary:hover, .btn.secondary:hover { background: #353941; color: #e1e3e6; }
  .empty { padding: 40px; text-align: center; color: #8a8d93; }
  .tool-pill { display: inline-block; padding: 2px 8px; margin: 2px; background: #1a1c20; border: 1px solid #2a2d33; border-radius: 12px; font-size: 11px; font-family: ui-monospace, monospace; }
  .step-card { background: #14161a; border: 1px solid #2a2d33; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
  .step-card h2 { margin-top: 0; display: flex; align-items: center; gap: 12px; }
  .step-card h2 .num { display: inline-block; width: 28px; height: 28px; line-height: 28px; text-align: center; background: #6ea8fe; color: #0e0f12; border-radius: 50%; font-size: 14px; font-weight: 700; }
`;

const NAV = (current: string) => `
<nav>
  <span class="brand">agent-oauth</span>
  <a href="/ui" class="${current === "dashboard" ? "active" : ""}">Dashboard</a>
  <a href="/ui/tenants" class="${current === "tenants" ? "active" : ""}">Tenants</a>
  <a href="/ui/agents" class="${current === "agents" ? "active" : ""}">Agents</a>
  <a href="/ui/audit" class="${current === "audit" ? "active" : ""}">Audit</a>
  <span style="flex:1"></span>
  <a href="/api/auth/sign-out">Sign out</a>
</nav>
`;

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function getSessionUser(c: any) {
  const sess = await auth.api.getSession({ headers: c.req.raw.headers });
  return sess?.user ?? null;
}

// --- /ui (Dashboard) ---
dashboardApp.get("/", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login");

  const [connectionCount, agentCount, roleCount, recentAudits] = await Promise.all([
    prisma.connection.count(),
    prisma.agent.count(),
    prisma.role.count(),
    prisma.auditLog.findMany({ take: 10, orderBy: { createdAt: "desc" }, include: { agent: true } }),
  ]);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("dashboard")}
    <main>
      <h1>Dashboard</h1>
      <div class="row" style="gap:16px; margin-bottom:24px;">
        <div class="card" style="flex:1;"><div style="color:#8a8d93;font-size:12px;">Connections</div><div style="font-size:24px;font-weight:700;">${connectionCount}</div></div>
        <div class="card" style="flex:1;"><div style="color:#8a8d93;font-size:12px;">Agents</div><div style="font-size:24px;font-weight:700;">${agentCount}</div></div>
        <div class="card" style="flex:1;"><div style="color:#8a8d93;font-size:12px;">Roles</div><div style="font-size:24px;font-weight:700;">${roleCount}</div></div>
      </div>
      <h2>Recent activity</h2>
      <div class="card">
        ${recentAudits.length === 0 ? '<div class="empty">No activity yet. Create your first tenant → <a href="/ui/tenants/new">+ New tenant</a></div>' : `
        <table>
          <thead><tr><th>When</th><th>Agent</th><th>Tool</th><th>Scope</th><th>Status</th><th>Duration</th></tr></thead>
          <tbody>
          ${recentAudits.map((a) => `
            <tr>
              <td><code>${a.createdAt.toISOString().slice(0, 19)}</code></td>
              <td>${a.agent?.name ?? "<system>"}</td>
              <td><code>${a.tool}</code></td>
              <td>${a.scope ? `<span class="badge scoped">${a.scope}</span>` : `<span class="badge unscoped">-</span>`}</td>
              <td>${a.status === "ok" ? '<span class="badge ok">ok</span>' : a.status === "denied" ? '<span class="badge denied">denied</span>' : `<span class="badge denied">${a.status}</span>`}</td>
              <td>${a.durationMs ?? "?"}ms</td>
            </tr>
          `).join("")}
          </tbody>
        </table>`}
      </div>
    </main></body></html>
  `);
});

// --- /ui/login ---
dashboardApp.get("/login", async (c) => {
  const user = await getSessionUser(c);
  if (user) return c.redirect("/ui");
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Sign in — agent-oauth</title>
    <style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Sign in to agent-oauth</h1>
    <div class="card">
      <form id="loginForm">
        <div class="field">
          <label for="email">Email</label>
          <input type="email" name="email" id="email" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" name="password" id="password" required minlength="8">
        </div>
        <button type="submit" style="width:100%;">Sign in</button>
        <div id="err" style="color:#ff6b6b;margin-top:8px;font-size:13px;"></div>
      </form>
    </div>
    <p style="text-align:center;color:#8a8d93;font-size:13px;">No account? <a href="/ui/register">Create one</a></p>
    <script>
      document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const r = await fetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') })
        });
        if (r.ok) { location.href = '/ui'; }
        else { document.getElementById('err').textContent = 'Invalid email or password'; }
      });
    </script>
    </body></html>
  `);
});

// --- /ui/register ---
dashboardApp.get("/register", async (c) => {
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Create account — agent-oauth</title>
    <style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Create account</h1>
    <div class="card">
      <form id="regForm">
        <div class="field">
          <label for="name">Name</label>
          <input type="text" name="name" id="name" required>
        </div>
        <div class="field">
          <label for="email">Email</label>
          <input type="email" name="email" id="email" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" name="password" id="password" required minlength="8">
        </div>
        <button type="submit" style="width:100%;">Create account</button>
        <div id="err" style="color:#ff6b6b;margin-top:8px;font-size:13px;"></div>
      </form>
    </div>
    <p style="text-align:center;color:#8a8d93;font-size:13px;">Already have one? <a href="/ui/login">Sign in</a></p>
    <script>
      document.getElementById('regForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const r = await fetch('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password') })
        });
        if (r.ok) { location.href = '/ui'; }
        else { const j = await r.json().catch(()=>({})); document.getElementById('err').textContent = j.message || 'Sign up failed'; }
      });
    </script>
    </body></html>
  `);
});

// --- /ui/tenants ---
dashboardApp.get("/tenants", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login");

  const connections = await prisma.connection.findMany({
    where: { ownerId: user.id },
    orderBy: [{ scope: "asc" }, { provider: "asc" }],
  });

  // Group by scope
  const byScope = new Map<string, typeof connections>();
  for (const conn of connections) {
    const key = conn.scope || "(unscoped)";
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key)!.push(conn);
  }

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Tenants — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants")}
    <main>
      <div class="row spread" style="margin-bottom:16px;">
        <h1 style="margin:0;">Tenants</h1>
        <a href="/ui/tenants/new" class="btn">+ New tenant</a>
      </div>
      <p style="color:#8a8d93;margin-top:-8px;">API: <code>GET /ui/api/scopes</code> returns your full wiring as JSON.</p>
      <form method="post" action="/ui/tenants/bulk-delete" id="bulkForm">
        <input type="hidden" name="scopes_csv" id="scopesCsv" value="">
        ${byScope.size === 0 ? '<div class="card"><div class="empty">No tenants yet. <a href="/ui/tenants/new">Create your first one</a>.</div></div>' : `
        <div class="row spread" style="margin-bottom:8px;">
          <label style="font-size:13px;color:#c8ccd2;cursor:pointer;"><input type="checkbox" id="selectAll"> select all</label>
          <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" id="bulkDelBtn" disabled>🗑 Delete selected (0)</button>
        </div>
        ${Array.from(byScope.entries()).map(([scope, conns]) => `
        <div class="card">
          <h2>${scope === "(unscoped)" ? '<span class="badge unscoped">unscoped</span> Legacy connections' : `<input type="checkbox" name="scopes" value="${scope}" class="rowCheck" style="margin-right:8px;transform:scale(1.2);"><span class="badge scoped">${scope}</span>`} ${scope !== "(unscoped)" ? `<a href="/ui/tenants/${scope}/edit" class="btn secondary" style="margin-left:8px;font-size:12px;padding:4px 10px;">+ Add service</a> <a href="/ui/tenants/${scope}/edit" class="btn secondary" style="margin-left:4px;font-size:12px;padding:4px 10px;">✎ Edit</a>` : ""}</h2>
          <table>
            <thead><tr><th>Provider</th><th>Label</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
            ${conns.map((c) => `
              <tr>
                <td><code>${c.provider}</code></td>
                <td>${c.label}</td>
                <td>${c.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</td>
                <td><code>${c.createdAt.toISOString().slice(0, 10)}</code></td>
              </tr>
            `).join("")}
            </tbody>
          </table>
        </div>
      `).join("")}
        `}
      </form>
      <script>
        const selAll = document.getElementById('selectAll');
        const checks = document.querySelectorAll('.rowCheck');
        const btn = document.getElementById('bulkDelBtn');
        const csv = document.getElementById('scopesCsv');
        function updateBtn() {
          const checked = Array.from(document.querySelectorAll('.rowCheck:checked')).map(c => c.value);
          if (csv) csv.value = checked.join(',');
          if (btn) { btn.disabled = checked.length === 0; btn.textContent = '🗑 Delete selected (' + checked.length + ')'; }
        }
        if (selAll) selAll.addEventListener('change', () => {
          checks.forEach(c => c.checked = selAll.checked);
          updateBtn();
        });
        checks.forEach(c => c.addEventListener('change', updateBtn));
      </script>
    </main></body></html>
  `);
});

// --- /ui/tenants/:scope/edit (edit settings + add services) ---
dashboardApp.get("/tenants/:scope/edit", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login");

  const scope = c.req.param("scope");
  const connections = await prisma.connection.findMany({
    where: { scope, ownerId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const userIdShort = user.id.slice(0, 8);
  const role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort}`, ownerId: user.id } });
  const roleTools: string[] = role ? safeJsonArray(role.allowedTools) : [];
  const roleScopes: string[] = role ? safeJsonArray(role.allowedScopes) : [];
  const providers = listProviders();

  // Get union of all tools from all connected providers (for the role settings checkboxes)
  const usedProviders = new Set(connections.map((c) => c.provider));
  const allAvailableTools = Array.from(new Set(
    providers.filter((p) => usedProviders.has(p.key)).flatMap((p) => p.tools)
  ));
  const availableToAdd = providers.filter((p) => !usedProviders.has(p.key));

  // Get all of the user's existing scopes (for allowedScopes multi-select)
  const userScopes = await prisma.connection.findMany({
    where: { ownerId: user.id, scope: { not: "" } },
    select: { scope: true },
    distinct: ["scope"],
    orderBy: { scope: "asc" },
  });
  const existingScopes = userScopes.map((s) => s.scope);

  const roleScopesStr = roleScopes.join(", ");
  const roleDesc = role?.description ?? "";

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Edit ${scope} — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants")}
    <main>
      <h1>Edit tenant <code>${scope}</code></h1>
      <p style="color:#8a8d93;margin-top:-16px;margin-bottom:24px;">
        Edit the tenant's display labels, role tools, and role scopes. To add a new service, scroll down.
      </p>

      <form method="post" action="/ui/tenants/${scope}/edit" id="settingsForm">
        <input type="hidden" name="_action" value="save_settings">

        <h2>Connections (${connections.length})</h2>
        ${connections.length === 0 ? '<div class="card"><div class="empty">No connections yet. Add one below.</div></div>' : `
        <div class="card">
          <p class="field-hint" style="margin-top:0;">Edit the display label for each connection. This is what you see in dashboards, audit logs, and tooltips.</p>
          <table>
            <thead><tr><th>Provider</th><th>Scope</th><th>Label</th><th>Enabled</th><th>Created</th></tr></thead>
            <tbody>
            ${connections.map((cn) => `
              <tr>
                <td><code>${cn.provider}</code></td>
                <td><code>${cn.scope}</code></td>
                <td><input type="text" name="conn_label_${cn.id}" value="${escapeHtml(cn.label)}" style="font-size:13px;"></td>
                <td><label style="font-weight:normal;font-size:13px;"><input type="checkbox" name="conn_enabled_${cn.id}" ${cn.enabled ? "checked" : ""}> on</label></td>
                <td><code>${cn.createdAt.toISOString().slice(0, 10)}</code></td>
              </tr>
            `).join("")}
            </tbody>
          </table>
        </div>`}

        <h2>Role <code>${scope}-dev-${userIdShort}</code></h2>
        <div class="card">
          <div class="field">
            <label for="role_desc">Description</label>
            <input type="text" name="role_desc" id="role_desc" value="${escapeHtml(roleDesc)}" placeholder="What this role is for">
          </div>
          <div class="field">
            <label>Allowed tools</label>
            <p class="field-hint" style="margin-top:0;">Tools from the providers connected above. Uncheck to revoke. (Re-check + Save to re-enable.)</p>
            ${allAvailableTools.length === 0 ? '<div class="empty">No providers connected yet.</div>' : `
            <div id="roleToolsList">${allAvailableTools.map((t) => `<label style="font-weight:normal;display:block;padding:2px 0;"><input type="checkbox" name="role_tools" value="${t}" ${roleTools.includes(t) ? "checked" : ""}> <code>${t}</code></label>`).join("")}</div>
            `}
          </div>
          <div class="field">
            <label for="role_scopes">Allowed scopes</label>
            <input type="text" name="role_scopes" id="role_scopes" value="${escapeHtml(roleScopesStr)}" placeholder="(empty = any scope)">
            <div class="field-hint">Comma-separated scope names. <b>Empty = any scope</b> (recommended for multi-tenant dev). Your other tenants: ${existingScopes.map((s) => `<code>${s}</code>`).join(", ") || "<em>none</em>"}.</div>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:32px;">
          <button type="submit">Save settings</button>
          <a href="/ui/tenants" class="btn secondary">Cancel</a>
        </div>
      </form>

      <h2 style="color:#ff6b6b;">Danger zone</h2>
      <div class="card" style="border-color:#ff6b6b;">
        <p>Delete this tenant entirely. This removes <b>all your connections</b> for scope <code>${scope}</code> and the role <code>${scope}-dev-${userIdShort}</code>. Agents bound to that role will be left <b>unbound</b> (use <a href="/ui/agents">/ui/agents</a> to clean them up).</p>
        <form method="post" action="/ui/tenants/${scope}/delete" onsubmit="return confirm('Delete tenant ${scope}?\\n\\nThis removes all YOUR connections and the role for this scope. This action cannot be undone.');">
          <button type="submit" style="background:#ff6b6b;color:#0e0f12;">🗑 Delete tenant ${scope}</button>
        </form>
      </div>

      <h2>Add a service</h2>
      ${availableToAdd.length === 0 ? '<div class="card"><div class="empty">All known providers are already connected. To replace a connection, disable and delete it (Phase 5 — not yet implemented).</div></div>' : `
      <form method="post" action="/ui/tenants/${scope}/edit" id="addConnForm">
        <input type="hidden" name="_action" value="add_service">
        <div class="step-card">
          <h2><span class="num">+</span> New service</h2>
          <div class="field">
            <label for="provider">Provider</label>
            <select name="provider" id="provider" required>
              ${availableToAdd.map((p) => `<option value="${p.key}" data-auth="${p.authTypes.join(",")}">${p.label} (${p.authTypes.map(t => t === "pat" ? "paste token" : "OAuth").join(" / ")})</option>`).join("")}
            </select>
          </div>
          <div class="field" id="credFieldRow">
            <label for="credential">Credential</label>
            <textarea name="credential" id="credential" rows="3" required></textarea>
            <div class="field-hint" id="credHint"></div>
            <div id="patLinkRow" style="margin-top:6px;display:none;">
              <a id="patLink" href="#" target="_blank" rel="noopener" style="font-size:13px;">🔗 Get a new token here →</a>
            </div>
            <div id="oauthSetupLinkRow" style="margin-top:6px;display:none;">
              <a id="oauthSetupLink" href="#" target="_blank" rel="noopener" style="font-size:13px;">🔗 Register/manage OAuth app here →</a>
            </div>
          </div>
          <div class="field">
            <label>Tools to enable</label>
            <p class="field-hint" style="margin-top:0;">All tools for this provider are listed; check the ones you want this tenant to access.</p>
            <div id="toolsList"></div>
            <input type="hidden" name="tools_json" id="toolsJson" value="">
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="submit">Add service</button>
        </div>
      </form>
      <script>
        const PROVIDERS = ${JSON.stringify(Object.fromEntries(availableToAdd.map(p => [p.key, p])))};
        const sel = document.getElementById('provider');
        const toolsList = document.getElementById('toolsList');
        const credHint = document.getElementById('credHint');
        const credField = document.getElementById('credential');
        const patLinkRow = document.getElementById('patLinkRow');
        const patLink = document.getElementById('patLink');
        const oauthSetupLinkRow = document.getElementById('oauthSetupLinkRow');
        const oauthSetupLink = document.getElementById('oauthSetupLink');

        function updateUI() {
          const p = PROVIDERS[sel.value];
          if (!p) return;
          credHint.textContent = p.helpText;
          credField.placeholder = p.authTypes.includes("pat") ? "Paste your " + p.label + " token here" : "OAuth flow (Phase 5)";
          credField.disabled = p.authTypes.includes("oauth") && !p.authTypes.includes("pat");
          credField.required = p.authTypes.includes("pat");
          if (p.tokenUrl) {
            patLink.href = p.tokenUrl;
            patLink.textContent = "🔗 Get a new " + p.label + " token here →";
            patLinkRow.style.display = "";
          } else {
            patLinkRow.style.display = "none";
          }
          if (p.oauthSetupUrl) {
            oauthSetupLink.href = p.oauthSetupUrl;
            oauthSetupLink.textContent = "🔗 Register/manage your " + p.label + " OAuth app here →";
            oauthSetupLinkRow.style.display = "";
          } else {
            oauthSetupLinkRow.style.display = "none";
          }
          toolsList.innerHTML = p.tools.map(t => '<label style="font-weight:normal;display:block;padding:4px 0;"><input type="checkbox" name="tools" value="' + t + '" checked> <code>' + t + '</code></label>').join("");
        }
        sel.addEventListener('change', updateUI);
        updateUI();
        document.getElementById('addConnForm').addEventListener('submit', () => {
          const selected = Array.from(document.querySelectorAll('input[name="tools"]:checked')).map(i => i.value);
          document.getElementById('toolsJson').value = JSON.stringify(selected);
        });
      </script>
      `}
    </main></body></html>
  `);
});

dashboardApp.post("/tenants/:scope/edit", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const scope = c.req.param("scope");
  const userIdShort = user.id.slice(0, 8);
  const body = await c.req.parseBody();
  const action = String(body._action ?? "").trim();

  // --- save_settings: update connection labels/enabled + role desc/tools/scopes ---
  if (action === "save_settings") {
    const connections = await prisma.connection.findMany({
      where: { scope, ownerId: user.id },
    });

    // Update each connection's label + enabled
    const connUpdates: Array<{ id: string; label: string; enabled: boolean }> = [];
    for (const cn of connections) {
      const labelField = `conn_label_${cn.id}`;
      const enabledField = `conn_enabled_${cn.id}`;
      if (body[labelField] !== undefined) {
        const newLabel = String(body[labelField]).trim() || cn.label;
        const newEnabled = body[enabledField] !== undefined; // checkbox present = on
        if (newLabel !== cn.label || newEnabled !== cn.enabled) {
          await prisma.connection.update({
            where: { id: cn.id },
            data: { label: newLabel, enabled: newEnabled },
          });
          connUpdates.push({ id: cn.id, label: newLabel, enabled: newEnabled });
        }
      }
    }

    // Update role
    const roleDesc = String(body.role_desc ?? "").trim();
    const roleScopesRaw = String(body.role_scopes ?? "").trim();
    const roleScopes = roleScopesRaw
      ? roleScopesRaw.split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9_-]+$/.test(s))
      : [];
    const roleTools: string[] = Array.isArray(body.role_tools) ? body.role_tools.map(String) : (body.role_tools ? [String(body.role_tools)] : []);

    let role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort}`, ownerId: user.id } });
    if (role) {
      role = await prisma.role.update({
        where: { id: role.id },
        data: {
          description: roleDesc || null,
          allowedTools: JSON.stringify(roleTools),
          allowedScopes: JSON.stringify(roleScopes),
        },
      });
    } else {
      role = await prisma.role.create({
        data: {
          name: `${scope}-dev-${userIdShort}`,
          description: roleDesc || null,
          allowedTools: JSON.stringify(roleTools),
          allowedScopes: JSON.stringify(roleScopes),
          ownerId: user.id,
        },
      });
    }

    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Saved — agent-oauth</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants")}
      <main>
        <h1>✓ Settings saved for <code>${scope}</code></h1>
        <div class="card">
          <h2>Connections updated (${connUpdates.length})</h2>
          ${connUpdates.length === 0 ? '<p><em>No changes.</em></p>' : `
          <ul>${connUpdates.map((u) => `<li><code>${escapeHtml(u.label)}</code> · ${u.enabled ? "enabled" : "DISABLED"}</li>`).join("")}</ul>
          `}
        </div>
        <div class="card">
          <h2>Role <code>${role.name}</code></h2>
          <p><b>Description:</b> ${role.description ? escapeHtml(role.description) : "<em>none</em>"}</p>
          <p><b>Tools (${JSON.parse(role.allowedTools).length}):</b> ${(JSON.parse(role.allowedTools) as string[]).map((t) => `<span class="tool-pill">${t}</span>`).join(" ") || "<em>none</em>"}</p>
          <p><b>Scopes:</b> ${(JSON.parse(role.allowedScopes) as string[]).map((s) => `<code>${s}</code>`).join(", ") || "<em>any (empty)</em>"}</p>
        </div>
        <p><a href="/ui/tenants/${scope}/edit">← Back to ${scope}</a> · <a href="/ui/tenants">All tenants</a></p>
      </main></body></html>
    `);
  }

  // --- add_service: add a new provider connection (existing behavior) ---
  if (action === "add_service") {
    const provider = String(body.provider ?? "").trim();
    const credential = String(body.credential ?? "").trim();
    const userIdShort2 = user.id.slice(0, 8);
    let tools: string[] = [];
    const toolsJson = String(body.tools_json ?? "").trim();
    if (toolsJson) { try { tools = JSON.parse(toolsJson); } catch {} }

    const providerDef = getProvider(provider);
    if (!providerDef) return c.html("<h1>unknown provider</h1>", 400);
    if (providerDef.authTypes.includes("pat") && !credential) return c.html("<h1>credential required</h1>", 400);

    // 1) Create connection
    const conn = await prisma.connection.create({
      data: {
        provider,
        label: `${provider}-${scope}`,
        scope,
        ownerId: user.id,
        encryptedCredential: encrypt(credential || "pending-oauth"),
      },
    });

    // 2) Find or create role, then merge allowedTools (union)
    let role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort2}`, ownerId: user.id } });
    let currentTools: string[] = role ? safeJsonArray(role.allowedTools) : [];
    let currentScopes: string[] = role ? safeJsonArray(role.allowedScopes) : [];
    if (currentScopes.length === 0) {
      // keep empty = any scope; don't shrink
    } else if (!currentScopes.includes(scope)) {
      currentScopes.push(scope);
    }
    const mergedTools = Array.from(new Set([...currentTools, ...tools]));

    if (role) {
      role = await prisma.role.update({
        where: { id: role.id },
        data: { allowedTools: JSON.stringify(mergedTools), allowedScopes: JSON.stringify(currentScopes) },
      });
    } else {
      role = await prisma.role.create({
        data: {
          name: `${scope}-dev-${userIdShort2}`,
          allowedTools: JSON.stringify(mergedTools.length > 0 ? mergedTools : toolsForProvider(provider)),
          allowedScopes: JSON.stringify([]),
          ownerId: user.id,
        },
      });
    }

    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Service added — agent-oauth</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants")}
      <main>
        <h1>✓ Service added to <code>${scope}</code></h1>
        <div class="card">
          <h2>New connection</h2>
          <p><code>${conn.label}</code> · scope=<code>${conn.scope}</code> · ${tools.length} tools enabled</p>
        </div>
        <div class="card">
          <h2>Role updated</h2>
          <p><code>${role.name}</code> now has ${mergedTools.length} tools (added ${mergedTools.length - currentTools.length} new ones)</p>
          <p>${mergedTools.map((t) => `<span class="tool-pill">${t}</span>`).join(" ")}</p>
        </div>
        <p><a href="/ui/tenants/${scope}/edit">← Back to ${scope}</a> · <a href="/ui/tenants">All tenants</a></p>
      </main></body></html>
    `);
  }

  return c.html("<h1>unknown action</h1>", 400);
});

// --- /ui/tenants/new ---
dashboardApp.get("/tenants/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login");

  const providers = listProviders();
  // Get existing tenants (distinct scope values) for the dropdown
  const existingConns = await prisma.connection.findMany({
    where: { ownerId: user.id },
    select: { scope: true },
    distinct: ["scope"],
    orderBy: { scope: "asc" },
  });
  const existingScopes = existingConns.map((c: { scope: string }) => c.scope).filter((s: string) => s.length > 0);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>New tenant — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants")}
    <main>
      <h1>+ New tenant</h1>
      <p style="color:#8a8d93;margin-top:-16px;margin-bottom:24px;">
        Create an isolated tenant in one step. This sets up: a <b>connection</b> with scope=&lt;tenant&gt;,
        a <b>role</b> with allowed_scopes bound to that tenant, an <b>agent</b>, and a fresh <b>token</b>.
      </p>
      <form method="post" action="/ui/tenants/new" id="wizForm">
        <div class="step-card">
          <h2><span class="num">1</span> Tenant</h2>
          <div class="field field-primary">
            <label for="tenant">New tenant name</label>
            <input type="text" name="tenant" id="tenant" pattern="[a-z0-9_-]+" placeholder="my-new-tenant" autofocus required>
            <div class="field-hint">lowercase, alphanumeric, hyphens, underscores. This is the <b>scope</b> for all your API calls.</div>
          </div>
          ${existingScopes.length > 0 ? `
          <details class="field-secondary">
            <summary>Or pick an existing tenant (${existingScopes.length})</summary>
            <select name="tenant_select" id="tenant_select">
              <option value="">-- (leave empty to use the text field above) --</option>
              ${existingScopes.map((s) => `<option value="${s}">${s} (existing — will reuse role '${s}-dev')</option>`).join("")}
            </select>
            <div class="field-hint">If you pick one, it overrides the text field. Useful when you've already set up the tenant and just want a new agent bound to it.</div>
          </details>
          ` : ''}
          ${existingScopes.length > 0 ? `
          <div class="field" style="margin-top:16px;">
            <label for="additional_scopes">Additional allowed scopes <span style="color:#8a8d93;">(optional, multi-tenant)</span></label>
            <input type="text" name="additional_scopes" id="additional_scopes" placeholder="e.g. ${existingScopes.slice(0, 2).join(', ')}${existingScopes.length > 2 ? ', ...' : ''}">
            <div class="field-hint">Comma-separated. The role will be allowed to access <i>these scopes too</i> (in addition to the new tenant). Leave empty for <b>any scope</b>. Your other tenants: ${existingScopes.map((s) => `<code>${s}</code>`).join(", ")}.</div>
          </div>
          ` : ''}
          <div class="field" style="margin-top:16px;">
            <label for="agent">Agent name</label>
            <input type="text" name="agent" id="agent" placeholder="auto-suggested when you type a tenant name">
            <div class="field-hint">Globally unique. Auto-suggested from tenant name. Override if you want.</div>
          </div>
          <div class="field">
            <label for="agent_desc">Agent description <span style="color:#8a8d93;">(optional)</span></label>
            <input type="text" name="agent_desc" id="agent_desc" placeholder="What this agent does">
          </div>
        </div>

        <div class="step-card">
          <h2><span class="num">2</span> Provider</h2>
          <div class="field">
            <label for="provider">Provider</label>
            <select name="provider" id="provider" required>
              ${providers.map((p) => `<option value="${p.key}" data-auth="${p.authTypes.join(",")}">${p.label} (${p.authTypes.map(t => t === "pat" ? "paste token" : "OAuth").join(" / ")})</option>`).join("")}
            </select>
          </div>
          <div class="field" id="credFieldRow">
            <label for="credential">Credential</label>
            <textarea name="credential" id="credential" rows="3" required placeholder="Paste your token here..."></textarea>
            <div class="field-hint" id="credHint"></div>
            <div id="patLinkRow" style="margin-top:6px;display:none;">
              <a id="patLink" href="#" target="_blank" rel="noopener" style="font-size:13px;">🔗 Get a new token here →</a>
            </div>
          </div>
          <div class="field" id="oauthButtonRow" style="display:none;">
            <label>OAuth connection</label>
            <p class="field-hint" style="margin-top:0;">This provider uses OAuth. After clicking "Create tenant" you'll be redirected to authorize the connection, then come back to see your token.</p>
            <button type="button" id="oauthBtn" class="btn">🔗 Connect with OAuth</button>
            <div class="field-hint" id="oauthHint"></div>
            <div id="oauthSetupLinkRow" style="margin-top:6px;display:none;">
              <a id="oauthSetupLink" href="#" target="_blank" rel="noopener" style="font-size:13px;">🔗 Register/manage OAuth app here →</a>
            </div>
          </div>
        </div>

        <div class="step-card">
          <h2><span class="num">3</span> Tools</h2>
          <p class="field-hint" style="margin-top:0;">Which tools this agent can call. Defaults to all tools for the provider.</p>
          <div id="toolsList"></div>
          <input type="hidden" name="tools_json" id="toolsJson" value="">
        </div>

        <div style="display:flex;gap:8px;">
          <button type="submit">Create tenant</button>
          <a href="/ui/tenants" class="btn secondary">Cancel</a>
        </div>
      </form>
      <script>
        const PROVIDERS = ${JSON.stringify(Object.fromEntries(providers.map(p => [p.key, p])))};
        const sel = document.getElementById('provider');
        const toolsList = document.getElementById('toolsList');
        const credHint = document.getElementById('credHint');
        const credField = document.getElementById('credential');
        const credFieldRow = document.getElementById('credFieldRow');
        const oauthButtonRow = document.getElementById('oauthButtonRow');
        const oauthHint = document.getElementById('oauthHint');
        const oauthBtn = document.getElementById('oauthBtn');
        const patLinkRow = document.getElementById('patLinkRow');
        const patLink = document.getElementById('patLink');
        const oauthSetupLinkRow = document.getElementById('oauthSetupLinkRow');
        const oauthSetupLink = document.getElementById('oauthSetupLink');
        const tenantField = document.getElementById('tenant');
        const agentField = document.getElementById('agent');

        function updateProviderUI() {
          const p = PROVIDERS[sel.value];
          credHint.textContent = p.helpText;
          const hasPat = p.authTypes.includes("pat");
          const hasOauth = p.authTypes.includes("oauth");
          // Credential field: visible only if PAT is supported
          if (hasPat) {
            credFieldRow.style.display = "";
            credField.placeholder = "Paste your " + p.label + " token here";
            credField.disabled = false;
            credField.required = true;
            if (p.tokenUrl) {
              patLink.href = p.tokenUrl;
              patLink.textContent = "🔗 Get a new " + p.label + " token here →";
              patLinkRow.style.display = "";
            } else {
              patLinkRow.style.display = "none";
            }
          } else {
            credFieldRow.style.display = "none";
            patLinkRow.style.display = "none";
            credField.disabled = true;
            credField.required = false;
            credField.value = "(via OAuth)";
          }
          // OAuth button: visible if OAuth is supported
          if (hasOauth) {
            oauthButtonRow.style.display = "";
            oauthHint.textContent = p.helpText;
            if (p.oauthSetupUrl) {
              oauthSetupLink.href = p.oauthSetupUrl;
              oauthSetupLink.textContent = "🔗 Register/manage your " + p.label + " OAuth app here →";
              oauthSetupLinkRow.style.display = "";
            } else {
              oauthSetupLinkRow.style.display = "none";
            }
          } else {
            oauthButtonRow.style.display = "none";
            oauthSetupLinkRow.style.display = "none";
          }
          toolsList.innerHTML = p.tools.map(t => '<label style="font-weight:normal;display:block;padding:4px 0;"><input type="checkbox" name="tools" value="' + t + '" checked> <code>' + t + '</code></label>').join("");
        }
        document.getElementById('wizForm').addEventListener('submit', () => {
          const selected = Array.from(document.querySelectorAll('input[name="tools"]:checked')).map(i => i.value);
          document.getElementById('toolsJson').value = JSON.stringify(selected);
        });
        // OAuth button: build the start URL with all wizard data and navigate
        if (oauthBtn) oauthBtn.addEventListener('click', () => {
          const p = PROVIDERS[sel.value];
          if (!p.authTypes.includes("oauth")) return;
          // Collect current form data
          const fd = new FormData(document.getElementById('wizForm'));
          const params = new URLSearchParams();
          for (const k of ["tenant","tenant_select","additional_scopes","agent","agent_desc","tools_json"]) {
            const v = fd.get(k);
            if (v) params.set(k, String(v));
          }
          window.location.href = '/oauth/' + p.key + '/start?' + params.toString();
        });
        sel.addEventListener('change', updateProviderUI);
        updateProviderUI();

        // Wizard: live auto-suggest agent name from tenant name (text input).
        // Also clear the dropdown when typing in the text field, and vice versa.
        const tenantInput = document.getElementById('tenant');
        const tenantSelect = document.getElementById('tenant_select');
        const agentInput = document.getElementById('agent');
        function suggestAgentName(tenantName) {
          if (!agentInput.value || agentInput.dataset.autoSuggested === '1') {
            const rand = Date.now().toString(36).slice(-4);
            agentInput.value = tenantName + '-agent-' + rand;
            agentInput.dataset.autoSuggested = '1';
          }
        }
        tenantInput.addEventListener('input', () => {
          if (tenantSelect) tenantSelect.value = '';
          if (tenantInput.value) suggestAgentName(tenantInput.value);
        });
        if (tenantSelect) {
          tenantSelect.addEventListener('change', () => {
            if (tenantSelect.value) {
              tenantInput.value = '';
              suggestAgentName(tenantSelect.value);
            }
          });
        }
        // User-typed agent names should not be overwritten by auto-suggest.
        agentInput.addEventListener('input', () => {
          if (agentInput.value) agentInput.dataset.autoSuggested = '';
        });
      </script>
    </main></body></html>
  `);
});

// --- /ui/tenants/new POST handler ---
dashboardApp.post("/tenants/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const body = await c.req.parseBody();
  // Tenant resolution: text input wins over dropdown selection.
  const tenantText = String(body.tenant ?? "").trim();
  const tenantSelect = String(body.tenant_select ?? "").trim();
  const tenant = tenantText || tenantSelect;
  // Additional scopes the role should allow (comma-separated).
  const additionalScopesRaw = String(body.additional_scopes ?? "").trim();
  const additionalScopes = additionalScopesRaw
    ? additionalScopesRaw.split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9_-]+$/.test(s))
    : [];
  const agent = String(body.agent ?? "").trim();
  const agentDesc = String(body.agent_desc ?? "").trim();
  const provider = String(body.provider ?? "").trim();
  const credential = String(body.credential ?? "").trim();
  // Tools come as JSON in tools_json (Hono parseBody only keeps last value for repeated keys).
  let tools: string[] = [];
  const toolsJson = String(body.tools_json ?? "").trim();
  if (toolsJson) {
    try { tools = JSON.parse(toolsJson); } catch { tools = []; }
  }
  // Fallback: also accept a single 'tools' field.
  if (tools.length === 0 && body.tools) {
    const raw = body.tools;
    tools = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  }
  console.log("[tenants/new POST] tenant=", tenant, "provider=", provider, "tools=", tools);

  if (!/^[a-z0-9_-]+$/.test(tenant)) return c.html("<h1>invalid tenant id</h1>", 400);
  if (!agent) return c.html("<h1>agent name required</h1>", 400);
  if (additionalScopesRaw && additionalScopes.length === 0) {
    return c.html("<h1>additional_scopes must be lowercase a-z, 0-9, hyphens, underscores (comma-separated)</h1>", 400);
  }

  // Check for agent name conflict up front so we can return a clean error
  // instead of letting Prisma's P2002 bubble up as a generic 500.
  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Agent name taken — agent-oauth</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants")}
      <main>
        <h1>⚠️  Agent name <code>${escapeHtml(agent)}</code> already exists</h1>
        <div class="card" style="border-color:#ff6b6b;">
          <p>Agent names are globally unique. Someone already created an agent with this name (created ${existingAgent.createdAt.toISOString().slice(0,10)}).</p>
          <p><b>Options:</b></p>
          <ul>
            <li>Pick a different agent name (e.g. <code>${escapeHtml(agent)}-v2</code>, <code>${escapeHtml(agent)}-${Date.now().toString(36).slice(-4)}</code>)</li>
            <li><a href="/ui/agents/${existingAgent.id}">Reuse the existing agent</a> and rotate its token instead</li>
            <li><a href="/ui/tenants/new">← Back to wizard</a></li>
          </ul>
        </div>
        <p style="color:#8a8d93;font-size:13px;">Why globally unique? Agent names double as the agent's display ID in audit logs and MCP routing. <a href="https://github.com/gentityapp/agent-oauth/issues/new">file an issue</a> if you want per-user uniqueness.</p>
      </main></body></html>
    `, 409);
  }

  // Per-user role naming: each user gets their own role row for a given
  // tenant scope. The role NAME is just an internal label; the
  // `allowedScopes` field is what actually controls access. So two users
  // can both have a tenant called `gentity-dev` without colliding —
  // each gets role `gentity-dev-dev-${userIdShort}`.
  const userIdShort = user.id.slice(0, 8);
  const roleName = `${tenant}-dev-${userIdShort}`;

  // Tenant (= scope) names are still globally unique on connections, but
  // we don't need to enforce it at the role layer. If you really did own
  // a connection with the same scope from a previous account, you'd get
  // a separate conflict on the connection create — but that's your own
  // legacy data, not another user's.

  const providerDef = getProvider(provider);
  if (!providerDef) return c.html("<h1>unknown provider</h1>", 400);
  if (providerDef.authTypes.includes("pat") && !credential) return c.html("<h1>credential required for PAT providers</h1>", 400);

  // 1) Create or reuse connection (idempotent: dedupe on owner+provider+label+scope)
  //    MUST filter by ownerId — otherwise user B could inherit user A's credential
  //    by typing the same tenant name in the wizard.
  const existingConn = await prisma.connection.findFirst({
    where: { provider, label: `${provider}-${tenant}`, scope: tenant, ownerId: user.id },
  });
  const conn = existingConn ?? await prisma.connection.create({
    data: {
      provider,
      label: `${provider}-${tenant}`,
      scope: tenant,
      ownerId: user.id,
      encryptedCredential: encrypt(credential || "pending-oauth"),
    },
  });

  // 2) Find or create role. Reuse existing ${tenant}-dev if present.
  // This way, running the wizard twice for the same tenant doesn't create
  // an orphan role; the new agent gets bound to the same role as before.
  //
  // allowedScopes logic:
  //   - If user specified `additional_scopes`: pin to [tenant, ...additional]
  //     (explicit allowlist, more secure).
  //   - Else: default to [] (= any scope) so a single agent token
  //     works across all of the user's tenants (Mavis's pattern).
  const desiredTools = tools.length > 0 ? tools : toolsForProvider(provider);
  // Decide the initial allowedScopes for a NEW role.
  const initialAllowedScopes = additionalScopes.length > 0
    ? Array.from(new Set([tenant, ...additionalScopes]))
    : []; // any

  let role = await prisma.role.findFirst({ where: { name: roleName, ownerId: user.id } });
  if (role) {
    // Merge: keep existing scopes (don't shrink), union tools.
    const existingTools = safeJsonArray(role.allowedTools);
    const existingScopes = safeJsonArray(role.allowedScopes);
    const mergedTools = Array.from(new Set([...existingTools, ...desiredTools]));
    let mergedScopes: string[];
    if (existingScopes.length === 0) {
      // Existing role allows any — if user now specified an allowlist, apply it.
      // Otherwise keep "any".
      mergedScopes = additionalScopes.length > 0 ? initialAllowedScopes : [];
    } else {
      // Existing role has an allowlist — widen by adding new scopes. Never narrow.
      mergedScopes = Array.from(new Set([...existingScopes, tenant, ...additionalScopes]));
    }
    role = await prisma.role.update({
      where: { id: role.id },
      data: {
        allowedTools: JSON.stringify(mergedTools),
        allowedScopes: JSON.stringify(mergedScopes),
      },
    });
  } else {
    role = await prisma.role.create({
      data: {
        name: roleName,
        description: `Role for tenant '${tenant}' (per-user) — tools: ${provider}`,
        allowedTools: JSON.stringify(desiredTools),
        allowedScopes: JSON.stringify(initialAllowedScopes),
        ownerId: user.id,
      },
    });
  }

  // 3) Create agent + bind role + mint token
  const token = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then(c => c.createHash("sha256").update(token).digest("hex"));
  const agentRow = await prisma.agent.create({
    data: {
      name: agent,
      description: agentDesc || null,
      hashedToken: tokenHash,
      tokenPrefix: token.slice(0, 16),
      ownerId: user.id,
      roles: { create: [{ roleId: role.id }] },
    },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Tenant created — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants")}
    <main>
      <h1>✓ Tenant <code>${tenant}</code> created</h1>
      <div class="card">
        <h2>Connection</h2>
        <p><code>${conn.label}</code> · scope=<code>${conn.scope}</code></p>
      </div>
      <div class="card">
        <h2>Role</h2>
        <p><code>${role.name}</code> · allowed_scopes=<code>${tenant}</code> · ${JSON.parse(role.allowedTools).length} tools</p>
      </div>
      <div class="card">
        <h2>Agent</h2>
        <p><code>${agentRow.name}</code> · bound to <code>${role.name}</code></p>
      </div>
      <div class="card" style="background:rgba(110,168,254,0.08);">
        <h2>🔑 Agent token (save this — shown once!)</h2>
        <pre style="background:#0e0f12;border:1px solid #6ea8fe;">${token}</pre>
        <p style="font-size:13px;color:#8a8d93;margin-bottom:0;">Use as <code>Authorization: Bearer ${token}</code> when calling <code>/mcp</code>.</p>
        <p style="font-size:13px;color:#ff6b6b;margin-top:8px;">⚠️  Save this token now. You won't see it again. Revoke and re-mint in <a href="/ui/agents">/ui/agents</a> if lost.</p>
      </div>
      <div class="card">
        <h2>Test it</h2>
        <pre>curl -X POST ${new URL(c.req.url).origin}/mcp \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'</pre>
        ${provider === "notion" ? `
        <pre>curl -X POST ${new URL(c.req.url).origin}/mcp \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notion/list_dbs","arguments":{"scope":"${tenant}"}}}'</pre>
        ` : ""}
      </div>
      <p><a href="/ui/tenants">← Back to tenants</a> · <a href="/ui/agents">Manage agents</a></p>
    </main></body></html>
  `);
});

// --- /ui/agents ---
dashboardApp.get("/agents", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login");

  const agents = await prisma.agent.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    include: { roles: { include: { role: true } } },
  });
  const roles = await prisma.role.findMany({ where: { ownerId: user.id }, orderBy: { name: "asc" } });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Agents — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents")}
    <main>
      <h1>Agents</h1>
      <form method="post" action="/ui/agents/bulk-delete" id="bulkAgentForm">
        <input type="hidden" name="agent_ids_csv" id="agentIdsCsv" value="">
        <div class="row spread" style="margin-bottom:8px;">
          <label style="font-size:13px;color:#c8ccd2;cursor:pointer;"><input type="checkbox" id="selAllAgents"> select all</label>
          <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" id="bulkAgentBtn" disabled>🗑 Delete selected (0)</button>
        </div>
      </form>
      ${agents.length === 0 ? '<div class="card"><div class="empty">No agents yet. <a href="/ui/tenants/new">Create one via the tenant wizard</a>.</div></div>' : `
      <div class="card">
        <table>
          <thead><tr><th></th><th>Name</th><th>Token prefix</th><th>Role(s)</th><th>Accessible scopes</th><th>Status</th><th>Last used</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
          ${agents.map((a) => {
            const allScopes = new Set<string>();
            const roleNames: string[] = [];
            for (const r of a.roles) {
              roleNames.push(r.role.name);
              for (const s of safeJsonArray(r.role.allowedScopes)) allScopes.add(s);
            }
            const scopesDisplay = allScopes.size === 0
              ? '<em style="color:#ff6b6b;">⚠️ no scopes (rotate or rebind)</em>'
              : Array.from(allScopes).map((s) => `<span class="badge scoped">${s}</span>`).join(" ");
            const rolesDisplay = roleNames.length === 0
              ? '<em style="color:#ff6b6b;">no role bound</em>'
              : roleNames.map((n) => `<span class="tool-pill">${n}</span>`).join(" ");
            return `
            <tr>
              <td><input type="checkbox" form="bulkAgentForm" name="agent_ids" value="${a.id}" class="agentCheck"></td>
              <td><code>${a.name}</code></td>
              <td><code>${a.tokenPrefix}...</code></td>
              <td>${rolesDisplay}</td>
              <td>${scopesDisplay}</td>
              <td>${a.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</td>
              <td>${a.lastUsedAt ? a.lastUsedAt.toISOString().slice(0, 16) : "—"}</td>
              <td>${a.createdAt.toISOString().slice(0, 10)}</td>
              <td style="position:relative;white-space:nowrap;">
                <details style="display:inline-block; margin-right: 6px;">
                  <summary style="display:inline-block; cursor:pointer; background:#2a2d33; color:#c8ccd2; padding:4px 10px; border-radius:4px; font-size:12px; list-style:none;">Bind</summary>
                  <div style="position:absolute; right:0; background:#1a1c20; border:1px solid #2a2d33; border-radius:4px; padding:8px; z-index:10; min-width:280px; margin-top:4px;">
                    <form method="post" action="/ui/agents/${a.id}/bind">
                      <div style="margin-bottom:6px; font-size:12px; color:#8a8d93;">Replace bindings with:</div>
                      <select name="role_id" style="margin-bottom:6px; font-size:12px; padding:4px; width:100%;">
                        ${roles.map((r) => `<option value="${r.id}">${r.name} (scopes: ${safeJsonArray(r.allowedScopes).join(", ") || "any"})</option>`).join("")}
                      </select>
                      <button type="submit" style="font-size:12px; padding:4px 10px; width:100%;">Bind</button>
                    </form>
                  </div>
                </details>
                <form method="post" action="/ui/agents/${a.id}/rotate" style="display:inline;" onsubmit="return confirm('Rotate token for ${a.name}?\\n\\nThe OLD token will be invalidated immediately. The NEW token will be shown ONCE on the next page.')">
                  <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;">Rotate</button>
                </form>
                <form method="post" action="/ui/agents/${a.id}/delete" style="display:inline;" onsubmit="return confirm('Delete agent ${a.name}?\\n\\nThis permanently destroys its token. The role(s) it was bound to are not deleted.')">
                  <button type="submit" style="font-size:12px;padding:4px 10px;background:#ff6b6b;color:#0e0f12;">🗑</button>
                </form>
              </td>
            </tr>
          `;}).join("")}
          </tbody>
        </table>
      </div>
      `}
      <script>
        const selAllA = document.getElementById('selAllAgents');
        const aChecks = document.querySelectorAll('.agentCheck');
        const aBtn = document.getElementById('bulkAgentBtn');
        const aCsv = document.getElementById('agentIdsCsv');
        const aForm = document.getElementById('bulkAgentForm');
        function updateABtn() {
          const checked = Array.from(document.querySelectorAll('.agentCheck:checked')).map(c => c.value);
          if (aCsv) aCsv.value = checked.join(',');
          if (aBtn) { aBtn.disabled = checked.length === 0; aBtn.textContent = '🗑 Delete selected (' + checked.length + ')'; }
        }
        if (selAllA) selAllA.addEventListener('change', () => {
          aChecks.forEach(c => c.checked = selAllA.checked);
          updateABtn();
        });
        aChecks.forEach(c => c.addEventListener('change', updateABtn));
      </script>
    </main></body></html>
  `);
});

// --- /ui/agents/:id/bind POST (rebind to a different role) ---
dashboardApp.post("/agents/:id/bind", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const id = c.req.param("id");
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  const body = await c.req.parseBody();
  const roleId = String(body.role_id ?? "").trim();
  if (!roleId) return c.html("<h1>role_id required</h1>", 400);
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) return c.html("<h1>role not found</h1>", 404);
  if (role.ownerId !== user.id) return c.html("<h1>not your role</h1>", 403);

  // Replace all bindings with this one role
  await prisma.agentRole.deleteMany({ where: { agentId: agent.id } });
  await prisma.agentRole.create({ data: { agentId: agent.id, roleId: role.id } });

  return c.redirect("/ui/agents");
});

// --- /ui/agents/:id/rotate (POST) ---
dashboardApp.post("/agents/:id/rotate", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const id = c.req.param("id");
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  // Generate new token
  const newToken = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then(c => c.createHash("sha256").update(newToken).digest("hex"));
  const oldPrefix = agent.tokenPrefix;

  await prisma.agent.update({
    where: { id: agent.id },
    data: {
      hashedToken: tokenHash,
      tokenPrefix: newToken.slice(0, 16),
      lastUsedAt: null, // reset usage tracking
    },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Token rotated — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents")}
    <main>
      <h1>✓ Token rotated for <code>${agent.name}</code></h1>
      <div class="card" style="background:rgba(255,107,107,0.08); border-color:#ff6b6b;">
        <h2>⚠️  Old token invalidated</h2>
        <p>The old token (prefix <code>${oldPrefix}...</code>) is no longer valid. Any system still using it will get <code>401 authentication required</code>.</p>
      </div>
      <div class="card" style="background:rgba(110,168,254,0.08); border-color:#6ea8fe;">
        <h2>🔑 New token (save this — shown once!)</h2>
        <pre style="background:#0e0f12;border:1px solid #6ea8fe;">${newToken}</pre>
        <p style="font-size:13px;color:#8a8d93;margin-bottom:0;">Use as <code>Authorization: Bearer ${newToken}</code> when calling <code>/mcp</code>.</p>
        <p style="font-size:13px;color:#ff6b6b;margin-top:8px;">⚠️  Save this token now. If you lose it, you'll need to rotate again.</p>
      </div>
      <div class="card">
        <h2>Test the new token</h2>
        <pre>curl -X POST ${new URL(c.req.url).origin}/mcp \\
  -H "Authorization: Bearer ${newToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'</pre>
      </div>
      <p><a href="/ui/agents">← Back to agents</a></p>
    </main></body></html>
  `);
});

// --- DEBUG: /debug/agents — dumps agent/role/connection state ---
dashboardApp.get("/debug/agents", async (c) => {
  const agents = await prisma.agent.findMany({
    orderBy: { createdAt: "desc" },
    include: { roles: { include: { role: true } } },
  });
  const roles = await prisma.role.findMany();
  const conns = await prisma.connection.findMany();
  return c.json({
    agents: agents.map((a) => ({
      name: a.name,
      tokenPrefix: a.tokenPrefix,
      enabled: a.enabled,
      bindings: a.roles.map((r) => ({ role: r.role.name, allowedScopes: safeJsonArray(r.role.allowedScopes) })),
    })),
    roles: roles.map((r) => ({ name: r.name, allowedScopes: safeJsonArray(r.allowedScopes), allowedTools: safeJsonArray(r.allowedTools) })),
    connections: conns.map((c) => ({ label: c.label, provider: c.provider, scope: c.scope, enabled: c.enabled })),
  });
});

// --- /ui/audit ---
dashboardApp.get("/audit", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login");

  const logs = await prisma.auditLog.findMany({
    take: 100,
    orderBy: { createdAt: "desc" },
    include: { agent: true },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Audit — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("audit")}
    <main>
      <h1>Audit log</h1>
      <p style="color:#8a8d93;">Latest 100 events.</p>
      <div class="card">
        ${logs.length === 0 ? '<div class="empty">No events yet.</div>' : `
        <table>
          <thead><tr><th>When</th><th>Agent</th><th>Tool</th><th>Scope</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
          <tbody>
          ${logs.map((l) => `
            <tr>
              <td><code>${l.createdAt.toISOString().slice(0, 19).replace("T", " ")}</code></td>
              <td>${l.agent?.name ?? "<system>"}</td>
              <td><code>${l.provider}/${l.tool.split("/").pop() ?? l.tool}</code></td>
              <td>${l.scope ? `<span class="badge scoped">${l.scope}</span>` : `<span class="badge unscoped">-</span>`}</td>
              <td>${l.status === "ok" ? '<span class="badge ok">ok</span>' : l.status === "denied" ? '<span class="badge denied">denied</span>' : `<span class="badge denied">${l.status}</span>`}</td>
              <td>${l.durationMs ?? "?"}ms</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;font-size:12px;">${l.errorMessage ?? ""}</td>
            </tr>
          `).join("")}
          </tbody>
        </table>`}
      </div>
    </main></body></html>
  `);
});

// --- /admin/migrate-scopes (one-off, REMOVED 2026-06-05) ---
// (migrate-scopes already executed; endpoint removed. Existing dev roles
// already have allowedScopes=[] from the previous one-off run.)

// --- /oauth/:provider/start (GET) — initiate OAuth flow for any provider ---
// Generic. Reads the provider's authorizeUrl + scopes from the registry,
// reads client_id/secret from env (`<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`).
// Stores the wizard data in OAuthState.payload keyed by the `state` param.
oauthApp.get("/:provider/start", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login");

  const providerKey = c.req.param("provider");
  const providerDef = getProvider(providerKey);
  if (!providerDef || !providerDef.authTypes.includes("oauth")) {
    return c.html(`<h1>unknown or non-OAuth provider: ${escapeHtml(providerKey)}</h1>`, 400);
  }
  if (!providerDef.authorizeUrl || !providerDef.oauthTokenUrl) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth not configured</h1><p>Missing <code>authorizeUrl</code> in registry. <a href="/ui/tenants/new">← Back</a></p>`, 500);
  }

  // Per-provider env var names: GITHUB_CLIENT_ID / GOOGLE_GSC_CLIENT_ID / HUBSPOT_CLIENT_ID
  // (Simple uppercase-with-underscores convention.)
  const envPrefix = providerKey.toUpperCase();
  // Backwards compat: also accept GH_CLIENT_ID (legacy) and GENTITY_GITHUB_CLIENT_ID
  const legacyAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_ID", "GENTITY_GITHUB_CLIENT_ID"],
  };
  const clientId = process.env[`${envPrefix}_CLIENT_ID`]
    || (legacyAliases[providerKey] || []).map(k => process.env[k]).find(Boolean);
  if (!clientId) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth not configured</h1><p>Set <code>${envPrefix}_CLIENT_ID</code> env var. <a href="/ui/tenants/new">← Back</a></p>`, 500);
  }
  const publicUrl = process.env.BETTER_AUTH_URL || `${new URL(c.req.url).origin}`;

  // Collect wizard data from query string
  const payload = {
    tenant: c.req.query("tenant") || "",
    tenant_select: c.req.query("tenant_select") || "",
    additional_scopes: c.req.query("additional_scopes") || "",
    agent: c.req.query("agent") || "",
    agent_desc: c.req.query("agent_desc") || "",
    tools_json: c.req.query("tools_json") || "[]",
    userId: user.id,
  };
  if (!/^[a-z0-9_-]+$/.test(payload.tenant)) {
    return c.html(`<h1>invalid tenant</h1><p>Tenant must match <code>[a-z0-9_-]+</code>. <a href="/ui/tenants/new">← Back</a></p>`, 400);
  }

  // CSRF state
  const state = crypto.randomUUID().replace(/-/g, "");
  await prisma.oAuthState.create({
    data: {
      state,
      provider: providerKey,
      payload: JSON.stringify(payload),
      redirectTo: "/ui/tenants/new",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });

  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/oauth/${providerKey}/callback`;
  // Per-provider authorize URL param tweaks
  let extraParams = "";
  if (providerKey === "github") {
    extraParams = `&allow_signup=true`;
  } else if (providerKey.startsWith("google_")) {
    extraParams = `&access_type=offline&prompt=consent`; // request refresh_token
  } else if (providerKey === "hubspot") {
    extraParams = `&optional_scopes=`;
  }
  const scopeStr = (providerDef.oauthScopes || []).join(" ");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopeStr,
    state,
  });
  return c.redirect(`${providerDef.authorizeUrl}?${params.toString()}${extraParams}`);
});

// --- /oauth/:provider/callback (GET) — handle OAuth callback for any provider ---
// Verifies state, exchanges code for token, encrypts + stores the connection,
// completes the wizard using the saved payload.
oauthApp.get("/:provider/callback", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/ui/login?error=oauth_session_expired");

  const providerKey = c.req.param("provider");
  const providerDef = getProvider(providerKey);
  if (!providerDef) {
    return c.html(`<h1>unknown provider: ${escapeHtml(providerKey)}</h1>`, 400);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.html(`<h1>OAuth callback missing code/state</h1>`, 400);
  }

  // Look up + consume state
  const oauthState = await prisma.oAuthState.findUnique({ where: { state } });
  if (!oauthState || oauthState.expiresAt < new Date()) {
    return c.html(`<h1>OAuth state expired or invalid</h1><p>Try <a href="/ui/tenants/new">creating the tenant</a> again.</p>`, 400);
  }
  await prisma.oAuthState.delete({ where: { state } });
  if (oauthState.provider !== providerKey) {
    return c.html(`<h1>OAuth state provider mismatch (${oauthState.provider} vs ${providerKey})</h1>`, 400);
  }

  let payload: any;
  try { payload = JSON.parse(oauthState.payload || "{}"); } catch { payload = {}; }
  if (payload.userId !== user.id) {
    return c.html(`<h1>OAuth state user mismatch</h1>`, 403);
  }

  // Exchange code for token
  const envPrefix = providerKey.toUpperCase();
  const legacyAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_ID", "GENTITY_GITHUB_CLIENT_ID"],
  };
  const legacySecretAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_SECRET", "GENTITY_GITHUB_CLIENT_SECRET"],
  };
  const clientId = process.env[`${envPrefix}_CLIENT_ID`]
    || (legacyAliases[providerKey] || []).map(k => process.env[k]).find(Boolean);
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`]
    || (legacySecretAliases[providerKey] || []).map(k => process.env[k]).find(Boolean);
  const publicUrl = process.env.BETTER_AUTH_URL || `${new URL(c.req.url).origin}`;
  if (!clientId || !clientSecret) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth credentials missing</h1><p>Set <code>${envPrefix}_CLIENT_ID</code> and <code>${envPrefix}_CLIENT_SECRET</code> env vars.</p>`, 500);
  }
  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/oauth/${providerKey}/callback`;

  const tokenResp = await fetch(providerDef.oauthTokenUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      state,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} token exchange failed</h1><p>HTTP ${tokenResp.status}</p>`, 500);
  }
  const tokenJson: any = await tokenResp.json();
  if (tokenJson.error || !tokenJson.access_token) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} token exchange error</h1><pre>${escapeHtml(JSON.stringify(tokenJson, null, 2))}</pre>`, 500);
  }
  const accessToken = tokenJson.access_token;
  const refreshToken = tokenJson.refresh_token || null;

  // Provider-specific user info fetch (for label)
  let userLogin = providerKey;
  try {
    if (providerKey === "github") {
      const u: any = await (await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "agent-oauth" } })).json();
      if (u.login) userLogin = u.login;
    } else if (providerKey.startsWith("google_")) {
      const u: any = await (await fetch(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${accessToken}`)).json();
      if (u.email) userLogin = u.email;
    } else if (providerKey === "hubspot") {
      const u: any = await (await fetch("https://api.hubapi.com/oauth/v1/access-tokens/" + accessToken)).json();
      if (u.hub_id) userLogin = `hub-${u.hub_id}`;
    }
  } catch { /* non-fatal */ }

  // --- Complete the wizard using the saved payload ---
  const tenant = payload.tenant;
  const tenantSelect = payload.tenant_select || "";
  const effectiveTenant = tenant || tenantSelect;
  const agent = payload.agent;
  const agentDesc = payload.agent_desc || "";
  let tools: string[] = [];
  try { tools = JSON.parse(payload.tools_json || "[]"); } catch {}
  if (!/^[a-z0-9_-]+$/.test(effectiveTenant)) {
    return c.html(`<h1>invalid tenant in saved payload</h1>`, 400);
  }
  if (!agent) {
    return c.html(`<h1>agent name missing in saved payload</h1>`, 400);
  }

  // 1) Create connection (idempotent: dedupe on provider+label+scope)
  const existingConn = await prisma.connection.findFirst({
    where: { provider: providerKey, label: `${providerKey}-${effectiveTenant}`, scope: effectiveTenant, ownerId: user.id },
  });
  const conn = existingConn ?? await prisma.connection.create({
    data: {
      provider: providerKey,
      label: `${providerKey}-${userLogin}-${effectiveTenant}`,
      scope: effectiveTenant,
      ownerId: user.id,
      encryptedCredential: encrypt(accessToken),
      accessTokenExpiresAt: tokenJson.expires_in ? new Date(Date.now() + tokenJson.expires_in * 1000) : null,
      refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
    },
  });
  // If the connection already existed, update the credential (token may have rotated)
  if (existingConn) {
    await prisma.connection.update({
      where: { id: existingConn.id },
      data: {
        encryptedCredential: encrypt(accessToken),
        accessTokenExpiresAt: tokenJson.expires_in ? new Date(Date.now() + tokenJson.expires_in * 1000) : null,
        ...(refreshToken ? { refreshToken: encrypt(refreshToken) } : {}),
      },
    });
  }

  // 2) Find or create role
  const desiredTools = tools.length > 0 ? tools : toolsForProvider(providerKey);
  let role = await prisma.role.findFirst({ where: { name: `${effectiveTenant}-dev`, ownerId: user.id } });
  if (role) {
    const existingTools = safeJsonArray(role.allowedTools);
    const existingScopes = safeJsonArray(role.allowedScopes);
    const mergedTools = Array.from(new Set([...existingTools, ...desiredTools]));
    const mergedScopes = existingScopes.length === 0 ? [] : Array.from(new Set([...existingScopes, effectiveTenant]));
    role = await prisma.role.update({
      where: { id: role.id },
      data: { allowedTools: JSON.stringify(mergedTools), allowedScopes: JSON.stringify(mergedScopes) },
    });
  } else {
    role = await prisma.role.create({
      data: {
        name: `${effectiveTenant}-dev`,
        description: `Role for tenant '${effectiveTenant}' on ${providerKey} (via OAuth)`,
        allowedTools: JSON.stringify(desiredTools),
        allowedScopes: JSON.stringify([]),
        ownerId: user.id,
      },
    });
  }

  // 3) Create agent + bind role + mint token
  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Agent name taken — agent-oauth</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants")}
      <main>
        <h1>⚠️  Agent name <code>${escapeHtml(agent)}</code> already exists</h1>
        <div class="card" style="border-color:#ff6b6b;">
          <p>${escapeHtml(providerDef.label)} connection was created, but the agent name is taken. <a href="/ui/agents/${existingAgent.id}">Reuse the existing agent</a> or pick a different name.</p>
        </div>
        <p><a href="/ui/tenants">← Back to tenants</a></p>
      </main></body></html>
    `, 409);
  }
  const token = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then(c => c.createHash("sha256").update(token).digest("hex"));
  const agentRow = await prisma.agent.create({
    data: {
      name: agent,
      description: agentDesc || null,
      hashedToken: tokenHash,
      tokenPrefix: token.slice(0, 16),
      ownerId: user.id,
      roles: { create: [{ roleId: role.id }] },
    },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(providerDef.label)} connected — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants")}
    <main>
      <h1>✓ GitHub connected · tenant <code>${effectiveTenant}</code> created</h1>
      <div class="card">
        <h2>Connection</h2>
        <p><code>${conn.label}</code> · scope=<code>${conn.scope}</code> · user: <code>${escapeHtml(userLogin)}</code></p>
      </div>
      <div class="card">
        <h2>Role</h2>
        <p><code>${role.name}</code> · ${JSON.parse(role.allowedTools).length} tools</p>
      </div>
      <div class="card">
        <h2>Agent</h2>
        <p><code>${agentRow.name}</code> · bound to <code>${role.name}</code></p>
      </div>
      <div class="card" style="background:rgba(110,168,254,0.08);">
        <h2>🔑 Agent token (save this — shown once!)</h2>
        <pre style="background:#0e0f12;border:1px solid #6ea8fe;">${token}</pre>
        <p style="font-size:13px;color:#8a8d93;margin-bottom:0;">Use as <code>Authorization: Bearer ${token}</code> when calling <code>/mcp</code>.</p>
      </div>
      <p><a href="/ui/tenants">← Back to tenants</a> · <a href="/ui/agents">Manage agents</a></p>
    </main></body></html>
  `);
});

// --- /ui/api/scopes (JSON dump of caller's wiring) ---
// Returns the user's distinct scopes, connections, roles, and agents.
// Useful for agents that need to know what they can call before hitting /mcp.
dashboardApp.get("/api/scopes", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const [conns, roles, agents] = await Promise.all([
    prisma.connection.findMany({
      where: { ownerId: user.id },
      select: { id: true, provider: true, scope: true, label: true, enabled: true, createdAt: true },
      orderBy: [{ scope: "asc" }, { provider: "asc" }],
    }),
    prisma.role.findMany({
      where: { ownerId: user.id },
      select: { id: true, name: true, allowedTools: true, allowedScopes: true, description: true },
      orderBy: { name: "asc" },
    }),
    prisma.agent.findMany({
      where: { ownerId: user.id },
      select: {
        id: true, name: true, tokenPrefix: true, enabled: true, createdAt: true, lastUsedAt: true,
        roles: { select: { role: { select: { name: true, allowedTools: true, allowedScopes: true } } } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    scopes: Array.from(new Set(conns.map((cn) => cn.scope).filter((s) => s))),
    connections: conns.map((cn) => ({ ...cn, createdAt: cn.createdAt.toISOString() })),
    roles: roles.map((r) => ({
      id: r.id, name: r.name, description: r.description,
      allowedTools: safeJsonArray(r.allowedTools),
      allowedScopes: safeJsonArray(r.allowedScopes),
    })),
    agents: agents.map((a) => ({
      id: a.id, name: a.name, tokenPrefix: a.tokenPrefix, enabled: a.enabled,
      createdAt: a.createdAt.toISOString(),
      lastUsedAt: a.lastUsedAt?.toISOString() ?? null,
      boundRoles: a.roles.map((ar) => ar.role.name),
      accessibleTools: Array.from(new Set(a.roles.flatMap((ar) => safeJsonArray(ar.role.allowedTools)))),
      accessibleScopes: Array.from(new Set(
        a.roles.flatMap((ar) => safeJsonArray(ar.role.allowedScopes).length === 0
          ? ["<any>"]
          : safeJsonArray(ar.role.allowedScopes))
      )),
    })),
  });
});

// --- /ui/tenants/:scope/delete (POST) — single tenant delete ---
dashboardApp.post("/tenants/:scope/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  // 1) Find user's connections for this scope
  const conns = await prisma.connection.findMany({
    where: { scope, ownerId: user.id },
    select: { id: true, label: true },
  });
  if (conns.length === 0) {
    return c.html(`<h1>No connections found for scope '${scope}' (yours)</h1>`, 404);
  }

  // 2) Find user's role(s) for this scope (per-user naming)
  const userIdShort = user.id.slice(0, 8);
  const roles = await prisma.role.findMany({
    where: { ownerId: user.id, OR: [{ name: `${scope}-dev-${userIdShort}` }, { name: `${scope}-dev` }, { name: scope }] },
    select: { id: true, name: true },
  });

  // 3) Delete connections (this user only)
  const connDelete = await prisma.connection.deleteMany({
    where: { scope, ownerId: user.id },
  });

  // 4) Delete role(s) and cascade their AgentRole bindings.
  //    If any agent is left with NO role bindings after this, leave them
  //    in place (user can re-bind or delete via the agents page).
  const roleDelete = await prisma.role.deleteMany({
    where: { id: { in: roles.map((r) => r.id) } },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Deleted — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants")}
    <main>
      <h1>✓ Deleted tenant <code>${scope}</code></h1>
      <div class="card">
        <p>Removed <b>${connDelete.count}</b> connection(s) and <b>${roleDelete.count}</b> role(s).</p>
        <p>Agents that were bound to this role are now unbound. Visit <a href="/ui/agents">/ui/agents</a> to re-bind or delete them.</p>
      </div>
      <p><a href="/ui/tenants">← Back to all tenants</a></p>
    </main></body></html>
  `);
});

// --- /ui/tenants/bulk-delete (POST) — bulk tenant delete ---
dashboardApp.post("/tenants/bulk-delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const body = await c.req.parseBody();
  // Accept either `scopes` (repeated) or `scopes_csv` (comma-separated, JS-built).
  const bulkUserIdShort = user.id.slice(0, 8);
  const scopesRaw = body.scopes;
  const scopesCsv = String(body.scopes_csv ?? "").trim();
  const collected: string[] = [];
  if (Array.isArray(scopesRaw)) collected.push(...scopesRaw.map(String));
  else if (scopesRaw) collected.push(String(scopesRaw));
  if (scopesCsv) collected.push(...scopesCsv.split(",").map((s) => s.trim()));
  const scopes = Array.from(new Set(collected.filter((s) => /^[a-z0-9_-]+$/.test(s))));
  if (scopes.length === 0) return c.html("<h1>no scopes selected</h1>", 400);

  let conns = 0, roles = 0;
  const detail: string[] = [];
  for (const scope of scopes) {
    const connDelete = await prisma.connection.deleteMany({ where: { scope, ownerId: user.id } });
    const roleList = await prisma.role.findMany({
      where: { ownerId: user.id, OR: [{ name: `${scope}-dev-${bulkUserIdShort}` }, { name: `${scope}-dev` }, { name: scope }] },
      select: { id: true },
    });
    const roleDelete = await prisma.role.deleteMany({ where: { id: { in: roleList.map((r) => r.id) } } });
    conns += connDelete.count;
    roles += roleDelete.count;
    detail.push(`<li><code>${escapeHtml(scope)}</code>: ${connDelete.count} conn, ${roleDelete.count} role</li>`);
  }
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Bulk deleted — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants")}
    <main>
      <h1>✓ Bulk deleted ${scopes.length} tenant(s)</h1>
      <div class="card">
        <p>Total: <b>${conns}</b> connection(s), <b>${roles}</b> role(s) removed.</p>
        <ul>${detail.join("")}</ul>
      </div>
      <p><a href="/ui/tenants">← Back to all tenants</a></p>
    </main></body></html>
  `);
});

// --- /ui/agents/:id/delete (POST) — single agent delete ---
dashboardApp.post("/agents/:id/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const id = c.req.param("id");
  const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true } });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  // Cascade AgentRole rows via onDelete: Cascade; the agent itself is then deleted.
  await prisma.agent.delete({ where: { id: agent.id } });
  return c.redirect("/ui/agents");
});

// --- /ui/agents/bulk-delete (POST) — bulk agent delete ---
dashboardApp.post("/agents/bulk-delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const body = await c.req.parseBody();
  // Accept either `agent_ids` (repeated) or `agent_ids_csv` (comma-separated).
  const idsRaw = body.agent_ids;
  const idsCsv = String(body.agent_ids_csv ?? "").trim();
  const collected: string[] = [];
  if (Array.isArray(idsRaw)) collected.push(...idsRaw.map(String));
  else if (idsRaw) collected.push(String(idsRaw));
  if (idsCsv) collected.push(...idsCsv.split(",").map((s) => s.trim()).filter(Boolean));
  const ids = Array.from(new Set(collected));
  if (ids.length === 0) return c.html("<h1>no agents selected</h1>", 400);

  // Only delete agents owned by this user.
  const result = await prisma.agent.deleteMany({
    where: { id: { in: ids }, ownerId: user.id },
  });
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Bulk deleted — agent-oauth</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents")}
    <main>
      <h1>✓ Bulk deleted ${result.count} agent(s)</h1>
      <p>${result.count < ids.length ? `(${ids.length - result.count} skipped — not yours or not found)` : ""}</p>
      <p><a href="/ui/agents">← Back to all agents</a></p>
    </main></body></html>
  `);
});
