// grantry — usage analytics page (GET /usage)
//
// Aggregates audit_log into a per-workspace usage dashboard: KPI cards, daily
// tool-call volume (ok vs error), daily active agents, and top tools / scopes /
// agents. Data is scoped to the signed-in user's agents in the active
// workspace, mirroring the isolation /audit uses (agent.ownerId === user.id) so
// no cross-tenant leakage is possible regardless of active-workspace resolution.
//
// This ships as its own module (registered on the exported `dashboardApp`)
// rather than as edits inside the ~400KB single-file ui.ts. Two consequences,
// both intentional and called out in the PR:
//   1. Chrome (CSS/NAV) and the tiny session/active-workspace helpers are
//      duplicated from ui.ts. Follow-up: extract them into a shared module and
//      have ui.ts + this file import them.
//   2. To surface the page in the sidebar on EVERY route, add one line to the
//      NAV link list in ui.ts (this page's own copy of NAV already has it):
//        <a href="/usage" class="${current === "usage" ? "active" : ""}">${t("Usage")}</a>
import { getCookie } from "hono/cookie";
import { auth } from "./auth.js";
import { prisma } from "./db.js";
import { dashboardApp } from "./ui.js";
import { t, htmlLang } from "./i18n.js";

// ---------- chrome (duplicated from ui.ts, see header note) ----------

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;500;600;700&display=swap');
  :root {
    --neutral-primary-soft: #ffffff; --neutral-primary: #ffffff; --neutral-secondary-soft: #fafbfc; --neutral-secondary-medium: #f2f2f5; --neutral-secondary-strong: #f2f2f5; --neutral-tertiary: #ededf0; --neutral-quaternary: #dfdfe3;
    --brand-softer: #f4f0ff; --brand-soft: #e8deff; --brand: #6c47ff; --brand-medium: #d4c4ff; --brand-strong: #5535dc;
    --success-soft: #ecfdf5; --success: #059669; --success-medium: #d1fae5; --success-strong: #047857;
    --danger-soft-token: #fef2f2; --danger-token: #dc2626; --danger-medium: #fee2e2; --danger-strong: #b91c1c;
    --warning-soft: #fffbeb; --warning: #d97706; --warning-medium: #fef3c7; --warning-strong: #b45309;
    --heading: #131316; --body: #5e5f6e; --body-subtle: #747686; --fg-brand: #6c47ff; --fg-brand-strong: #5535dc; --fg-success-strong: #047857; --fg-danger-strong: #991b1b; --fg-warning: #92400e; --fg-disabled: #9ca3af;
    --border-default: #e8e8ec; --border-default-medium: #e8e8ec; --border-default-strong: #e8e8ec; --border-brand: #6c47ff; --border-brand-subtle: #d4c4ff; --border-success-subtle: #a7f3d0; --border-danger-subtle: #fecaca; --border-warning-subtle: #fde68a;
    --disabled: #f2f2f5; --dark: #131316; --dark-strong: #0d0d12; --color-1-400: rgba(255,255,255,0.15); --color-1-700: rgba(0,0,0,0.08);
    --shadow-xs: 0 1px 2px 0 rgb(0 0 0 / 0.04);
    --shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06);
    --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.06), 0 2px 4px -2px rgb(0 0 0 / 0.06);
    --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.07), 0 4px 6px -4px rgb(0 0 0 / 0.07);
    --bg: var(--neutral-secondary-soft); --surface: var(--neutral-primary-soft); --border: var(--border-default); --border-strong: var(--border-default-strong);
    --ink: var(--heading); --ink-2: var(--body); --muted: var(--body-subtle); --faint: var(--fg-disabled);
    --accent: var(--brand); --accent-strong: var(--brand-strong); --accent-soft: var(--brand-softer);
    --ok: var(--success); --ok-soft: var(--success-soft); --danger: var(--danger-token); --danger-soft: var(--danger-soft-token);
    --sidebar-w: 256px;
  }
  * { box-sizing: border-box; }
  body { font-family: "Lato", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--body); margin: 0; line-height: 1.55; -webkit-font-smoothing: antialiased; letter-spacing: 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  nav { position: fixed; z-index: 50; top: 0; left: 0; width: var(--sidebar-w); height: 100vh; display: flex; flex-direction: column; gap: 8px; padding: 16px 12px; border-right: 1px solid var(--border-default); background: var(--surface); overflow-y: auto; }
  nav .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; color: var(--ink); letter-spacing: 0; padding: 6px 10px 14px; }
  nav .brand .brand-mark { width: 28px; height: 28px; flex-shrink: 0; color: var(--ink); }
  .nav-links { display: flex; flex-direction: column; gap: 8px; }
  .ws-switcher { padding: 4px 10px 12px; }
  .ws-switcher label { font-size: 12px; text-transform: uppercase; letter-spacing: 0; color: var(--muted); margin-bottom: 8px; font-weight: 600; }
  .ws-switcher select { width: 100%; padding: 10px 12px; font-size: 14px; font-weight: 600; border-radius: 8px; }
  .ws-new-btn { width: 100%; margin-top: 8px; padding: 8px 14px; font-size: 13px; font-weight: 600; background: var(--surface); color: var(--fg-brand-strong); border: 1px solid var(--border-default-medium); box-shadow: var(--shadow-xs); }
  .ws-new-btn:hover { background: var(--neutral-secondary-medium); color: var(--fg-brand-strong); transform: none; }
  nav a { color: var(--ink); padding: 8px 10px; border-radius: 8px; font-size: 14px; font-weight: 500; white-space: nowrap; transition: background .15s ease, color .15s ease; }
  nav a:hover { background: var(--neutral-secondary-medium); color: var(--ink); text-decoration: none; }
  nav a.active { background: var(--neutral-secondary-strong, var(--neutral-secondary-medium)); color: var(--fg-brand-strong); }
  .nav-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 14px; }
  .nav-user { font-size: 12px; color: var(--muted); }
  .nav-user:hover { color: var(--ink); text-decoration: none; }
  main { box-sizing: border-box; margin-left: var(--sidebar-w); padding: 40px clamp(24px, 4vw, 56px) 96px; max-width: calc(var(--sidebar-w) + 1240px); }
  h1 { font-size: 32px; line-height: 1.1; margin: 0 0 24px; color: var(--ink); font-weight: 700; letter-spacing: 0; }
  h2 { font-size: 22px; line-height: 1.25; margin: 32px 0 16px; color: var(--ink); font-weight: 700; letter-spacing: 0; }
  .card { background: var(--surface); border: 1px solid var(--border-default); border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: var(--shadow-xs); }
  .row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .badge { display: inline-block; padding: 2px 6px; border: 1px solid transparent; border-radius: 8px; font-size: 12px; font-weight: 600; line-height: 1.35; }
  .scope-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
  .scope-summary-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow-sm); }
  .scope-summary-card span { display: block; color: var(--muted); font-size: 12px; font-weight: 600; }
  .scope-summary-card strong { display: block; color: var(--ink); font-size: 22px; line-height: 1.2; margin-top: 4px; }
  .scope-summary-card em { display: block; color: var(--muted); font-size: 12px; font-style: normal; margin-top: 2px; }
  .badge.scoped { background: var(--brand-softer); border-color: var(--border-brand-subtle); color: var(--fg-brand-strong); }
  .badge.unscoped { background: var(--neutral-secondary-medium); border-color: var(--border-default); color: var(--ink); }
  .badge.denied { background: var(--danger-soft); border-color: var(--border-danger-subtle); color: var(--fg-danger-strong); }
  .badge.ok { background: var(--success-soft); border-color: var(--border-success-subtle); color: var(--fg-success-strong); }
  .table-wrap { width: 100%; overflow-x: auto; background: var(--surface); border: 1px solid var(--border-default); border-radius: 12px; box-shadow: var(--shadow-xs); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 14px 20px; border-bottom: 1px solid var(--border-default); font-size: 14px; vertical-align: middle; }
  th { color: var(--muted); background: var(--neutral-secondary-soft); font-weight: 600; }
  tbody tr { background: var(--neutral-primary); }
  tbody tr:hover { background: var(--neutral-secondary-soft); }
  tbody tr:last-child td { border-bottom: 0; }
  code { background: var(--neutral-secondary-medium); padding: 2px 6px; border-radius: 4px; font-size: 13px; font-family: ui-monospace, monospace; color: var(--ink); overflow-wrap: anywhere; }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  .usage-range { display: inline-flex; gap: 8px; margin: 0 0 20px; }
  .usage-range a { padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; border: 1px solid var(--border-default-medium); color: var(--ink); background: var(--surface); box-shadow: var(--shadow-xs); }
  .usage-range a:hover { background: var(--neutral-secondary-medium); text-decoration: none; }
  .usage-range a.active { background: var(--brand); border-color: var(--brand); color: #fff; }
  .chart-legend { display: flex; gap: 16px; align-items: center; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .chart-legend i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .usage-mini { display: inline-block; height: 8px; border-radius: 4px; background: var(--brand); vertical-align: middle; }
  .usage-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  @media (max-width: 900px) {
    nav { position: static; width: 100%; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 16px; border-right: 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
    nav .brand { padding: 6px 8px; font-size: 16px; }
    .nav-links { flex-direction: row; flex-wrap: wrap; }
    .nav-foot { margin-top: 0; flex-direction: row; align-items: center; gap: 8px; border-top: 0; padding-top: 0; margin-left: auto; }
    main { margin-left: 0; padding: 24px 16px 64px; max-width: none; }
    h1 { font-size: 24px; }
    .card { padding: 16px; }
    th, td { padding: 9px 10px; }
    .scope-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .usage-grid2 { grid-template-columns: 1fr; }
  }
`;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 176 176"><style>svg{color:#0a2540}</style><circle cx="88" cy="88" r="76" stroke="currentColor" stroke-width="24" fill="none"/><line x1="100" y1="88" x2="100" y2="169" stroke="currentColor" stroke-width="24"/><line x1="76" y1="7" x2="76" y2="88" stroke="currentColor" stroke-width="24"/><rect x="64" y="75" width="48" height="24" fill="currentColor"/></svg>`;
const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;"
  );
}

const NAV = (current: string, email?: string) => `
<nav>
  <span class="brand"><svg class="brand-mark" viewBox="0 0 176 176" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="88" cy="88" r="76" stroke="currentColor" stroke-width="24"/><line x1="100" y1="88" x2="100" y2="169" stroke="currentColor" stroke-width="24"/><line x1="76" y1="7" x2="76" y2="88" stroke="currentColor" stroke-width="24"/><rect x="64" y="75" width="48" height="24" fill="currentColor"/></svg>grantry</span>
  <div class="ws-switcher">
    <label for="gnWs">${t("Workspace")}</label>
    <select id="gnWs" aria-label="${t("Active workspace")}"><option>…</option></select>
    <button type="button" class="ws-new-btn" id="gnWsNew">${t("+ New workspace")}</button>
  </div>
  <script>
  (function(){
    fetch('/api/workspaces/active',{credentials:'same-origin'})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){
        var sel=document.getElementById('gnWs');
        if(!sel||!d||!d.workspaces||!d.workspaces.length)return;
        sel.innerHTML='';
        d.workspaces.forEach(function(w){
          var o=document.createElement('option');
          o.value=w.id;
          o.textContent=w.displayName+(w.role!=='member'?' ('+w.role+')':'');
          if(w.id===d.activeId)o.selected=true;
          sel.appendChild(o);
        });
        sel.addEventListener('change',function(){
          window.location.href='/workspaces/switch?ws='+encodeURIComponent(sel.value)+'&next='+encodeURIComponent(window.location.pathname+window.location.search);
        });
      }).catch(function(){});
    var openBtn=document.getElementById('gnWsNew');
    if(openBtn){openBtn.addEventListener('click',function(){window.location.href='/workspaces';});}
  })();
  </script>
  <div class="nav-links">
    <a href="/dashboard" class="${current === "dashboard" ? "active" : ""}">${t("Dashboard")}</a>
    <a href="/tenants" class="${current === "tenants" ? "active" : ""}">${t("Scopes")}</a>
    <a href="/connections" class="${current === "connections" ? "active" : ""}">${t("Connections")}</a>
    <a href="/providers" class="${current === "providers" ? "active" : ""}">${t("Providers")}</a>
    <a href="/agents" class="${current === "agents" ? "active" : ""}">${t("Agents")}</a>
    <a href="/workspaces" class="${current === "workspaces" ? "active" : ""}">${t("Workspace")}</a>
    <a href="/usage" class="${current === "usage" ? "active" : ""}">Usage</a>
    <a href="/audit" class="${current === "audit" ? "active" : ""}">${t("Audit")}</a>
    <a href="/api-keys" class="${current === "api-keys" ? "active" : ""}">${t("API keys")}</a>
    <a href="/account" class="${current === "account" ? "active" : ""}">${t("Account")}</a>
  </div>
  <div class="nav-foot">
    ${email ? `<a href="/account" class="nav-user" title="${escapeHtml(t("Signed in as {email}", { email }))}">\u{1F464} <code style="font-size:12px;">${escapeHtml(email)}</code></a>` : ""}
    <form method="post" action="/logout" style="margin:0;">
      <button type="submit" class="secondary" style="font-size:13px;padding:6px 10px;">${t("Sign out")}</button>
    </form>
  </div>
</nav>`;

// ---------- session + active workspace (faithful copies of ui.ts helpers) ----------

async function sessionUser(c: any) {
  const sess = await auth.api.getSession({ headers: c.req.raw.headers });
  return sess?.user ?? null;
}

async function activeWorkspaceId(c: any, userId: string): Promise<string | null> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
  if (!memberships.length) return null;
  const cookieId = getCookie(c, "gn_ws");
  const active =
    (cookieId ? memberships.find((m) => m.workspaceId === cookieId)?.workspace : undefined) ??
    memberships.find((m) => m.role === "owner")?.workspace ??
    memberships[0].workspace;
  return active?.id ?? null;
}

// ---------- helpers ----------

const fmt = (n: number) => n.toLocaleString("en-US");
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * p;
}

// Stacked daily bar chart (ok on the bottom, error+denied on top) as inline SVG.
// Uses CSS variables so it tracks the dashboard palette.
function stackedBarChart(labels: string[], okArr: number[], badArr: number[], aria: string): string {
  const W = 960, H = 260, mL = 46, mR = 14, mT = 12, mB = 30;
  const iw = W - mL - mR, ih = H - mT - mB;
  const n = labels.length;
  const totals = labels.map((_, i) => okArr[i] + badArr[i]);
  const maxY = niceCeil(Math.max(1, ...totals));
  const band = iw / Math.max(1, n);
  const barW = Math.max(1, Math.min(26, band * 0.72));
  const xOf = (i: number) => mL + band * i + (band - barW) / 2;
  const yOf = (v: number) => mT + ih * (1 - v / maxY);
  const hOf = (v: number) => ih * (v / maxY);
  const ticks = 4;
  const gridlines = Array.from({ length: ticks + 1 }, (_, t) => {
    const val = (maxY / ticks) * t;
    const y = yOf(val);
    return `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W - mR}" y2="${y.toFixed(1)}" stroke="var(--border-default)" stroke-width="1"/>`
      + `<text x="${mL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(Math.round(val))}</text>`;
  }).join("");
  const step = Math.max(1, Math.ceil(n / 12));
  const xlabels = labels.map((lb, i) =>
    i % step === 0
      ? `<text x="${(xOf(i) + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="var(--muted)">${escapeHtml(lb)}</text>`
      : ""
  ).join("");
  const bars = labels.map((_, i) => {
    const okH = hOf(okArr[i]);
    const badH = hOf(badArr[i]);
    const okY = mT + ih - okH;
    const badY = okY - badH;
    const okRect = okArr[i] > 0
      ? `<rect x="${xOf(i).toFixed(1)}" y="${okY.toFixed(1)}" width="${barW.toFixed(1)}" height="${okH.toFixed(1)}" fill="var(--success)" rx="1"><title>${escapeHtml(labels[i])}: ${fmt(okArr[i])} ok</title></rect>`
      : "";
    const badRect = badArr[i] > 0
      ? `<rect x="${xOf(i).toFixed(1)}" y="${badY.toFixed(1)}" width="${barW.toFixed(1)}" height="${badH.toFixed(1)}" fill="var(--danger-token)" rx="1"><title>${escapeHtml(labels[i])}: ${fmt(badArr[i])} error/denied</title></rect>`
      : "";
    return okRect + badRect;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHtml(aria)}" style="max-width:100%;height:auto;">`
    + gridlines + bars + xlabels + `</svg>`;
}

// Single-series daily bar chart (brand color).
function barChart(labels: string[], vals: number[], aria: string): string {
  const W = 960, H = 200, mL = 40, mR = 14, mT = 12, mB = 30;
  const iw = W - mL - mR, ih = H - mT - mB;
  const n = labels.length;
  const maxY = niceCeil(Math.max(1, ...vals));
  const band = iw / Math.max(1, n);
  const barW = Math.max(1, Math.min(26, band * 0.72));
  const xOf = (i: number) => mL + band * i + (band - barW) / 2;
  const yOf = (v: number) => mT + ih * (1 - v / maxY);
  const hOf = (v: number) => ih * (v / maxY);
  const ticks = 3;
  const gridlines = Array.from({ length: ticks + 1 }, (_, t) => {
    const val = (maxY / ticks) * t;
    const y = yOf(val);
    return `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W - mR}" y2="${y.toFixed(1)}" stroke="var(--border-default)" stroke-width="1"/>`
      + `<text x="${mL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(Math.round(val))}</text>`;
  }).join("");
  const step = Math.max(1, Math.ceil(n / 12));
  const xlabels = labels.map((lb, i) =>
    i % step === 0
      ? `<text x="${(xOf(i) + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="var(--muted)">${escapeHtml(lb)}</text>`
      : ""
  ).join("");
  const bars = labels.map((_, i) => {
    const h = hOf(vals[i]);
    return vals[i] > 0
      ? `<rect x="${xOf(i).toFixed(1)}" y="${yOf(vals[i]).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="var(--brand)" rx="1"><title>${escapeHtml(labels[i])}: ${fmt(vals[i])}</title></rect>`
      : "";
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHtml(aria)}" style="max-width:100%;height:auto;">`
    + gridlines + bars + xlabels + `</svg>`;
}

function topTable(title: string, rows: { name: string; count: number }[], total: number, mono: boolean): string {
  if (!rows.length) return `<div class="card"><h2 style="margin-top:0;">${escapeHtml(title)}</h2><div class="empty">${t("No data.")}</div></div>`;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const body = rows.map((r) => {
    const pct = total > 0 ? (r.count / total) * 100 : 0;
    const barW = (r.count / max) * 90;
    const label = mono ? `<code>${escapeHtml(r.name)}</code>` : escapeHtml(r.name);
    return `<tr>
      <td>${label}</td>
      <td style="text-align:right;white-space:nowrap;">${fmt(r.count)} <span style="color:var(--muted);font-size:12px;">(${pct.toFixed(1)}%)</span></td>
      <td style="width:120px;"><span class="usage-mini" style="width:${barW.toFixed(1)}px;"></span></td>
    </tr>`;
  }).join("");
  return `<div class="table-wrap" style="margin-bottom:16px;">
    <table>
      <thead><tr><th>${escapeHtml(title)}</th><th style="text-align:right;">${t("Calls")}</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

// ---------- route ----------

dashboardApp.get("/usage", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login");

  const wsId = await activeWorkspaceId(c, user.id);

  const daysParam = Number(c.req.query("days"));
  const days = [7, 30, 90].includes(daysParam) ? daysParam : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Same isolation as /audit: only this user's own agents. Active workspace
  // narrows further; the ownerId filter is the security boundary.
  const where: any = wsId
    ? { createdAt: { gte: since }, agent: { ownerId: user.id, workspaceId: wsId } }
    : { createdAt: { gte: since }, OR: [{ userId: user.id }, { agent: { ownerId: user.id } }] };

  const rows = await prisma.auditLog.findMany({
    where,
    select: {
      createdAt: true,
      provider: true,
      tool: true,
      scope: true,
      status: true,
      agentId: true,
      agent: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Build the full day axis so gaps render as zero-height bars.
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(utcDay(new Date(Date.now() - i * 86400000)));
  const dayIndex = new Map(dayKeys.map((d, i) => [d, i]));

  const okByDay = new Array(dayKeys.length).fill(0);
  const badByDay = new Array(dayKeys.length).fill(0);
  const agentsByDay: Set<string>[] = dayKeys.map(() => new Set());
  const toolCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();
  const agentCounts = new Map<string, number>();
  const distinctAgents = new Set<string>();
  let total = 0, okTotal = 0, errTotal = 0, denTotal = 0;

  for (const r of rows) {
    total++;
    if (r.status === "ok") okTotal++;
    else if (r.status === "denied") denTotal++;
    else errTotal++;

    const key = utcDay(r.createdAt);
    const di = dayIndex.get(key);
    if (di !== undefined) {
      if (r.status === "ok") okByDay[di]++; else badByDay[di]++;
      if (r.agentId) agentsByDay[di].add(r.agentId);
    }

    const toolLabel = `${r.provider}/${(r.tool.split("/").pop() ?? r.tool)}`;
    toolCounts.set(toolLabel, (toolCounts.get(toolLabel) ?? 0) + 1);
    const scopeLabel = r.scope || t("(unscoped)");
    scopeCounts.set(scopeLabel, (scopeCounts.get(scopeLabel) ?? 0) + 1);
    const agentLabel = r.agent?.name ?? "<system>";
    agentCounts.set(agentLabel, (agentCounts.get(agentLabel) ?? 0) + 1);
    if (r.agentId) distinctAgents.add(r.agentId);
  }

  const topN = (m: Map<string, number>, n = 10) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

  const dailyTotals = dayKeys.map((_, i) => okByDay[i] + badByDay[i]);
  let peakVal = 0, peakDay = "—";
  dailyTotals.forEach((v, i) => { if (v > peakVal) { peakVal = v; peakDay = dayKeys[i]; } });
  const successRate = total > 0 ? (okTotal / total) * 100 : 0;
  const activeAgentsPerDay = agentsByDay.map((s) => s.size);

  const shortLabels = dayKeys.map((d) => d.slice(5));
  const rangeLink = (d: number, lbl: string) =>
    `<a href="/usage?days=${d}" class="${days === d ? "active" : ""}">${lbl}</a>`;

  const body = total === 0
    ? `<div class="card"><div class="empty">${t("No tool calls in the last {days} days for this workspace.", { days })}</div></div>`
    : `
      <div class="scope-summary-grid">
        <div class="scope-summary-card"><span>${t("Tool calls")}</span><strong>${fmt(total)}</strong><em>${t("last {days} days", { days })}</em></div>
        <div class="scope-summary-card"><span>${t("Success rate")}</span><strong>${successRate.toFixed(1)}%</strong><em>${t("{errors} error / {denied} denied", { errors: fmt(errTotal), denied: fmt(denTotal) })}</em></div>
        <div class="scope-summary-card"><span>${t("Peak day")}</span><strong>${fmt(peakVal)}</strong><em>${escapeHtml(peakDay)}</em></div>
        <div class="scope-summary-card"><span>${t("Active agents")}</span><strong>${fmt(distinctAgents.size)}</strong><em>${t("distinct, in range")}</em></div>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">${t("Daily tool calls")}</h2>
        <div class="chart-legend">
          <span><i style="background:var(--success);"></i> ${t("ok")}</span>
          <span><i style="background:var(--danger-token);"></i> ${t("error / denied")}</span>
        </div>
        ${stackedBarChart(shortLabels, okByDay, badByDay, t("Daily tool calls over the last {days} days, successful versus failed", { days }))}
      </div>

      <div class="card">
        <h2 style="margin-top:0;">${t("Daily active agents")}</h2>
        ${barChart(shortLabels, activeAgentsPerDay, t("Distinct active agents per day over the last {days} days", { days }))}
      </div>

      <div class="usage-grid2">
        ${topTable(t("Top tools"), topN(toolCounts), total, true)}
        ${topTable(t("Top scopes"), topN(scopeCounts), total, false)}
      </div>
      ${topTable(t("Top agents"), topN(agentCounts), total, false)}
    `;

  return c.html(`
    <!doctype html><html lang="${htmlLang()}"><head><meta charset="utf-8"><title>${t("Usage")} — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("usage", user?.email)}
    <main>
      <h1>${t("Usage")}</h1>
      <p style="color:var(--muted);margin-top:-14px;">${t("Tool-call activity for agents in the active workspace, from the audit log.")}</p>
      <div class="usage-range">
        ${rangeLink(7, t("7 days"))}${rangeLink(30, t("30 days"))}${rangeLink(90, t("90 days"))}
      </div>
      ${body}
    </main></body></html>
  `);
});
