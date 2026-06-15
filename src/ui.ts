// grantry UI — login, dashboard, tenant wizard, audit log
import { Hono } from "hono";
import { auth } from "./auth.js";
import { prisma } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { PROVIDERS, getProvider, listProviders, toolsForProvider } from "./connectors/registry.js";
import { providerIcon, providerIconMap } from "./connectors/icons.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";
import { connectionsForAgent } from "./policy.js";
import { ensureTenant } from "./tenants.js";
import { sendSystemEmail } from "./email.js";
import { connectableAgentsFor, userMayUseAgent } from "./workspaces.js";
import nodeCrypto from "node:crypto";

export const dashboardApp = new Hono();

// Separate Hono app for OAuth flows (mounted at /oauth in server.ts).
// Not under the dashboard routes because GitHub's OAuth callback URL needs to be a stable
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

function jsString(s: string): string {
  // \u003c keeps user-influenced strings from closing a <script> block.
  return JSON.stringify(s).replace(/</g, "\\u003c");
}

function authTypeLabel(providerKey: string, authType: string): string {
  if (authType === "oauth") return "OAuth";
  if (providerKey === "hubspot") return "Private App token";
  if (providerKey === "attio") return "Access token";
  if (providerKey === "clay") return "API key";
  if (providerKey === "heyreach") return "API key";
  if (providerKey === "chatwork") return "API token";
  if (providerKey === "railway") return "Project token";
  if (providerKey === "resend") return "API key";
  if (providerKey === "slack") return "Bot token";
  if (providerKey === "google_maps") return "API key";
  if (providerKey === "discord") return "Bot token";
  if (providerKey === "line") return "Channel access token";
  if (["airtable", "linear", "sendgrid", "vercel", "stripe", "webflow", "intercom", "customerio", "mailchimp"].includes(providerKey)) return "API key";
  if (providerKey === "linkedin_ads" || providerKey === "tiktok_ads") return "Access token";
  if (["zendesk", "wordpress", "shopify", "jira", "salesforce", "microsoft_ads", "aws", "snowflake"].includes(providerKey)) return "JSON credential";
  return "paste token";
}

function credentialPlaceholder(providerKey: string, providerLabel: string, authType: string): string {
  if (authType === "oauth") return "OAuth flow will start after submit";
  if (providerKey === "hubspot") return "Paste your HubSpot Private App access token here (starts with pat-)";
  if (providerKey === "attio") return "Paste your Attio access token from Settings > Developers";
  if (providerKey === "clay") return "Paste your Clay API key from Settings > Account > API key";
  if (providerKey === "heyreach") return "Paste your HeyReach Public API key";
  if (providerKey === "chatwork") return "Paste your Chatwork API token";
  if (providerKey === "railway") return "Paste your Railway Project Token from Project Settings > Tokens";
  if (providerKey === "resend") return "Paste your Resend API key";
  if (providerKey === "slack") return "Paste your Slack Bot User OAuth Token (starts with xoxb-)";
  if (providerKey === "google_maps") return "Paste your Google Maps Platform API key";
  if (providerKey === "discord") return "Paste your Discord Bot Token from the Developer Portal > Bot";
  if (providerKey === "line") return "Paste your LINE Channel Access Token (Messaging API > Channel access token)";
  if (providerKey === "airtable") return "Paste your Airtable Personal Access Token (patXXXX...)";
  if (providerKey === "linear") return "Paste your Linear Personal API Key (lin_api_...)";
  if (providerKey === "sendgrid") return "Paste your SendGrid API key (SG....)";
  if (providerKey === "vercel") return "Paste your Vercel access token";
  if (providerKey === "stripe") return "Paste your Stripe secret key (sk_live_... or sk_test_...)";
  if (providerKey === "webflow") return "Paste your Webflow API token";
  if (providerKey === "intercom") return "Paste your Intercom Access Token";
  if (providerKey === "customerio") return 'App API key, or JSON {"token":"...","region":"eu"} for the EU region';
  if (providerKey === "mailchimp") return "Paste your Mailchimp API key (e.g. abc123-us21)";
  if (providerKey === "zendesk") return 'JSON: {"subdomain":"acme","email":"you@example.com","token":"..."}';
  if (providerKey === "wordpress") return 'JSON: {"site":"https://blog.example.com","username":"admin","app_password":"xxxx xxxx ..."}';
  if (providerKey === "shopify") return 'JSON: {"shop":"acme.myshopify.com","token":"shpat_..."}';
  if (providerKey === "jira") return 'JSON: {"site":"https://acme.atlassian.net","email":"you@example.com","token":"..."}';
  if (providerKey === "salesforce") return 'JSON: {"instance_url":"https://acme.my.salesforce.com","token":"..."}';
  if (providerKey === "linkedin_ads") return "Paste your LinkedIn OAuth access token (r_ads/rw_ads scopes)";
  if (providerKey === "tiktok_ads") return "Paste your TikTok for Business access token";
  if (providerKey === "microsoft_ads") return 'JSON: {"developer_token":"...","access_token":"...","customer_id":"...","account_id":"..."}';
  if (providerKey === "aws") return 'JSON: {"accessKeyId":"AKIA...","secretAccessKey":"...","region":"us-east-1"}';
  if (providerKey === "snowflake") return 'JSON: {"account":"orgname-accountname","token":"...","warehouse":"...","database":"..."}';
  return `Paste your ${providerLabel} token here`;
}

function tokenLinkLabel(providerKey: string, providerLabel: string): string {
  if (providerKey === "hubspot") return "🔗 Get a new HubSpot Private App access token here →";
  if (providerKey === "attio") return "🔗 Manage Attio access tokens here →";
  if (providerKey === "clay") return "🔗 Open Clay API key settings →";
  if (providerKey === "heyreach") return "🔗 Open HeyReach app →";
  if (providerKey === "chatwork") return "🔗 Open Chatwork API token settings →";
  if (providerKey === "railway") return "🔗 Open Railway →";
  if (providerKey === "resend") return "🔗 Open Resend API keys →";
  if (providerKey === "slack") return "🔗 Open Slack apps (create app / get Bot token) →";
  if (providerKey === "google_maps") return "🔗 Open Google Maps Platform credentials →";
  if (providerKey === "discord") return "🔗 Open Discord Developer Portal (create app / get Bot token) →";
  if (providerKey === "line") return "🔗 Open LINE Developers console (Messaging API channel) →";
  if (providerKey === "github") return "🔗 Manage GitHub PAT repository access here →";
  return `🔗 Get a new ${providerLabel} token here →`;
}

function serverCredentialHint(providerKey: string): string {
  const provider = getProvider(providerKey);
  if (!provider?.serverCredentialEnv) return "";
  const present = !!process.env[provider.serverCredentialEnv];
  const status = present ? '<span class="badge ok">set</span>' : '<span class="badge denied">missing</span>';
  const url = provider.serverCredentialUrl
    ? ` <a href="${provider.serverCredentialUrl}" target="_blank" rel="noopener">Open Google Ads API Center →</a>`
    : "";
  return `<div class="field-hint" style="margin-top:6px;">${status} Google Ads Developer token is separate from OAuth. After OAuth, paste the API Center token into the Google Ads connection row.${url}</div>`;
}

function pkceCodeVerifier(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

async function pkceCodeChallenge(verifier: string): Promise<string> {
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.createHash("sha256").update(verifier).digest("base64url");
}

// Renders the "Agent token" card with a copy-to-clipboard button.
// The token is shown once, so we make it easy to grab. `warningHtml` is
// raw HTML (may contain links); pass "" to omit the warning line.
function agentTokenCard(
  token: string,
  warningHtml = "⚠️ Save this token now. You won't see it again."
): string {
  const safe = escapeHtml(token);
  return `
      <div class="card" style="background:rgba(110,168,254,0.08);">
        <h2>🔑 Agent token (save this — shown once!)</h2>
        <div class="row" style="align-items:stretch;gap:8px;">
          <pre style="background:#0e0f12;border:1px solid #6ea8fe;flex:1;margin:0;">${safe}</pre>
          <button type="button" class="secondary copy-token-btn" data-token="${safe}" style="white-space:nowrap;">📋 Copy</button>
        </div>
        <p style="font-size:13px;color:#8a8d93;margin-bottom:0;margin-top:12px;">Use as <code>Authorization: Bearer ${safe}</code> when calling <code>/mcp</code>.</p>
        ${warningHtml ? `<p style="font-size:13px;color:#ff6b6b;margin-top:8px;">${warningHtml}</p>` : ""}
      </div>
      <script>
        (function () {
          document.querySelectorAll('.copy-token-btn').forEach(function (btn) {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', async function () {
              var text = btn.dataset.token;
              try {
                await navigator.clipboard.writeText(text);
              } catch (e) {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch (_) {}
                document.body.removeChild(ta);
              }
              var orig = btn.textContent;
              btn.textContent = '✓ Copied!';
              setTimeout(function () { btn.textContent = orig; }, 1500);
            });
          });
        })();
      </script>`;
}

function mcpConfigCard(origin: string, agentName: string, token: string, exactToken: boolean, scope?: string): string {
  return `<div class="card">${mcpConfigBlock(origin, agentName, token, exactToken, scope)}</div>`;
}

function mcpConfigBlock(origin: string, agentName: string, token: string, exactToken: boolean, scope?: string): string {
  const serverName = `grantry-${scope || agentName}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const codexToml = `[mcp_servers.${serverName}]
type = "streamable-http"
url = "${origin}/mcp"

[mcp_servers.${serverName}.http_headers]
Authorization = "Bearer ${token}"
${scope ? `X-Grantry-Scope = "${scope}"` : ""}`;
  const claudeConfig = {
    mcpServers: {
      [serverName]: {
        type: "http",
        url: `${origin}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(scope ? { "X-Grantry-Scope": scope } : {}),
        },
      },
    },
  };
  const claudeJson = JSON.stringify(claudeConfig, null, 2);
  const claudeCli = `claude mcp add --scope user --transport http ${serverName} \\
  ${origin}/mcp \\
  --header "Authorization: Bearer ${token}"${scope ? ` \\
  --header "X-Grantry-Scope: ${scope}"` : ""}`;
  const claudeDesktopConfig = {
    mcpServers: {
      [serverName]: {
        command: "npx",
        args: [
          "-y",
          "mcp-remote@latest",
          `${origin}/mcp`,
          "--header",
          `Authorization: Bearer ${token}`,
          ...(scope ? ["--header", `X-Grantry-Scope: ${scope}`] : []),
        ],
      },
    },
  };
  const claudeDesktopJson = JSON.stringify(claudeDesktopConfig, null, 2);
  const copyButton = (label: string, text: string) =>
    `<button type="button" class="secondary copy-config-btn" data-copy="${escapeHtml(text)}" style="font-size:12px;padding:4px 10px;">Copy ${label}</button>`;
  return `
        <h2>MCP config</h2>
        <p style="font-size:13px;color:#8a8d93;margin-top:0;">
          ${scope
            ? `Use one MCP server entry per tenant. Tool names stay stable; the token and <code>X-Grantry-Scope</code> lock this entry to the selected tenant.`
            : `This entry is <b>not</b> scope-locked: the token decides what it can reach, and each call picks its tenant via the <code>scope</code> argument.`}
        </p>
        <div class="row spread" style="margin:16px 0 8px;">
          <h3 style="font-size:14px;margin:0;color:#c8ccd2;">Codex <code>~/.codex/config.toml</code></h3>
          ${copyButton("Codex", codexToml)}
        </div>
        <pre>${escapeHtml(codexToml)}</pre>
        <div class="row spread" style="margin:16px 0 8px;">
          <h3 style="font-size:14px;margin:0;color:#c8ccd2;">Claude Code JSON <code>~/.claude.json</code></h3>
          ${copyButton("JSON", claudeJson)}
        </div>
        <pre>${escapeHtml(claudeJson)}</pre>
        <div class="row spread" style="margin:16px 0 8px;">
          <h3 style="font-size:14px;margin:0;color:#c8ccd2;">Claude Code CLI</h3>
          ${copyButton("CLI", claudeCli)}
        </div>
        <pre>${escapeHtml(claudeCli)}</pre>
        <div class="row spread" style="margin:16px 0 8px;">
          <h3 style="font-size:14px;margin:0;color:#c8ccd2;">Claude Desktop <code>claude_desktop_config.json</code></h3>
          ${copyButton("Desktop", claudeDesktopJson)}
        </div>
        <pre>${escapeHtml(claudeDesktopJson)}</pre>
        ${exactToken
          ? '<p style="font-size:13px;color:#8a8d93;margin-bottom:0;">This config includes the newly minted token. <code>Mcp-Session-Id</code> is managed by the MCP client/server handshake.</p>'
          : '<p style="font-size:13px;color:#ff6b6b;margin-bottom:0;">The full token is only shown when created or rotated. Rotate this agent if you need a copy-pasteable config with a fresh token.</p>'}
        <script>
          (function () {
            document.querySelectorAll('.copy-config-btn').forEach(function (btn) {
              if (btn.dataset.bound) return;
              btn.dataset.bound = '1';
              btn.addEventListener('click', async function () {
                var text = btn.dataset.copy || '';
                try {
                  await navigator.clipboard.writeText(text);
                } catch (e) {
                  var ta = document.createElement('textarea');
                  ta.value = text;
                  ta.style.position = 'fixed';
                  ta.style.opacity = '0';
                  document.body.appendChild(ta);
                  ta.select();
                  try { document.execCommand('copy'); } catch (_) {}
                  document.body.removeChild(ta);
                }
                var orig = btn.textContent;
                btn.textContent = 'Copied';
                setTimeout(function () { btn.textContent = orig; }, 1500);
              });
            });
          })();
        </script>
      `;
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0e0f12; color: #e1e3e6; margin: 0; line-height: 1.5; }
  a { color: #6ea8fe; text-decoration: none; }
  a:hover { text-decoration: underline; }
  nav { display: flex; gap: 8px; padding: 12px 24px; border-bottom: 1px solid #2a2d33; background: #14161a; align-items: center; overflow-x: auto; }
  nav .brand { font-weight: 700; }
  nav span { white-space: nowrap; }
  nav a { color: #c8ccd2; padding: 6px 10px; border-radius: 4px; }
  nav a:hover, nav a.active { background: rgba(110,168,254,0.1); color: #6ea8fe; text-decoration: none; }
  main { width: min(100% - 48px, 1180px); margin: 32px auto; }
  h1 { font-size: 28px; margin: 0 0 24px; }
  h2 { font-size: 18px; margin: 24px 0 12px; color: #c8ccd2; }
  .card { background: #14161a; border: 1px solid #2a2d33; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .row.spread { justify-content: space-between; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .provider-icon { flex-shrink: 0; vertical-align: -4px; }
  .provider-cell { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .badge.scoped { background: rgba(110,168,254,0.16); color: #6ea8fe; }
  .badge.unscoped { background: rgba(160,160,160,0.16); color: #aaa; }
  .badge.denied { background: rgba(255,107,107,0.16); color: #ff6b6b; }
  .badge.ok { background: rgba(81,207,102,0.16); color: #51cf66; }
  .table-wrap { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #2a2d33; font-size: 14px; vertical-align: middle; }
  th { color: #8a8d93; font-weight: 500; }
  td:first-child, th:first-child { padding-left: 0; }
  td:last-child, th:last-child { padding-right: 0; }
  code, pre { background: #1a1c20; padding: 2px 6px; border-radius: 3px; font-size: 13px; font-family: ui-monospace, monospace; }
  code { overflow-wrap: anywhere; }
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
  input[type=checkbox] { accent-color: #6ea8fe; }
  .empty { padding: 40px; text-align: center; color: #8a8d93; }
  .tool-pill { display: inline-block; padding: 2px 8px; margin: 2px; background: #1a1c20; border: 1px solid #2a2d33; border-radius: 12px; font-size: 11px; font-family: ui-monospace, monospace; }
  .step-card { background: #14161a; border: 1px solid #2a2d33; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
  .step-card h2 { margin-top: 0; display: flex; align-items: center; gap: 12px; }
  .step-card h2 .num { display: inline-block; width: 28px; height: 28px; line-height: 28px; text-align: center; background: #6ea8fe; color: #0e0f12; border-radius: 50%; font-size: 14px; font-weight: 700; }
  .connection-table { table-layout: fixed; min-width: 920px; }
  .connection-table th:nth-child(1), .connection-table td:nth-child(1) { width: 130px; }
  .connection-table th:nth-child(2), .connection-table td:nth-child(2) { width: 78px; }
  .connection-table th:nth-child(3), .connection-table td:nth-child(3) { width: 120px; }
  .connection-table th:nth-child(4), .connection-table td:nth-child(4) { width: auto; }
  .connection-table th:nth-child(5), .connection-table td:nth-child(5) { width: 110px; }
  .connection-table th:nth-child(6), .connection-table td:nth-child(6) { width: 90px; }
  .connection-table th:nth-child(7), .connection-table td:nth-child(7) { width: 104px; }
  .connection-table th:nth-child(8), .connection-table td:nth-child(8) { width: 124px; }
  .connection-table td:nth-child(4) { line-height: 1.7; }
  .connection-table td:nth-child(5) input { min-width: 0; }
  .connection-table td:nth-child(6) label { display: inline-flex; align-items: center; gap: 6px; margin: 0; white-space: nowrap; }
  .connection-table td:nth-child(7) code { white-space: nowrap; }
  .credential-summary { max-width: 100%; }
  .credential-summary code { display: inline-block; max-width: 100%; white-space: normal; word-break: break-all; }
  .stacked-actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 760px) {
    nav { padding: 10px 16px; }
    main { width: min(100% - 32px, 1180px); margin: 24px auto; }
    h1 { font-size: 24px; }
    .card { padding: 16px; }
    th, td { padding: 9px 10px; }
    .connection-table { min-width: 860px; }
  }
`;

const NAV = (current: string, email?: string) => `
<nav>
  <span class="brand">grantry</span>
  <a href="/dashboard" class="${current === "dashboard" ? "active" : ""}">Dashboard</a>
  <a href="/tenants" class="${current === "tenants" ? "active" : ""}">Tenants</a>
  <a href="/agents" class="${current === "agents" ? "active" : ""}">Agents</a>
  <a href="/workspaces" class="${current === "workspaces" ? "active" : ""}">Workspace</a>
  <a href="/audit" class="${current === "audit" ? "active" : ""}">Audit</a>
  <a href="/meta" class="${current === "meta" ? "active" : ""}">Meta</a>
  <a href="/account" class="${current === "account" ? "active" : ""}">Account</a>
  <span style="flex:1"></span>
  ${email ? `<a href="/account" title="Signed in as ${escapeHtml(email)}" style="font-size:12px;color:#8a8d93;margin-right:10px;">\u{1F464} <code style="font-size:12px;">${escapeHtml(email)}</code></a>` : ""}
  <form method="post" action="/logout" style="margin:0;">
    <button type="submit" class="secondary" style="font-size:13px;padding:6px 10px;">Sign out</button>
  </form>
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

function safeJsonObject(s: string | null | undefined): Record<string, any> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function renderCredentialSummary(cn: {
  credentialMetadata?: string | null;
  credentialValidatedAt?: Date | null;
}) {
  const meta = safeJsonObject(cn.credentialMetadata);
  if (!meta.status) return '<span style="color:#8a8d93;font-size:12px;">not checked</span>';
  if (meta.status === "error") {
    return `<span class="badge denied">check failed</span> <span style="color:#8a8d93;font-size:12px;">${escapeHtml(String(meta.error ?? "")).slice(0, 80)}</span>`;
  }
  const scopes = Array.isArray(meta.scopes) ? meta.scopes.map(String) : [];
  const resources = Array.isArray(meta.resources) ? meta.resources : [];
  const subject = meta.subject && typeof meta.subject === "object" ? meta.subject : {};
  const parts: string[] = [];
  if (scopes.length) parts.push(scopes.slice(0, 4).map((s) => `<code>${escapeHtml(s)}</code>`).join(" "));
  if (resources.length) parts.push(`<span style="color:#8a8d93;font-size:12px;">${resources.length} resource${resources.length === 1 ? "" : "s"}</span>`);
  if (subject.login) parts.push(`<span style="color:#8a8d93;font-size:12px;">@${escapeHtml(String(subject.login))}</span>`);
  if (subject.email) parts.push(`<span style="color:#8a8d93;font-size:12px;">${escapeHtml(String(subject.email))}</span>`);
  if (!parts.length) parts.push(`<span style="color:#8a8d93;font-size:12px;">${escapeHtml(String(meta.status))}</span>`);
  const validated = cn.credentialValidatedAt ? ` title="Checked ${cn.credentialValidatedAt.toISOString()}"` : "";
  return `<div class="credential-summary"${validated}>${parts.join("<br>")}</div>`;
}

function oauthTokenStatus(cn: { authType: string; accessTokenExpiresAt?: Date | null; refreshToken?: string | null }) {
  if (cn.authType !== "oauth" || !cn.accessTokenExpiresAt) return "";
  if (cn.accessTokenExpiresAt >= new Date()) {
    return `<span class="badge ok" title="Access token expires at ${cn.accessTokenExpiresAt.toISOString()}">access token active</span>`;
  }
  if (cn.refreshToken) {
    return `<span class="badge unscoped" title="Access token expired at ${cn.accessTokenExpiresAt.toISOString()}, but calls will refresh it automatically.">refreshable</span>`;
  }
  return `<span class="badge denied" title="Access token expired at ${cn.accessTokenExpiresAt.toISOString()} and no refresh token is stored.">token expired</span>`;
}

async function getSessionUser(c: any) {
  const sess = await auth.api.getSession({ headers: c.req.raw.headers });
  return sess?.user ?? null;
}

async function getDbSessionUser(c: any) {
  const user = await getSessionUser(c);
  if (!user?.id) return null;
  return prisma.user.findUnique({ where: { id: user.id } });
}

// ---------- MCP OAuth consent support ----------
// Backing endpoints for the consent screen rendered by the better-auth mcp
// plugin (see consentHTML in auth.ts). Session-authenticated: the consent
// page runs in the user's logged-in browser.

/**
 * Gate in front of GET /api/auth/mcp/authorize (mounted in server.ts before
 * the better-auth handler). The better-auth mcp plugin only renders a consent
 * screen when the client sends prompt=consent — claude.ai does not — so the
 * agent binding would never be created and OAuth tokens could not resolve to
 * an Agent. This gate guarantees an OauthAgentGrant exists before the
 * authorize flow proceeds:
 *  - no session            → null (better-auth redirects to /login; we re-enter after)
 *  - binding exists        → null (pass through)
 *  - exactly one agent     → auto-bind, pass through
 *  - multiple agents       → render a picker; submit binds then resumes authorize
 */
export async function mcpAuthorizeGate(c: any): Promise<Response | null> {
  const user = await getSessionUser(c);
  if (!user?.id) return null;
  const clientId = c.req.query("client_id") ?? "";
  if (!clientId) return null;

  // Workspace-locked connector URL: the authorize request's RFC 8707
  // `resource` parameter carries the MCP URL the client connected to
  // (e.g. https://host/mcp/w/acme). Use it to pin the choice to that ws.
  const resourceParam = String(c.req.query("resource") ?? "");
  const wsLock = resourceParam.match(/\/mcp\/w\/([A-Za-z0-9-]+)/)?.[1] ?? "";

  const existing = await prisma.oauthAgentGrant.findUnique({
    where: { userId_clientId: { userId: user.id, clientId } },
    include: { agent: { select: { workspace: { select: { slug: true } } } } },
  });
  if (existing && (!wsLock || existing.agent?.workspace?.slug === wsLock)) return null;

  let agents = await connectableAgentsFor(user.id);
  if (wsLock) agents = agents.filter((a) => a.workspace?.slug === wsLock);
  if (agents.length === 1) {
    await prisma.oauthAgentGrant.upsert({
      where: { userId_clientId: { userId: user.id, clientId } },
      create: { userId: user.id, clientId, agentId: agents[0].id },
      update: { agentId: agents[0].id },
    });
    return null;
  }
  if (!agents.length) {
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>No agents — grantry</title>
      <style>${CSS} body { max-width: 420px; margin: 80px auto; padding: 0 24px; }</style></head><body>
      <h1>No enabled agents</h1>
      <div class="card"><p>This connector must act as one of your grantry agents, but your account has none enabled. Create an agent in the <a href="/dashboard">dashboard</a>, then retry the connection.</p></div>
      </body></html>`,
      403,
    );
  }

  const client = await prisma.oauthApplication.findUnique({ where: { clientId } });
  const clientName = client?.name || "MCP client";
  const resumeQS = new URL(c.req.url).searchParams.toString();
  const options = agents
    .map((a) =>
      `<label class="agent-opt"><input type="radio" name="agent" value="${escapeHtml(a.id)}">
       <span><b>${escapeHtml(a.name)}</b>${a.workspace ? ` <small style="color:#8a8d93;">(${escapeHtml(a.workspace.displayName)})</small>` : ""}${a.description ? `<br><small style="color:#8a8d93;">${escapeHtml(a.description)}</small>` : ""}</span></label>`,
    )
    .join("");
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose agent — grantry</title>
    <style>${CSS} body { max-width: 440px; margin: 60px auto; padding: 0 24px; }
    .agent-opt { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid #30343a; border-radius:8px; margin-bottom:8px; cursor:pointer; }
    .agent-opt:hover { border-color: #58a6ff; }
    </style></head><body>
    <h1>Connect ${escapeHtml(clientName)}</h1>
    <div class="card">
      <p>${escapeHtml(clientName)} will act as the agent you choose — with that agent's roles and tenant scopes, exactly as configured in the dashboard. You can change or revoke this anytime.</p>
      <form id="pick">${options}
        <button type="submit" style="width:100%;margin-top:8px;">Continue</button>
        <div id="err" style="color:#ff6b6b;margin-top:8px;font-size:13px;"></div>
      </form>
    </div>
    <script>
      document.getElementById('pick').addEventListener('submit', async (e) => {
        e.preventDefault();
        const sel = document.querySelector('input[name=agent]:checked');
        if (!sel) { document.getElementById('err').textContent = 'Pick an agent first'; return; }
        const r = await fetch('/oauth-consent/bind', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: ${jsString(clientId)}, agentId: sel.value }),
        });
        if (!r.ok) { document.getElementById('err').textContent = 'Failed to save selection'; return; }
        location.href = '/api/auth/mcp/authorize?' + ${jsString(resumeQS)};
      });
    </script>
    </body></html>
  `);
}

dashboardApp.get("/oauth-consent/agents", async (c) => {
  const user = await getSessionUser(c);
  if (!user?.id) return c.json({ error: "unauthorized" }, 401);
  const agents = await connectableAgentsFor(user.id);
  return c.json({ agents });
});

dashboardApp.post("/oauth-consent/bind", async (c) => {
  const user = await getSessionUser(c);
  if (!user?.id) return c.json({ error: "unauthorized" }, 401);
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const clientId = String(body?.clientId ?? "");
  const agentId = String(body?.agentId ?? "");
  if (!clientId || !agentId) return c.json({ error: "clientId and agentId are required" }, 400);

  // The consenting user must be allowed to use the agent (owner, assignee,
  // or admin of its workspace) — never bind to someone else's agent.
  const agent = await prisma.agent.findFirst({ where: { id: agentId, enabled: true } });
  if (!agent || !(await userMayUseAgent(user.id, agent))) {
    return c.json({ error: "agent not found or not usable by you" }, 404);
  }

  await prisma.oauthAgentGrant.upsert({
    where: { userId_clientId: { userId: user.id, clientId } },
    create: { userId: user.id, clientId, agentId },
    update: { agentId },
  });
  return c.json({ ok: true });
});

// ---------- Workspaces: members, invites, agent distribution ----------
// docs/workspace-design.md. Tenant = data wall; Workspace = management wall.

const BASE_URL = () => process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

async function requireWsAdmin(c: any, workspaceId: string) {
  const user = await getSessionUser(c);
  if (!user?.id) return null;
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: user.id, role: { in: ["owner", "admin"] } },
  });
  return member ? { user, member } : null;
}

dashboardApp.get("/workspaces", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");
  const flash = c.req.query("ok") ?? "";

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  const sections: string[] = [];
  for (const m of memberships) {
    const ws = m.workspace;
    const isAdmin = m.role === "owner" || m.role === "admin";
    if (!isAdmin) {
      sections.push(`<div class="card"><b>${escapeHtml(ws.displayName)}</b> <span class="badge unscoped">${escapeHtml(m.role)}</span>
        <div style="color:#8a8d93;font-size:13px;margin-top:6px;">Connector URL: <code>${escapeHtml(BASE_URL())}/mcp/w/${escapeHtml(ws.slug)}</code></div></div>`);
      continue;
    }

    const [members, agents, assignments, invites] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId: ws.id },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.agent.findMany({
        where: { workspaceId: ws.id, enabled: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.agentAssignment.findMany({
        where: { agent: { workspaceId: ws.id } },
        include: { agent: { select: { id: true, name: true } }, user: { select: { id: true, email: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.workspaceInvite.findMany({
        where: { workspaceId: ws.id, acceptedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    sections.push(`
    <div class="card">
      <h2 style="margin-top:0;">${escapeHtml(ws.displayName)} <span class="badge ok">${escapeHtml(m.role)}</span></h2>
      <div style="color:#8a8d93;font-size:13px;">Workspace-locked connector URL (parallel connectors per client):<br>
        <code>${escapeHtml(BASE_URL())}/mcp/w/${escapeHtml(ws.slug)}</code></div>

      <h3>Members</h3>
      <table>
        <thead><tr><th>Member</th><th>Role</th><th>Assigned agents</th><th></th></tr></thead>
        <tbody>
        ${members.map((mm) => {
          const mine = assignments.filter((a) => a.user.id === mm.user.id);
          return `<tr>
            <td>${escapeHtml(mm.user.email)}${mm.user.name ? ` <small style="color:#8a8d93;">${escapeHtml(mm.user.name)}</small>` : ""}</td>
            <td><span class="badge ${mm.role === "member" ? "unscoped" : "ok"}">${escapeHtml(mm.role)}</span></td>
            <td>${mine.length ? mine.map((a) => `
              <form method="post" action="/workspaces/${ws.id}/unassign" style="display:inline-block;margin:0 6px 4px 0;">
                <input type="hidden" name="agentId" value="${escapeHtml(a.agent.id)}"><input type="hidden" name="userId" value="${escapeHtml(mm.user.id)}">
                <span class="badge scoped">${escapeHtml(a.agent.name)} <button type="submit" title="Unassign" style="all:unset;cursor:pointer;color:#ff6b6b;">&times;</button></span>
              </form>`).join("") : '<span style="color:#8a8d93;">—</span>'}
            </td>
            <td>${mm.role !== "owner" ? `
              <form method="post" action="/workspaces/${ws.id}/members/${mm.user.id}/remove" style="margin:0;" onsubmit="return confirm('Remove ${escapeHtml(mm.user.email)} from workspace? Their connector access is revoked immediately.')">
                <button type="submit" class="secondary" style="font-size:12px;padding:4px 8px;">Remove</button>
              </form>` : ""}
            </td>
          </tr>`;
        }).join("")}
        </tbody>
      </table>

      <h3>Assign an agent</h3>
      <form method="post" action="/workspaces/${ws.id}/assign" class="row" style="gap:8px;align-items:center;">
        <select name="userId" required>${members.map((mm) => `<option value="${escapeHtml(mm.user.id)}">${escapeHtml(mm.user.email)}</option>`).join("")}</select>
        <select name="agentId" required>${agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join("")}</select>
        <button type="submit">Assign</button>
      </form>

      <h3>Invite</h3>
      <form method="post" action="/workspaces/${ws.id}/invite">
        <div class="row" style="gap:8px;align-items:center;">
          <input type="email" name="email" placeholder="teammate@example.com" required style="flex:1;">
          <select name="role"><option value="member">member</option><option value="admin">admin</option></select>
          <button type="submit">Send invite</button>
        </div>
        <div style="margin-top:8px;color:#8a8d93;font-size:13px;">Auto-assign agents on accept:</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;">
          ${agents.map((a) => `<label style="font-size:13px;"><input type="checkbox" name="agentIds" value="${escapeHtml(a.id)}"> ${escapeHtml(a.name)}</label>`).join("") || '<span style="color:#8a8d93;font-size:13px;">No agents in this workspace yet.</span>'}
        </div>
      </form>

      ${invites.length ? `<h3>Pending invites</h3>
      <table><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Link</th><th></th></tr></thead><tbody>
      ${invites.map((inv) => `<tr>
        <td>${escapeHtml(inv.email)}</td><td>${escapeHtml(inv.role)}</td>
        <td><code>${inv.expiresAt.toISOString().slice(0, 10)}</code></td>
        <td><code style="font-size:11px;">${escapeHtml(BASE_URL())}/invite/${escapeHtml(inv.token)}</code></td>
        <td><form method="post" action="/workspaces/${ws.id}/invites/${inv.id}/revoke" style="margin:0;"><button type="submit" class="secondary" style="font-size:12px;padding:4px 8px;">Revoke</button></form></td>
      </tr>`).join("")}
      </tbody></table>` : ""}
    </div>`);
  }

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Workspace — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("workspaces", user?.email)}
    <main>
      <h1>Workspace</h1>
      ${flash ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">${escapeHtml(flash)}</div>` : ""}
      ${sections.join("\n") || '<div class="card"><div class="empty">No workspace yet — one is created automatically on next deploy/boot.</div></div>'}
    </main></body></html>
  `);
});

dashboardApp.post("/workspaces/:id/invite", async (c) => {
  const wsId = c.req.param("id");
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.redirect("/login");
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const role = String(form.get("role") ?? "member") === "admin" ? "admin" : "member";
  const agentIds = form.getAll("agentIds").map(String).filter(Boolean);
  if (!email) return c.redirect("/workspaces");

  // Only agents that actually live in this workspace may be pre-assigned.
  const valid = await prisma.agent.findMany({ where: { id: { in: agentIds }, workspaceId: wsId }, select: { id: true } });
  const ws = await prisma.workspace.findUnique({ where: { id: wsId } });
  const token = nodeCrypto.randomBytes(24).toString("hex");
  await prisma.workspaceInvite.create({
    data: {
      workspaceId: wsId,
      email,
      role,
      token,
      invitedById: admin.user.id,
      agentIds: JSON.stringify(valid.map((v) => v.id)),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  const link = `${BASE_URL()}/invite/${token}`;
  try {
    await sendSystemEmail({
      to: email,
      subject: `You're invited to the ${ws?.displayName ?? "grantry"} workspace on grantry`,
      text: `${admin.user.email} invited you to the "${ws?.displayName}" workspace on grantry.\n\nAccept the invite (valid for 7 days):\n${link}\n\nAfter joining, connect Claude to grantry with the workspace connector URL shown on your Workspace page.`,
      html: `<p><b>${escapeHtml(admin.user.email)}</b> invited you to the <b>${escapeHtml(ws?.displayName ?? "")}</b> workspace on grantry.</p>
<p><a href="${link}">Accept the invite</a> (valid for 7 days)</p>
<p style="color:#888;font-size:13px;">After joining, connect Claude to grantry with the workspace connector URL shown on your Workspace page.</p>`,
    });
  } catch (err) {
    console.error("[workspace] invite email failed:", err);
  }
  return c.redirect(`/workspaces?ok=${encodeURIComponent(`Invite sent to ${email}`)}`);
});

dashboardApp.post("/workspaces/:id/invites/:inviteId/revoke", async (c) => {
  const wsId = c.req.param("id");
  if (!(await requireWsAdmin(c, wsId))) return c.redirect("/login");
  await prisma.workspaceInvite.deleteMany({ where: { id: c.req.param("inviteId"), workspaceId: wsId } });
  return c.redirect("/workspaces?ok=Invite%20revoked");
});

dashboardApp.post("/workspaces/:id/assign", async (c) => {
  const wsId = c.req.param("id");
  if (!(await requireWsAdmin(c, wsId))) return c.redirect("/login");
  const form = await c.req.formData();
  const agentId = String(form.get("agentId") ?? "");
  const userId = String(form.get("userId") ?? "");
  const [agent, member] = await Promise.all([
    prisma.agent.findFirst({ where: { id: agentId, workspaceId: wsId } }),
    prisma.workspaceMember.findFirst({ where: { workspaceId: wsId, userId } }),
  ]);
  if (agent && member) {
    await prisma.agentAssignment.upsert({
      where: { agentId_userId: { agentId, userId } },
      create: { agentId, userId },
      update: {},
    });
  }
  return c.redirect("/workspaces?ok=Agent%20assigned");
});

dashboardApp.post("/workspaces/:id/unassign", async (c) => {
  const wsId = c.req.param("id");
  if (!(await requireWsAdmin(c, wsId))) return c.redirect("/login");
  const form = await c.req.formData();
  const agentId = String(form.get("agentId") ?? "");
  const userId = String(form.get("userId") ?? "");
  await prisma.agentAssignment.deleteMany({ where: { agentId, userId, agent: { workspaceId: wsId } } });
  return c.redirect("/workspaces?ok=Agent%20unassigned");
});

dashboardApp.post("/workspaces/:id/members/:userId/remove", async (c) => {
  const wsId = c.req.param("id");
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.redirect("/login");
  const targetId = c.req.param("userId");
  const target = await prisma.workspaceMember.findFirst({ where: { workspaceId: wsId, userId: targetId } });
  if (!target || target.role === "owner") return c.redirect("/workspaces"); // never remove the owner
  await prisma.$transaction([
    // Revoke immediately: drop assignments to this workspace's agents and the
    // member row. resolveOAuthAgent re-checks userMayUseAgent per request, so
    // existing connector tokens stop resolving the moment these rows are gone.
    prisma.agentAssignment.deleteMany({ where: { userId: targetId, agent: { workspaceId: wsId } } }),
    prisma.workspaceMember.deleteMany({ where: { workspaceId: wsId, userId: targetId } }),
  ]);
  return c.redirect("/workspaces?ok=Member%20removed");
});

dashboardApp.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const invite = await prisma.workspaceInvite.findUnique({
    where: { token },
    include: { workspace: true },
  });
  const page = (inner: string) => c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Workspace invite — grantry</title>
    <style>${CSS} body { max-width: 440px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Workspace invite</h1><div class="card">${inner}</div></body></html>`);

  if (!invite || invite.acceptedAt) return page("<p>This invite link is invalid or already used.</p>");
  if (invite.expiresAt < new Date()) return page("<p>This invite has expired. Ask your admin to send a new one.</p>");

  const user = await getSessionUser(c);
  if (!user) {
    const next = encodeURIComponent(`/invite/${token}`);
    return page(`
      <p>You've been invited to the <b>${escapeHtml(invite.workspace.displayName)}</b> workspace (as ${escapeHtml(invite.role)}).</p>
      <p>Sign in or create a grantry account with <b>${escapeHtml(invite.email)}</b> to accept.</p>
      <div class="row" style="gap:10px;">
        <a href="/login?next=${next}"><button type="button" style="width:100%;">Sign in</button></a>
        <a href="/register?next=${next}"><button type="button" class="secondary" style="width:100%;">Create account</button></a>
      </div>`);
  }

  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return page(`<p>This invite was issued to <b>${escapeHtml(invite.email)}</b>, but you are signed in as <b>${escapeHtml(user.email)}</b>.</p>
      <p>Sign out and use the invited address.</p>`);
  }

  const agentIds = safeJsonArray(invite.agentIds);
  await prisma.$transaction([
    prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
      create: { workspaceId: invite.workspaceId, userId: user.id, role: invite.role },
      update: {},
    }),
    ...agentIds.map((agentId) =>
      prisma.agentAssignment.upsert({
        where: { agentId_userId: { agentId, userId: user.id } },
        create: { agentId, userId: user.id },
        update: {},
      }),
    ),
    prisma.workspaceInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
  ]);
  return c.redirect(`/workspaces?ok=${encodeURIComponent(`Joined ${invite.workspace.displayName}`)}`);
});

async function signOutAndRedirect(c: any) {
  const url = new URL(c.req.url);
  url.pathname = "/api/auth/sign-out";
  url.search = "";
  let signOutResponse: Response | null = null;
  try {
    signOutResponse = await auth.handler(new Request(url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: "{}",
    }));
  } catch (err) {
    console.error("[logout] better-auth sign-out failed:", err);
  }
  const response = c.redirect("/login", 303);
  if (signOutResponse) {
    const getSetCookie = (signOutResponse.headers as any).getSetCookie;
    const cookies = typeof getSetCookie === "function"
      ? getSetCookie.call(signOutResponse.headers)
      : [signOutResponse.headers.get("set-cookie")].filter(Boolean);
    for (const cookie of cookies) {
      response.headers.append("set-cookie", cookie);
    }
  }
  const expires = "Max-Age=0; Path=/; HttpOnly; SameSite=Lax";
  for (const cookie of [
    `better-auth.session_token=; ${expires}`,
    `better-auth.session_data=; ${expires}`,
    `better-auth.dont_remember=; ${expires}`,
    `__Secure-better-auth.session_token=; ${expires}; Secure`,
    `__Secure-better-auth.session_data=; ${expires}; Secure`,
    `__Secure-better-auth.dont_remember=; ${expires}; Secure`,
  ]) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

function publicOrigin(c: any): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const forwardedHost = c.req.header("x-forwarded-host");
  const host = forwardedHost || c.req.header("host");
  const forwardedProto = c.req.header("x-forwarded-proto");
  const proto = forwardedProto || (host && /\.up\.railway\.app$/i.test(host) ? "https" : new URL(c.req.url).protocol.replace(":", ""));
  if (host) return `${proto}://${host}`;
  return new URL(c.req.url).origin;
}

const OAUTH_LEGACY_CLIENT_ID_ALIASES: Record<string, string[]> = {
  github: ["GH_CLIENT_ID", "GRANTRY_GITHUB_CLIENT_ID"],
  google_gsc: ["GOOGLE_CLIENT_ID"],
  google_analytics: ["GOOGLE_CLIENT_ID"],
  google_ads: ["GOOGLE_CLIENT_ID"],
  google_drive: ["GOOGLE_CLIENT_ID"],
  gmail: ["GOOGLE_CLIENT_ID"],
  google_calendar: ["GOOGLE_CLIENT_ID"],
  google_sheets: ["GOOGLE_CLIENT_ID"],
  google_tag_manager: ["GOOGLE_CLIENT_ID"],
  google_cloud: ["GOOGLE_CLIENT_ID"],
  bigquery: ["GOOGLE_CLIENT_ID"],
  yahoo_ads: ["YAHOO_CLIENT_ID"],
};

const OAUTH_LEGACY_CLIENT_SECRET_ALIASES: Record<string, string[]> = {
  github: ["GH_CLIENT_SECRET", "GRANTRY_GITHUB_CLIENT_SECRET"],
  google_gsc: ["GOOGLE_CLIENT_SECRET"],
  google_analytics: ["GOOGLE_CLIENT_SECRET"],
  google_ads: ["GOOGLE_CLIENT_SECRET"],
  google_drive: ["GOOGLE_CLIENT_SECRET"],
  gmail: ["GOOGLE_CLIENT_SECRET"],
  google_calendar: ["GOOGLE_CLIENT_SECRET"],
  google_sheets: ["GOOGLE_CLIENT_SECRET"],
  google_tag_manager: ["GOOGLE_CLIENT_SECRET"],
  google_cloud: ["GOOGLE_CLIENT_SECRET"],
  bigquery: ["GOOGLE_CLIENT_SECRET"],
  yahoo_ads: ["YAHOO_CLIENT_SECRET"],
};

function oauthEnvCandidates(providerKey: string, kind: "CLIENT_ID" | "CLIENT_SECRET"): string[] {
  const primary = `${providerKey.toUpperCase()}_${kind}`;
  const aliases = kind === "CLIENT_ID"
    ? OAUTH_LEGACY_CLIENT_ID_ALIASES[providerKey] || []
    : OAUTH_LEGACY_CLIENT_SECRET_ALIASES[providerKey] || [];
  return [primary, ...aliases];
}

function envStatus(names: string[]): { present: boolean; variable: string; candidates: string[] } {
  const variable = names.find((name) => !!process.env[name]) || names[0] || "";
  return { present: names.some((name) => !!process.env[name]), variable, candidates: names };
}

// --- /dashboard ---
dashboardApp.get("/", (c) => c.redirect("/dashboard"));

dashboardApp.get("/dashboard", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const [connectionCount, agentCount, roleCount, recentAudits] = await Promise.all([
    prisma.connection.count({ where: { ownerId: user.id } }),
    prisma.agent.count({ where: { ownerId: user.id } }),
    prisma.role.count({ where: { ownerId: user.id } }),
    prisma.auditLog.findMany({
      where: { OR: [{ userId: user.id }, { agent: { ownerId: user.id } }] },
      take: 10,
      orderBy: { createdAt: "desc" },
      include: { agent: true },
    }),
  ]);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("dashboard", user?.email)}
    <main>
      <h1>Dashboard</h1>
      <div class="row" style="gap:16px; margin-bottom:24px;">
        <div class="card" style="flex:1;"><div style="color:#8a8d93;font-size:12px;">Connections</div><div style="font-size:24px;font-weight:700;">${connectionCount}</div></div>
        <div class="card" style="flex:1;"><div style="color:#8a8d93;font-size:12px;">Agents</div><div style="font-size:24px;font-weight:700;">${agentCount}</div></div>
        <div class="card" style="flex:1;"><div style="color:#8a8d93;font-size:12px;">Roles</div><div style="font-size:24px;font-weight:700;">${roleCount}</div></div>
      </div>
      <h2>Recent activity</h2>
      <div class="card">
        ${recentAudits.length === 0 ? '<div class="empty">No activity yet. Create your first tenant → <a href="/tenants/new">+ New tenant</a></div>' : `
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

// --- /meta — system-wide admin overview ---
dashboardApp.get("/meta", async (c) => {
  const dbUser = await getDbSessionUser(c);
  if (!dbUser) return c.redirect("/login");

  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  const bootstrapMode = adminCount === 0;
  if (dbUser.role !== "admin" && !bootstrapMode) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Meta — grantry</title>
      <style>${CSS}</style></head><body>
      ${NAV("meta", dbUser?.email)}
      <main>
        <h1>Meta</h1>
        <div class="card"><h2>Forbidden</h2><p>This screen is restricted to <code>admin</code> users.</p></div>
      </main></body></html>
    `, 403);
  }

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const pruned = c.req.query("pruned");

  const [
    userCount,
    adminUserCount,
    connectionCount,
    enabledConnectionCount,
    agentCount,
    enabledAgentCount,
    roleCount,
    audit24hCount,
    audit24hErrors,
    audit24hDenied,
    oauthStateCount,
    expiredOAuthStateCount,
    connectionGroups,
    tenantGroups,
    recentErrors,
    users,
    connectionIssues,
    expiredOAuthConnections,
    agentsWithoutRoles,
    roles,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "admin" } }),
    prisma.connection.count(),
    prisma.connection.count({ where: { enabled: true } }),
    prisma.agent.count(),
    prisma.agent.count({ where: { enabled: true } }),
    prisma.role.count(),
    prisma.auditLog.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.auditLog.count({ where: { createdAt: { gte: dayAgo }, status: "error" } }),
    prisma.auditLog.count({ where: { createdAt: { gte: dayAgo }, status: "denied" } }),
    prisma.oAuthState.count(),
    prisma.oAuthState.count({ where: { expiresAt: { lt: now } } }),
    prisma.connection.groupBy({ by: ["provider", "authType", "enabled"], _count: { _all: true } }),
    prisma.connection.groupBy({ by: ["scope"], _count: { _all: true }, orderBy: { _count: { scope: "desc" } }, take: 40 }),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: weekAgo }, status: { in: ["error", "denied"] } },
      take: 25,
      orderBy: { createdAt: "desc" },
      include: { user: true, agent: true },
    }),
    prisma.user.findMany({
      take: 50,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { connections: true, agents: true, roles: true, auditLogs: true } } },
    }),
    prisma.connection.findMany({
      where: {
        OR: [
          { enabled: false },
          { credentialMetadata: { contains: '"status":"error"' } },
        ],
      },
      take: 50,
      orderBy: { updatedAt: "desc" },
      include: { owner: true },
    }),
    prisma.connection.findMany({
      where: { enabled: true, accessTokenExpiresAt: { lt: now } },
      take: 50,
      orderBy: { accessTokenExpiresAt: "asc" },
      include: { owner: true },
    }),
    prisma.agent.findMany({
      where: { roles: { none: {} } },
      take: 50,
      orderBy: { createdAt: "desc" },
      include: { owner: true },
    }),
    prisma.role.findMany({
      take: 200,
      orderBy: { updatedAt: "desc" },
      include: { owner: true, agents: true },
    }),
  ]);

  const providerDefs = Object.values(PROVIDERS);
  const oauthProviders = providerDefs.filter((p) => p.authTypes.includes("oauth"));
  const totalToolCount = new Set(providerDefs.flatMap((p) => p.tools)).size;
  const broadRoles = roles.filter((r) => safeJsonArray(r.allowedScopes).length === 0);
  const unusedRoles = roles.filter((r) => r.agents.length === 0);
  const envRows = oauthProviders.map((p) => {
    const id = envStatus(oauthEnvCandidates(p.key, "CLIENT_ID"));
    const secret = envStatus(oauthEnvCandidates(p.key, "CLIENT_SECRET"));
    return { provider: p, id, secret, ok: id.present && secret.present };
  });
  const googleAdsDeveloperTokenPresent = !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cryptoSecretPresent = !!(process.env.FERNET_KEY || process.env.BETTER_AUTH_SECRET);
  const publicUrlPresent = !!(process.env.PUBLIC_BASE_URL || process.env.BETTER_AUTH_URL);

  const card = (label: string, value: string | number, hint = "") => `
    <div class="card" style="flex:1;min-width:160px;">
      <div style="color:#8a8d93;font-size:12px;">${escapeHtml(label)}</div>
      <div style="font-size:24px;font-weight:700;">${value}</div>
      ${hint ? `<div style="color:#8a8d93;font-size:12px;margin-top:4px;">${hint}</div>` : ""}
    </div>
  `;
  const okBadge = (ok: boolean, label?: string) => ok
    ? `<span class="badge ok">${escapeHtml(label || "ok")}</span>`
    : `<span class="badge denied">${escapeHtml(label || "missing")}</span>`;

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Meta — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("meta", dbUser?.email)}
    <main>
      <h1>Meta</h1>
      <p style="color:#8a8d93;margin-top:-12px;">System-wide operational view. No raw credentials are shown.</p>

      ${bootstrapMode ? `
      <div class="card" style="border-color:#f0b429;background:rgba(240,180,41,0.08);">
        <h2>Admin bootstrap required</h2>
        <p>No admin user exists yet. You are viewing this screen because the system has zero admins.</p>
        <form method="post" action="/meta/promote-self" onsubmit="return confirm('Promote your account to admin?')">
          <button type="submit">Promote me to admin</button>
        </form>
      </div>` : ""}

      ${pruned ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">Pruned <b>${escapeHtml(pruned)}</b> expired OAuth state row(s).</div>` : ""}

      <div class="row" style="gap:16px;flex-wrap:wrap;margin-bottom:24px;">
        ${card("Users", userCount, `${adminUserCount} admin`)}
        ${card("Connections", connectionCount, `${enabledConnectionCount} enabled`)}
        ${card("Agents", agentCount, `${enabledAgentCount} enabled`)}
        ${card("Roles", roleCount, `${broadRoles.length} broad scope`)}
        ${card("Audit 24h", audit24hCount, `${audit24hErrors} error / ${audit24hDenied} denied`)}
        ${card("OAuth states", oauthStateCount, `${expiredOAuthStateCount} expired`)}
      </div>

      <h2>System Health</h2>
      <div class="card">
        <table>
          <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            <tr><td>Credential encryption secret</td><td>${okBadge(cryptoSecretPresent)}</td><td><code>FERNET_KEY</code> or <code>BETTER_AUTH_SECRET</code></td></tr>
            <tr><td>Public base URL</td><td>${okBadge(publicUrlPresent)}</td><td><code>PUBLIC_BASE_URL</code> or <code>BETTER_AUTH_URL</code></td></tr>
            <tr><td>Google Ads developer token</td><td>${okBadge(googleAdsDeveloperTokenPresent, googleAdsDeveloperTokenPresent ? "set" : "missing")}</td><td>Required for <code>google_ads/*</code> calls.</td></tr>
            <tr><td>Expired OAuth states</td><td>${expiredOAuthStateCount ? okBadge(false, `${expiredOAuthStateCount} expired`) : okBadge(true)}</td><td>
              <form method="post" action="/meta/oauth-states/prune" style="display:inline;">
                <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" ${expiredOAuthStateCount ? "" : "disabled"}>Prune expired</button>
              </form>
            </td></tr>
            <tr><td>Agents without roles</td><td>${agentsWithoutRoles.length ? okBadge(false, String(agentsWithoutRoles.length)) : okBadge(true)}</td><td>Unbound agents cannot access tenant connections.</td></tr>
            <tr><td>Broad roles</td><td>${broadRoles.length ? okBadge(false, String(broadRoles.length)) : okBadge(true)}</td><td>Roles with empty <code>allowedScopes</code> can access any owner scope.</td></tr>
          </tbody>
        </table>
      </div>

      <h2>OAuth Environment</h2>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Client ID</th><th>Client Secret</th><th>Callback</th></tr></thead>
            <tbody>
              ${envRows.map(({ provider: p, id, secret, ok }) => `
                <tr>
                  <td><code>${escapeHtml(p.key)}</code> ${ok ? '<span class="badge ok">ready</span>' : '<span class="badge denied">incomplete</span>'}</td>
                  <td>${okBadge(id.present, id.present ? "set" : "missing")} <code>${escapeHtml(id.variable)}</code></td>
                  <td>${okBadge(secret.present, secret.present ? "set" : "missing")} <code>${escapeHtml(secret.variable)}</code></td>
                  <td><code>${escapeHtml(publicOrigin(c))}/oauth/${escapeHtml(p.key)}/callback</code></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Provider Catalog</h2>
      <div class="card">
        <p class="field-hint" style="margin-top:0;">${providerDefs.length} providers, ${totalToolCount} unique tools.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Auth</th><th>Server credential</th><th>Tools</th><th>Status</th></tr></thead>
            <tbody>
              ${providerDefs.map((p) => `
                <tr>
                  <td><span class="provider-cell">${providerIcon(p.key)}<code>${escapeHtml(p.key)}</code></span><br><span style="color:#8a8d93;font-size:12px;">${escapeHtml(p.label)}</span></td>
                  <td>${p.authTypes.map((a) => `<span class="tool-pill">${escapeHtml(authTypeLabel(p.key, a))}</span>`).join(" ")}</td>
                  <td>${p.serverCredentialEnv
                    ? `${okBadge(!!process.env[p.serverCredentialEnv], process.env[p.serverCredentialEnv] ? "set" : "missing")} <code>${escapeHtml(p.serverCredentialEnv)}</code>`
                    : '<span style="color:#8a8d93;">none</span>'}</td>
                  <td>${p.tools.map((t) => `<span class="tool-pill">${escapeHtml(t)}</span>`).join(" ")}</td>
                  <td>${p.implemented === false ? '<span class="badge unscoped">coming soon</span>' : '<span class="badge ok">implemented</span>'}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Connections</h2>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Auth</th><th>Status</th><th>Count</th></tr></thead>
            <tbody>
              ${connectionGroups.map((g) => `
                <tr>
                  <td><code>${escapeHtml(g.provider)}</code></td>
                  <td><code>${escapeHtml(g.authType)}</code></td>
                  <td>${g.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</td>
                  <td>${g._count._all}</td>
                </tr>
              `).join("") || '<tr><td colspan="4">No connections.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Tenant Scopes</h2>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Scope</th><th>Connections</th></tr></thead>
            <tbody>
              ${tenantGroups.map((g) => `
                <tr>
                  <td>${g.scope ? `<code>${escapeHtml(g.scope)}</code>` : '<span class="badge unscoped">unscoped</span>'}</td>
                  <td>${g._count._all}</td>
                </tr>
              `).join("") || '<tr><td colspan="2">No tenant scopes.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Attention Needed</h2>
      <div class="card">
        <h3 style="margin-top:0;">Connection issues</h3>
        ${connectionIssues.length === 0 && expiredOAuthConnections.length === 0 ? '<div class="empty">No disabled, failed-check, or expired OAuth connections found.</div>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Owner</th><th>Scope</th><th>Provider</th><th>Auth</th><th>Status</th><th>Credential</th></tr></thead>
            <tbody>
              ${[...connectionIssues, ...expiredOAuthConnections].map((cn) => `
                <tr>
                  <td>${escapeHtml(cn.owner.email)}</td>
                  <td><code>${escapeHtml(cn.scope || "-")}</code></td>
                  <td><code>${escapeHtml(cn.provider)}</code></td>
                  <td><code>${escapeHtml(cn.authType)}</code></td>
                  <td>${cn.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'} ${oauthTokenStatus(cn)}</td>
                  <td>${renderCredentialSummary(cn)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>`}

        <h3>Agents without roles</h3>
        ${agentsWithoutRoles.length === 0 ? '<div class="empty">None.</div>' : `
        <table>
          <thead><tr><th>Owner</th><th>Agent</th><th>Created</th></tr></thead>
          <tbody>
            ${agentsWithoutRoles.map((a) => `
              <tr><td>${escapeHtml(a.owner.email)}</td><td><code>${escapeHtml(a.name)}</code></td><td><code>${a.createdAt.toISOString().slice(0, 10)}</code></td></tr>
            `).join("")}
          </tbody>
        </table>`}

        <h3>Broad or unused roles</h3>
        ${broadRoles.length === 0 && unusedRoles.length === 0 ? '<div class="empty">None.</div>' : `
        <table>
          <thead><tr><th>Owner</th><th>Role</th><th>Issue</th><th>Tools</th></tr></thead>
          <tbody>
            ${Array.from(new Map([...broadRoles, ...unusedRoles].map((r) => [r.id, r])).values()).map((r) => {
              const issues = [
                safeJsonArray(r.allowedScopes).length === 0 ? "any-scope" : "",
                r.agents.length === 0 ? "unused" : "",
              ].filter(Boolean);
              return `
                <tr>
                  <td>${escapeHtml(r.owner.email)}</td>
                  <td><code>${escapeHtml(r.name)}</code></td>
                  <td>${issues.map((i) => `<span class="badge denied">${escapeHtml(i)}</span>`).join(" ")}</td>
                  <td>${safeJsonArray(r.allowedTools).slice(0, 8).map((t) => `<span class="tool-pill">${escapeHtml(t)}</span>`).join(" ")}${safeJsonArray(r.allowedTools).length > 8 ? ` <span style="color:#8a8d93;">+${safeJsonArray(r.allowedTools).length - 8}</span>` : ""}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>`}
      </div>

      <h2>Recent Errors</h2>
      <div class="card">
        ${recentErrors.length === 0 ? '<div class="empty">No errors or denied calls in the last 7 days.</div>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>When</th><th>User</th><th>Agent</th><th>Tool</th><th>Scope</th><th>Status</th><th>Error</th></tr></thead>
            <tbody>
              ${recentErrors.map((l) => `
                <tr>
                  <td><code>${l.createdAt.toISOString().slice(0, 19).replace("T", " ")}</code></td>
                  <td>${l.user ? escapeHtml(l.user.email) : "<system>"}</td>
                  <td>${l.agent ? `<code>${escapeHtml(l.agent.name)}</code>` : "—"}</td>
                  <td><code>${escapeHtml(l.tool)}</code></td>
                  <td><code>${escapeHtml(l.scope || "-")}</code></td>
                  <td><span class="badge denied">${escapeHtml(l.status)}</span></td>
                  <td style="max-width:360px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(l.errorMessage || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>`}
      </div>

      <h2>Users</h2>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Connections</th><th>Agents</th><th>Roles</th><th>Audit</th><th>Created</th></tr></thead>
            <tbody>
              ${users.map((u) => `
                <tr>
                  <td>${escapeHtml(u.email)}<br><span style="color:#8a8d93;font-size:12px;">${escapeHtml(u.name || "")}</span></td>
                  <td>${u.role === "admin" ? '<span class="badge ok">admin</span>' : '<span class="badge unscoped">user</span>'}</td>
                  <td>${u._count.connections}</td>
                  <td>${u._count.agents}</td>
                  <td>${u._count.roles}</td>
                  <td>${u._count.auditLogs}</td>
                  <td><code>${u.createdAt.toISOString().slice(0, 10)}</code></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </main></body></html>
  `);
});

dashboardApp.post("/meta/promote-self", async (c) => {
  const dbUser = await getDbSessionUser(c);
  if (!dbUser) return c.redirect("/login");
  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  if (adminCount > 0 && dbUser.role !== "admin") return c.html("<h1>admin already exists</h1>", 403);
  await prisma.user.update({ where: { id: dbUser.id }, data: { role: "admin" } });
  return c.redirect("/meta");
});

dashboardApp.post("/meta/oauth-states/prune", async (c) => {
  const dbUser = await getDbSessionUser(c);
  if (!dbUser) return c.redirect("/login");
  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  if (dbUser.role !== "admin" && adminCount > 0) return c.html("<h1>admin required</h1>", 403);
  const result = await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return c.redirect(`/meta?pruned=${result.count}`);
});

// --- /login ---
// When the better-auth mcp plugin redirects an OAuth authorize request to
// /login, the original authorize query (client_id, redirect_uri, ...) rides
// along. After sign-in/sign-up the browser must go BACK to the authorize
// endpoint to resume that flow — sending it to /dashboard strands the remote
// MCP client (claude.ai / Claude Desktop) waiting for a callback forever.
function postAuthDestination(c: any): { dest: string; oauthQuery: string } {
  const qs = new URL(c.req.url).searchParams;
  if (qs.has("client_id") && qs.has("redirect_uri") && qs.has("response_type")) {
    return { dest: `/api/auth/mcp/authorize?${qs.toString()}`, oauthQuery: qs.toString() };
  }
  // Generic post-auth continuation (e.g. workspace invite links). Same-origin
  // relative paths only — never absolute URLs.
  const next = qs.get("next") ?? "";
  if (next.startsWith("/") && !next.startsWith("//")) {
    return { dest: next, oauthQuery: qs.toString() };
  }
  return { dest: "/dashboard", oauthQuery: "" };
}

dashboardApp.get("/login", async (c) => {
  const { dest, oauthQuery } = postAuthDestination(c);
  const user = await getSessionUser(c);
  if (user) return c.redirect(dest);
  const resetDone = c.req.query("reset") === "1";
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Sign in — grantry</title>
    <style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Sign in to grantry</h1>
    ${resetDone ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">✓ Password updated. Sign in with your new password.</div>` : ""}
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
    <p style="text-align:center;color:#8a8d93;font-size:13px;">No account? <a href="/register${oauthQuery ? escapeHtml(`?${oauthQuery}`) : ""}">Create one</a> · <a href="/forgot-password">Forgot password?</a></p>
    <script>
      document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const r = await fetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') })
        });
        if (r.ok) { location.href = ${jsString(dest)}; }
        else { document.getElementById('err').textContent = 'Invalid email or password'; }
      });
    </script>
    </body></html>
  `);
});

// --- /logout ---
dashboardApp.post("/logout", async (c) => signOutAndRedirect(c));

// --- /register ---
dashboardApp.get("/register", async (c) => {
  const { dest, oauthQuery } = postAuthDestination(c);
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Create account — grantry</title>
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
    <p style="text-align:center;color:#8a8d93;font-size:13px;">Already have one? <a href="/login${oauthQuery ? escapeHtml(`?${oauthQuery}`) : ""}">Sign in</a></p>
    <script>
      document.getElementById('regForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const r = await fetch('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password') })
        });
        if (r.ok) { location.href = ${jsString(dest)}; }
        else { const j = await r.json().catch(()=>({})); document.getElementById('err').textContent = j.message || 'Sign up failed'; }
      });
    </script>
    </body></html>
  `);
});

// --- /forgot-password — request a reset link by email ---
dashboardApp.get("/forgot-password", async (c) => {
  const sent = c.req.query("sent") === "1";
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Forgot password — grantry</title>
    <style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Forgot password</h1>
    ${sent ? `
    <div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">
      ✓ If an account exists for that address, a reset link is on its way. The link is valid for 1 hour.
    </div>
    <p style="text-align:center;color:#8a8d93;font-size:13px;"><a href="/login">← Back to sign in</a></p>
    ` : `
    <div class="card">
      <form method="post" action="/forgot-password">
        <div class="field">
          <label for="email">Email</label>
          <input type="email" name="email" id="email" required autofocus>
        </div>
        <button type="submit" style="width:100%;">Send reset link</button>
      </form>
    </div>
    <p style="text-align:center;color:#8a8d93;font-size:13px;"><a href="/login">← Back to sign in</a></p>
    `}
    </body></html>
  `);
});

dashboardApp.post("/forgot-password", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim();
  if (email) {
    try {
      await auth.api.requestPasswordReset({
        body: { email, redirectTo: "/reset-password" },
      });
    } catch (err) {
      // Never reveal whether the account exists; log for the operator only.
      console.warn(`[auth] requestPasswordReset for ${email} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return c.redirect("/forgot-password?sent=1");
});

// --- /reset-password — set a new password from an emailed token ---
// better-auth's emailed link points at /api/auth/reset-password/:token,
// which verifies the token and redirects here with ?token=… (or ?error=…).
dashboardApp.get("/reset-password", async (c) => {
  const token = String(c.req.query("token") ?? "");
  const error = String(c.req.query("error") ?? "");
  const err = c.req.query("err");
  if (!token || error) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Reset password — grantry</title>
      <style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
      <h1>Reset password</h1>
      <div class="card" style="border-color:#ff6b6b;background:rgba(255,107,107,0.08);">
        ⚠️ This reset link is invalid or has expired. <a href="/forgot-password">Request a new one</a>.
      </div>
      </body></html>
    `, 400);
  }
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Reset password — grantry</title>
    <style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Choose a new password</h1>
    ${err ? `<div class="card" style="border-color:#ff6b6b;background:rgba(255,107,107,0.08);">⚠️ ${escapeHtml(String(err))}</div>` : ""}
    <div class="card">
      <form method="post" action="/reset-password">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <div class="field">
          <label for="new_password">New password</label>
          <input type="password" name="new_password" id="new_password" required minlength="8" autocomplete="new-password" autofocus>
        </div>
        <div class="field">
          <label for="new_password2">New password (again)</label>
          <input type="password" name="new_password2" id="new_password2" required minlength="8" autocomplete="new-password">
        </div>
        <button type="submit" style="width:100%;">Set new password</button>
      </form>
    </div>
    </body></html>
  `);
});

dashboardApp.post("/reset-password", async (c) => {
  const body = await c.req.parseBody();
  const token = String(body.token ?? "");
  const newPassword = String(body.new_password ?? "");
  const newPassword2 = String(body.new_password2 ?? "");
  if (!token) return c.redirect("/forgot-password");
  if (newPassword.length < 8) return c.redirect(`/reset-password?token=${encodeURIComponent(token)}&err=${encodeURIComponent("Password must be at least 8 characters")}`);
  if (newPassword !== newPassword2) return c.redirect(`/reset-password?token=${encodeURIComponent(token)}&err=${encodeURIComponent("Passwords do not match")}`);

  try {
    await auth.api.resetPassword({ body: { newPassword, token } });
  } catch (e: any) {
    const message = e?.body?.message ?? e?.message ?? "Reset failed";
    return c.redirect(`/reset-password?token=${encodeURIComponent(token)}&err=${encodeURIComponent(message)}`);
  }
  return c.redirect("/login?reset=1");
});

// --- /account — profile + change password ---
dashboardApp.get("/account", async (c) => {
  const user = await getDbSessionUser(c);
  if (!user) return c.redirect("/login");

  const [tenantCount, connectionCount, agentCount, roleCount, sessionCount] = await Promise.all([
    prisma.tenant.count({ where: { ownerId: user.id } }),
    prisma.connection.count({ where: { ownerId: user.id } }),
    prisma.agent.count({ where: { ownerId: user.id } }),
    prisma.role.count({ where: { ownerId: user.id } }),
    prisma.session.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
  ]);

  const ok = c.req.query("ok");
  const err = c.req.query("err");
  const banner = ok
    ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);margin-bottom:20px;">✓ Password updated. Other sessions have been signed out.</div>`
    : err
      ? `<div class="card" style="border-color:#ff6b6b;background:rgba(255,107,107,0.08);margin-bottom:20px;">⚠️ ${escapeHtml(err)}</div>`
      : "";

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Account — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("account", user?.email)}
    <main>
      <h1>Account</h1>
      ${banner}
      <div class="card">
        <h2>Signed in as</h2>
        <p style="font-size:18px;margin:4px 0 12px;"><code>${escapeHtml(user.email)}</code></p>
        <table>
          <tbody>
            <tr><td style="color:#8a8d93;">Name</td><td>${escapeHtml(user.name || "—")}</td></tr>
            <tr><td style="color:#8a8d93;">User ID</td><td><code>${escapeHtml(user.id)}</code></td></tr>
            <tr><td style="color:#8a8d93;">Role</td><td><code>${escapeHtml(user.role)}</code></td></tr>
            <tr><td style="color:#8a8d93;">Registered</td><td><code>${user.createdAt.toISOString().slice(0, 10)}</code></td></tr>
            <tr><td style="color:#8a8d93;">Active sessions</td><td>${sessionCount}</td></tr>
          </tbody>
        </table>
        <p class="field-hint" style="margin-bottom:0;">
          Everything below is owned by this account. If a tenant or agent you expect is missing,
          it probably belongs to a different account — sign out and back in with that one.
        </p>
      </div>
      <div class="card">
        <h2>Owned by this account</h2>
        <p>
          <a href="/tenants">${tenantCount} tenant${tenantCount === 1 ? "" : "s"}</a> ·
          ${connectionCount} connection${connectionCount === 1 ? "" : "s"} ·
          <a href="/agents">${agentCount} agent${agentCount === 1 ? "" : "s"}</a> ·
          ${roleCount} role${roleCount === 1 ? "" : "s"}
        </p>
      </div>
      <div class="card">
        <h2>Change password</h2>
        <form method="post" action="/account/password">
          <div class="field">
            <label for="current_password">Current password</label>
            <input type="password" name="current_password" id="current_password" required minlength="8" autocomplete="current-password">
          </div>
          <div class="field">
            <label for="new_password">New password</label>
            <input type="password" name="new_password" id="new_password" required minlength="8" autocomplete="new-password">
          </div>
          <div class="field">
            <label for="new_password2">New password (again)</label>
            <input type="password" name="new_password2" id="new_password2" required minlength="8" autocomplete="new-password">
          </div>
          <button type="submit">Change password</button>
          <p class="field-hint">Changing the password signs out every other session.</p>
        </form>
      </div>
      <div class="card">
        <h2>Locked out?</h2>
        <p class="field-hint" style="margin:0;">
          If you can't sign in at all, an operator can reset any account's password from the server:
          <code>railway run npm run user:reset-password -- &lt;email&gt; &lt;new-password&gt;</code>
        </p>
      </div>
    </main></body></html>
  `);
});

dashboardApp.post("/account/password", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const body = await c.req.parseBody();
  const currentPassword = String(body.current_password ?? "");
  const newPassword = String(body.new_password ?? "");
  const newPassword2 = String(body.new_password2 ?? "");

  if (newPassword.length < 8) return c.redirect(`/account?err=${encodeURIComponent("New password must be at least 8 characters")}`);
  if (newPassword !== newPassword2) return c.redirect(`/account?err=${encodeURIComponent("New passwords do not match")}`);

  try {
    await auth.api.changePassword({
      body: { currentPassword, newPassword, revokeOtherSessions: true },
      headers: c.req.raw.headers,
    });
  } catch (e: any) {
    const message = e?.body?.message ?? e?.message ?? "Password change failed";
    return c.redirect(`/account?err=${encodeURIComponent(message)}`);
  }
  return c.redirect("/account?ok=1");
});

// --- /tenants ---
dashboardApp.get("/tenants", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const [tenants, connections] = await Promise.all([
    prisma.tenant.findMany({
      where: { ownerId: user.id },
      orderBy: { slug: "asc" },
    }),
    prisma.connection.findMany({
      where: { ownerId: user.id },
      orderBy: [{ scope: "asc" }, { provider: "asc" }],
    }),
  ]);

  // The tenant table drives the list (so tenants with zero connections still
  // show); connections group under their scope. Scoped connections whose
  // tenant row hasn't been backfilled yet, plus legacy unscoped ones, get
  // their own groups.
  const byScope = new Map<string, typeof connections>();
  for (const t of tenants) byScope.set(t.slug, []);
  for (const conn of connections) {
    const key = conn.scope || "(unscoped)";
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key)!.push(conn);
  }
  const tenantBySlug = new Map(tenants.map((t) => [t.slug, t]));

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Tenants — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <div class="row spread" style="margin-bottom:16px;">
        <h1 style="margin:0;">Tenants</h1>
        <a href="/tenants/new" class="btn">+ New tenant</a>
      </div>
      <p style="color:#8a8d93;margin-top:-8px;">API: <code>GET /api/scopes</code> returns your full wiring as JSON.</p>
      <form method="post" action="/tenants/bulk-delete" id="bulkForm">
        <input type="hidden" name="scopes_csv" id="scopesCsv" value="">
        ${byScope.size === 0 ? '<div class="card"><div class="empty">No tenants yet. <a href="/tenants/new">Create your first one</a>.</div></div>' : `
        <div class="row spread" style="margin-bottom:8px;">
          <label style="font-size:13px;color:#c8ccd2;cursor:pointer;"><input type="checkbox" id="selectAll"> select all</label>
          <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" id="bulkDelBtn" disabled>🗑 Delete selected (0)</button>
        </div>
        ${Array.from(byScope.entries()).map(([scope, conns]) => `
        <div class="card">
          <h2>${scope === "(unscoped)" ? '<span class="badge unscoped">unscoped</span> Legacy connections' : (() => {
            const t = tenantBySlug.get(scope);
            const showName = t && t.displayName && t.displayName !== t.slug;
            return `<input type="checkbox" name="scopes" value="${scope}" class="rowCheck" style="margin-right:8px;transform:scale(1.2);">${showName ? `${escapeHtml(t!.displayName)} ` : ""}<span class="badge scoped">${scope}</span>`;
          })()} ${scope !== "(unscoped)" ? `<a href="/tenants/${scope}/edit#codex-mcp" class="btn secondary" style="margin-left:8px;font-size:12px;padding:4px 10px;">Connect to Codex</a> <a href="/tenants/${scope}/edit" class="btn secondary" style="margin-left:4px;font-size:12px;padding:4px 10px;">+ Add service</a> <a href="/tenants/${scope}/edit" class="btn secondary" style="margin-left:4px;font-size:12px;padding:4px 10px;">✎ Edit</a>` : ""}</h2>
          ${conns.length === 0 ? `<div class="empty">No connections yet. <a href="/tenants/${scope}/edit">+ Add service</a></div>` : `
          <table>
            <thead><tr><th>Provider</th><th>Auth</th><th>Label</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
            ${conns.map((c) => `
              <tr>
                <td><span class="provider-cell">${providerIcon(c.provider)}<code>${c.provider}</code></span></td>
                <td><code>${c.authType}</code></td>
                <td>${c.label}</td>
                <td>${c.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</td>
                <td><code>${c.createdAt.toISOString().slice(0, 10)}</code></td>
              </tr>
            `).join("")}
            </tbody>
          </table>`}
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

// --- /tenants/:scope/edit (edit settings + add services) ---
dashboardApp.get("/tenants/:scope/edit", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const scope = c.req.param("scope");
  const tenantRow = await prisma.tenant.findUnique({
    where: { ownerId_slug: { ownerId: user.id, slug: scope } },
  });
  const connections = await prisma.connection.findMany({
    where: { scope, ownerId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const userIdShort = user.id.slice(0, 8);
  const role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort}`, ownerId: user.id } });
  const roleTools: string[] = role ? safeJsonArray(role.allowedTools) : [];
  const roleScopes: string[] = role ? safeJsonArray(role.allowedScopes) : [];
  const codexAgents = role ? await prisma.agent.findMany({
    where: {
      ownerId: user.id,
      roles: { some: { roleId: role.id } },
    },
    orderBy: { createdAt: "asc" },
  }) : [];
  const providers = listProviders();
  const knownProviders = Object.values(PROVIDERS);

  // Get union of all tools from all connected providers (for the role settings checkboxes)
  const usedProviders = new Set(connections.map((c) => c.provider));
  const usedProviderAuthTypes = new Set(connections.map((c) => `${c.provider}:${c.authType}`));
  const allAvailableTools = Array.from(new Set(
    providers.filter((p) => usedProviders.has(p.key)).flatMap((p) => p.tools)
  ));
  const availableToAdd = providers.flatMap((p) =>
    p.authTypes.map((authType) => ({ provider: p, authType }))
  ).filter((option) => !usedProviderAuthTypes.has(`${option.provider.key}:${option.authType}`));
  const comingSoonProviders = knownProviders.filter((p) => p.implemented === false && !usedProviders.has(p.key));

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

  // Flash banner after a successful reconnect (OAuth re-authorization).
  const reauthed = c.req.query("reauthed");
  const reauthBanner = reauthed
    ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);margin-bottom:20px;">
         ✓ Re-authorized <code>${escapeHtml(reauthed)}</code>. The connection's access token (and refresh token) have been refreshed.
       </div>`
    : "";

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Edit ${scope} — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>Edit tenant ${tenantRow && tenantRow.displayName !== tenantRow.slug ? `${escapeHtml(tenantRow.displayName)} ` : ""}<code>${scope}</code></h1>
      <p style="color:#8a8d93;margin-top:-16px;margin-bottom:24px;">
        Edit the tenant's display labels, role tools, and role scopes. To add a new service, scroll down.
      </p>
      ${reauthBanner}

      <h2 id="codex-mcp">Codex MCP</h2>
      <div class="card">
        <p style="font-size:13px;color:#8a8d93;margin-top:0;">
          Connect this tenant to Codex as one MCP server. The generated config is locked to <code>${scope}</code>, so Codex cannot cross into another tenant through this entry.
        </p>
        ${codexAgents.length === 0 ? `
          <p>No Codex MCP token exists for this tenant yet.</p>
          <form method="post" action="/tenants/${scope}/codex-mcp/create">
            <button type="submit">Create Codex MCP config</button>
          </form>
        ` : `
          <p>${codexAgents.length} token${codexAgents.length === 1 ? "" : "s"} can access this tenant. Use the first one for the default Codex config.</p>
          ${mcpConfigBlock(publicOrigin(c), codexAgents[0].name, `${codexAgents[0].tokenPrefix}...ROTATE_TO_VIEW_FULL_TOKEN`, false, scope)}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Internal token</th><th>Status</th><th>Last used</th><th>Created</th><th>Action</th></tr></thead>
              <tbody>
                ${codexAgents.map((a) => `
                  <tr>
                    <td><code>${escapeHtml(a.name)}</code><br><span style="color:#8a8d93;font-size:12px;"><code>${escapeHtml(a.tokenPrefix)}...</code></span></td>
                    <td>${a.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</td>
                    <td>${a.lastUsedAt ? a.lastUsedAt.toISOString().slice(0, 16) : "—"}</td>
                    <td>${a.createdAt.toISOString().slice(0, 10)}</td>
                    <td>
                      <form method="post" action="/tenants/${scope}/codex-mcp/${a.id}/rotate" style="display:inline;" onsubmit="return confirm('Rotate Codex MCP token for ${scope}?\\n\\nThe old token will stop working immediately.')">
                        <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;">Rotate token</button>
                      </form>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <form method="post" action="/tenants/${scope}/edit" id="settingsForm">
        <input type="hidden" name="_action" value="save_settings">
        <input type="hidden" name="role_tools_json" id="roleToolsJson" value="">

        <h2>Tenant</h2>
        <div class="card">
          <p class="field-hint" style="margin-top:0;">
            The slug <code>${scope}</code> is the wire key agents send as <code>scope</code> / <code>X-Grantry-Scope</code> — it cannot be changed.
            The display name is only for dashboards and can be renamed freely.
          </p>
          <label for="tenant_display_name">Display name</label>
          <input type="text" name="tenant_display_name" id="tenant_display_name" value="${escapeHtml(tenantRow?.displayName ?? scope)}" placeholder="${scope}">
          <label for="tenant_description" style="margin-top:8px;">Description</label>
          <input type="text" name="tenant_description" id="tenant_description" value="${escapeHtml(tenantRow?.description ?? "")}" placeholder="What this tenant is for">
        </div>

        <h2>Connections (${connections.length})</h2>
        ${connections.length === 0 ? '<div class="card"><div class="empty">No connections yet. Add one below.</div></div>' : `
        <div class="card">
          <p class="field-hint" style="margin-top:0;">Edit the display label for each connection. This is what you see in dashboards, audit logs, and tooltips.</p>
          <div class="table-wrap">
          <table class="connection-table">
            <thead><tr><th>Provider</th><th>Auth</th><th>Scope</th><th>Credential</th><th>Label</th><th>Enabled</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>
            ${connections.map((cn) => {
              const canReconnect = cn.authType === "oauth";
              const needsReconnect = cn.authType === "oauth" && cn.accessTokenExpiresAt && cn.accessTokenExpiresAt < new Date() && !cn.refreshToken;
              return `
              <tr>
                <td><span class="provider-cell">${providerIcon(cn.provider)}<code>${cn.provider}</code></span></td>
                <td><code>${cn.authType}</code></td>
                <td><code>${cn.scope}</code></td>
                <td>
                  ${oauthTokenStatus(cn)}
                  ${renderCredentialSummary(cn)}
                  ${cn.provider === "google_ads" ? `
                    <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #2a2d33;">
                      <div class="field-hint" style="margin-bottom:6px;">
                        Google Ads Developer token:
                        ${cn.encryptedServerCredential || process.env.GOOGLE_ADS_DEVELOPER_TOKEN
                          ? '<span class="badge ok">set</span>'
                          : '<span class="badge denied">missing</span>'}
                      </div>
                      <input type="password" name="conn_server_credential_${cn.id}" placeholder="Paste Developer token from Google Ads API Center" style="font-size:13px;margin-bottom:6px;">
                      <div class="field-hint">
                        OAuth user tokenとは別です。Google Ads API Center の Developer token をここに保存します。
                        <a href="https://ads.google.com/aw/apicenter" target="_blank" rel="noopener">Open API Center →</a>
                      </div>
                      ${cn.encryptedServerCredential ? `<label style="font-weight:normal;font-size:12px;margin-top:6px;"><input type="checkbox" name="conn_clear_server_credential_${cn.id}"> clear saved developer token</label>` : ""}
                    </div>
                  ` : ""}
                </td>
                <td><input type="text" name="conn_label_${cn.id}" value="${escapeHtml(cn.label)}" style="font-size:13px;"></td>
                <td><label style="font-weight:normal;font-size:13px;"><input type="checkbox" name="conn_enabled_${cn.id}" ${cn.enabled ? "checked" : ""}> on</label></td>
                <td><code>${cn.createdAt.toISOString().slice(0, 10)}</code></td>
                <td><span class="stacked-actions">${canReconnect
                  ? `<a href="/oauth/${cn.provider}/start?tenant=${encodeURIComponent(cn.scope)}&reauth=1&connection_id=${encodeURIComponent(cn.id)}" class="btn secondary" style="font-size:12px;padding:4px 10px;white-space:nowrap;" title="Re-run the OAuth consent flow and refresh this exact connection's tokens">↻ Reconnect</a>${needsReconnect ? '<span class="badge denied">needs reconnect</span>' : ""}`
                  : `<button type="submit" form="recheck_connection_${cn.id}" class="secondary" style="font-size:12px;padding:4px 10px;white-space:nowrap;" title="Re-run credential validation without showing the saved token">Recheck</button>`}
                  <button type="submit" form="delete_connection_${cn.id}" class="danger" style="font-size:12px;padding:4px 10px;white-space:nowrap;" title="Delete only this connection">Delete</button>
                </span></td>
              </tr>
            `;}).join("")}
            </tbody>
          </table>
          </div>
          <p class="field-hint">↻ <b>Reconnect</b> re-runs the provider's OAuth consent screen and refreshes this connection's access/refresh tokens in place. <b>Delete</b> removes only that credential connection; roles and agents remain.</p>
        </div>`}

        <h2>Role <code>${scope}-dev-${userIdShort}</code></h2>
        <div class="card">
          <div class="field">
            <label for="role_desc">Description</label>
            <input type="text" name="role_desc" id="role_desc" value="${escapeHtml(roleDesc)}" placeholder="What this role is for">
          </div>
          <div class="field">
            <label>Agent tool allowlist</label>
            <p class="field-hint" style="margin-top:0;">These are grantry permissions, not SaaS permissions. The SaaS credential above may still reject calls if its own scopes are narrower.</p>
            <div class="field-hint" style="margin:8px 0 12px;">
              ${allAvailableTools.filter((t) => !roleTools.includes(t)).length > 0
                ? `<span style="color:#f0b429;">${allAvailableTools.filter((t) => !roleTools.includes(t)).length} connected tool(s) are not granted to this role yet.</span>`
                : `<span style="color:#7bd88f;">All connected provider tools are granted to this role.</span>`}
              <button type="submit" form="sync_role_tools_form" class="secondary" style="font-size:12px;padding:4px 10px;margin-left:8px;">Refresh grants</button>
            </div>
            ${allAvailableTools.length === 0 ? '<div class="empty">No providers connected yet.</div>' : `
            <div id="roleToolsList">${allAvailableTools.map((t) => `<label style="font-weight:normal;display:block;padding:2px 0;"><input type="checkbox" name="role_tools" value="${t}" ${roleTools.includes(t) ? "checked" : ""}> <code>${t}</code></label>`).join("")}</div>
            `}
          </div>
          <div class="field">
            <label for="role_scopes">Allowed scopes</label>
            <input type="text" name="role_scopes" id="role_scopes" value="${escapeHtml(roleScopesStr)}" placeholder="${escapeHtml(scope)}">
            <div class="field-hint">Comma-separated scope names. Use exact tenant names. <b>Empty = any scope</b> and is only for legacy/admin use. Your other tenants: ${existingScopes.map((s) => `<code>${s}</code>`).join(", ") || "<em>none</em>"}.</div>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:32px;">
          <button type="submit">Save settings</button>
          <a href="/tenants" class="btn secondary">Cancel</a>
        </div>
      </form>
      <script>
        document.getElementById('settingsForm').addEventListener('submit', () => {
          const selected = Array.from(document.querySelectorAll('#roleToolsList input[name="role_tools"]:checked')).map(i => i.value);
          document.getElementById('roleToolsJson').value = JSON.stringify(selected);
        });
      </script>
      ${connections.map((cn) => `
        <form id="recheck_connection_${cn.id}" method="post" action="/tenants/${scope}/connections/${cn.id}/recheck"></form>
        <form id="delete_connection_${cn.id}" method="post" action="/tenants/${scope}/connections/${cn.id}/delete" onsubmit="return confirm(${jsString(`Delete connection ${cn.label}?\n\nProvider: ${cn.provider}\nScope: ${cn.scope}\n\nRoles and agents remain, but this provider credential will no longer be usable.`)});"></form>
      `).join("")}
      <form id="sync_role_tools_form" method="post" action="/tenants/${scope}/sync-role-tools"></form>

      <h2>Advanced: additional agent token</h2>
      <div class="card">
        <p class="field-hint" style="margin-top:0;">Most users should use <b>Codex MCP</b> above. This creates an extra internal agent token bound to <code>${scope}-dev-${userIdShort}</code> for custom automation or testing.</p>
        <form method="post" action="/tenants/${scope}/agents/new" id="addAgentForm">
          <div class="field">
            <label for="agent">Agent name</label>
            <input type="text" name="agent" id="agent" pattern="[a-zA-Z0-9_-]+" placeholder="e.g. ${escapeHtml(scope)}-read-bot" required>
            <div class="field-hint">Globally unique. Suggestions: <code>${escapeHtml(scope)}-read</code>, <code>${escapeHtml(scope)}-write</code>, <code>${escapeHtml(scope)}-ci</code>.</div>
          </div>
          <div class="field">
            <label for="agent_desc">Description <span style="color:#8a8d93;">(optional)</span></label>
            <input type="text" name="agent_desc" id="agent_desc" placeholder="What this agent is for">
          </div>
          <div class="field">
            <label>Additional tools to enable</label>
            <p class="field-hint" style="margin-top:0;">The agent will inherit all tools the role already has. Uncheck to NOT add any extras (rare — leave as-is unless you need a tool the role doesn't have).</p>
            <div id="agentToolsList" style="font-size:13px;color:#8a8d93;">${roleTools.length} tools already in role: <code>${roleTools.slice(0, 4).join("</code> · <code>")}${roleTools.length > 4 ? `</code> · +${roleTools.length - 4} more` : "</code>"}</div>
            <input type="hidden" name="tools_json" id="agentToolsJson" value="">
          </div>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="secondary">Create additional token</button>
          </div>
        </form>
      </div>

      <h2 style="color:#ff6b6b;">Danger zone</h2>
      <div class="card" style="border-color:#ff6b6b;">
        <p>Delete this tenant entirely. This removes <b>all your connections</b> for scope <code>${scope}</code> and the role <code>${scope}-dev-${userIdShort}</code>. Agents bound to that role will be left <b>unbound</b> (use <a href="/agents">/agents</a> to clean them up).</p>
        <form method="post" action="/tenants/${scope}/delete" onsubmit="return confirm('Delete tenant ${scope}?\\n\\nThis removes all YOUR connections and the role for this scope. This action cannot be undone.');">
          <button type="submit" style="background:#ff6b6b;color:#0e0f12;">🗑 Delete tenant ${scope}</button>
        </form>
      </div>

      <h2>Add a service</h2>
      ${availableToAdd.length === 0 ? `
      <div class="card">
        <div class="empty">All currently supported provider/auth combinations are already connected for this tenant.</div>
        ${comingSoonProviders.length > 0 ? `
          <p class="field-hint" style="text-align:center;margin-top:14px;">
            Coming soon: ${comingSoonProviders.map((p) => `<code>${p.key}</code>`).join(", ")}
          </p>
        ` : ""}
      </div>` : `
      <form method="post" action="/tenants/${scope}/edit" id="addConnForm">
        <input type="hidden" name="_action" value="add_service">
        <div class="step-card">
          <h2><span class="num">+</span> New service</h2>
          <div class="field">
            <label for="provider">Provider</label>
            <div style="display:flex;align-items:center;gap:10px;">
              <span id="providerIconBox" style="display:inline-flex;flex-shrink:0;">${providerIcon(availableToAdd[0].provider.key, 24)}</span>
              <select name="provider" id="provider" required style="flex:1;">
                ${availableToAdd.map(({ provider: p, authType }) => `<option value="${p.key}" data-auth-type="${authType}">${p.label} (${authTypeLabel(p.key, authType)})</option>`).join("")}
              </select>
            </div>
          </div>
          <input type="hidden" name="auth_method" id="authMethodHidden" value="">
          <div class="field" id="credFieldRow">
            <label for="credential">Credential</label>
            <textarea name="credential" id="credential" rows="3" required></textarea>
            <div class="field-hint" id="credHint"></div>
            <div class="field-hint" id="serverCredentialHint"></div>
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
          <button type="submit" id="addServiceButton">Add service</button>
        </div>
      </form>
      <script>
        const PROVIDERS = ${JSON.stringify(Object.fromEntries(providers.map(p => [p.key, p])))};
        const PROVIDER_ICONS = ${JSON.stringify(providerIconMap(24))};
        const providerIconBox = document.getElementById('providerIconBox');
        const sel = document.getElementById('provider');
        const toolsList = document.getElementById('toolsList');
        const credHint = document.getElementById('credHint');
        const credField = document.getElementById('credential');
        const credFieldRow = document.getElementById('credFieldRow');
        const serverCredentialHint = document.getElementById('serverCredentialHint');
        const authMethodHidden = document.getElementById('authMethodHidden');
        const patLinkRow = document.getElementById('patLinkRow');
        const patLink = document.getElementById('patLink');
        const oauthSetupLinkRow = document.getElementById('oauthSetupLinkRow');
        const oauthSetupLink = document.getElementById('oauthSetupLink');
        const addServiceButton = document.getElementById('addServiceButton');

        function updateUI() {
          const p = PROVIDERS[sel.value];
          if (!p) return;
          if (providerIconBox) providerIconBox.innerHTML = PROVIDER_ICONS[sel.value] || '';
          const authType = sel.options[sel.selectedIndex].dataset.authType;
          authMethodHidden.value = authType;
          const usePat = authType === "pat";
          const useOauth = authType === "oauth";
          credHint.textContent = p.helpText;
          if (serverCredentialHint) {
            if (sel.value === "google_ads") {
              const envSet = ${JSON.stringify(!!process.env.GOOGLE_ADS_DEVELOPER_TOKEN)};
              serverCredentialHint.innerHTML = (envSet ? '<span class="badge ok">set</span>' : '<span class="badge denied">missing</span>') + ' Google Ads Developer token is separate from OAuth. After OAuth, paste the API Center token into the Google Ads connection row. <a href="https://ads.google.com/aw/apicenter" target="_blank" rel="noopener">Open API Center →</a>';
            } else {
              serverCredentialHint.innerHTML = "";
            }
          }
          const tokenLabel = sel.value === "hubspot"
            ? "HubSpot Private App access token"
            : (sel.value === "attio"
              ? "Attio access token"
              : (sel.value === "clay"
                ? "Clay API key"
                : (sel.value === "heyreach"
                  ? "HeyReach Public API key"
                  : (sel.value === "railway"
                    ? "Railway Project Token"
                    : (sel.value === "resend"
                      ? "Resend API key"
                      : (sel.value === "google_maps" ? "Google Maps Platform API key" : p.label + " token"))))));
          credField.placeholder = usePat ? "Paste your " + tokenLabel + (sel.value === "hubspot" ? " here (starts with pat-)" : " here") : "OAuth flow will start after submit";
          credField.disabled = !usePat;
          credField.required = usePat;
          credFieldRow.style.opacity = usePat ? "1" : "0.55";
          addServiceButton.textContent = useOauth ? "Connect with OAuth" : "Add service";
          if (!usePat) credField.value = "";
          if (usePat && p.tokenUrl) {
            patLink.href = p.tokenUrl;
            patLink.textContent = sel.value === "hubspot"
              ? "🔗 Get a new HubSpot Private App access token here →"
              : (sel.value === "attio"
                ? "🔗 Manage Attio access tokens here →"
                : (sel.value === "clay"
                  ? "🔗 Open Clay API key settings →"
                  : (sel.value === "heyreach"
                    ? "🔗 Open HeyReach app →"
                    : (sel.value === "railway"
                      ? "🔗 Open Railway →"
                      : (sel.value === "resend"
                        ? "🔗 Open Resend API keys →"
                        : (sel.value === "google_maps"
                          ? "🔗 Open Google Maps Platform credentials →"
                          : (sel.value === "github" ? "🔗 Manage GitHub PAT repository access here →" : "🔗 Get a new " + p.label + " token here →")))))));
            patLinkRow.style.display = "";
          } else {
            patLinkRow.style.display = "none";
          }
          if (useOauth && p.oauthSetupUrl) {
            oauthSetupLink.href = p.oauthSetupUrl;
            oauthSetupLink.textContent = sel.value === "google_ads"
              ? "🔗 Register/manage Google OAuth client here →"
              : (sel.value === "yahoo_ads" ? "🔗 Register/manage LINE Yahoo Ads application here →" : "🔗 Register/manage your " + p.label + " OAuth app here →");
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

async function uniqueAgentName(base: string): Promise<string> {
  const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "codex";
  let candidate = safeBase;
  for (let i = 0; i < 20; i++) {
    const existing = await prisma.agent.findUnique({ where: { name: candidate } });
    if (!existing) return candidate;
    candidate = `${safeBase}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
  }
  return `${safeBase}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function roleForTenantOrCreate(userId: string, scope: string) {
  const userIdShort = userId.slice(0, 8);
  let role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort}`, ownerId: userId } });
  if (role) return role;

  const conns = await prisma.connection.findMany({
    where: { ownerId: userId, scope, enabled: true },
    select: { provider: true },
  });
  const tools = Array.from(new Set(conns.flatMap((cn) => toolsForProvider(cn.provider))));
  return prisma.role.create({
    data: {
      name: `${scope}-dev-${userIdShort}`,
      description: `Default role for ${scope}`,
      allowedTools: JSON.stringify(tools),
      allowedScopes: JSON.stringify([scope]),
      ownerId: userId,
    },
  });
}

async function syncTenantRoleTools(userId: string, scope: string) {
  const userIdShort = userId.slice(0, 8);
  const conns = await prisma.connection.findMany({
    where: { ownerId: userId, scope, enabled: true },
    select: { provider: true },
  });
  const connectedTools = Array.from(new Set(conns.flatMap((cn) => toolsForProvider(cn.provider))));
  let role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort}`, ownerId: userId } });
  if (!role) {
    role = await prisma.role.create({
      data: {
        name: `${scope}-dev-${userIdShort}`,
        description: `Default role for ${scope}`,
        allowedTools: JSON.stringify(connectedTools),
        allowedScopes: JSON.stringify([scope]),
        ownerId: userId,
      },
    });
    return { role, addedTools: connectedTools, connectedTools };
  }

  const existingTools = safeJsonArray(role.allowedTools);
  const existingScopes = safeJsonArray(role.allowedScopes);
  const mergedTools = Array.from(new Set([...existingTools, ...connectedTools]));
  const mergedScopes = existingScopes.length === 0 ? [scope] : Array.from(new Set([...existingScopes, scope]));
  const addedTools = mergedTools.filter((tool) => !existingTools.includes(tool));
  role = await prisma.role.update({
    where: { id: role.id },
    data: {
      allowedTools: JSON.stringify(mergedTools),
      allowedScopes: JSON.stringify(mergedScopes),
    },
  });
  return { role, addedTools, connectedTools };
}

// --- /tenants/:scope/sync-role-tools (POST) — grant all connected provider tools to tenant role ---
dashboardApp.post("/tenants/:scope/sync-role-tools", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  const { role, addedTools, connectedTools } = await syncTenantRoleTools(user.id, scope);
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Role tools synced — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Granted connected tools for <code>${escapeHtml(scope)}</code></h1>
      <div class="card">
        <p>Role <code>${escapeHtml(role.name)}</code> now includes ${safeJsonArray(role.allowedTools).length} tool(s).</p>
        <p>Connected provider tools: ${connectedTools.map((tool) => `<span class="tool-pill">${escapeHtml(tool)}</span>`).join(" ") || "<em>none</em>"}</p>
        <p>Newly added: ${addedTools.map((tool) => `<span class="tool-pill">${escapeHtml(tool)}</span>`).join(" ") || "<em>none</em>"}</p>
      </div>
      <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a></p>
    </main></body></html>
  `);
});

// --- /tenants/:scope/codex-mcp/create ---
dashboardApp.post("/tenants/:scope/codex-mcp/create", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  const role = await roleForTenantOrCreate(user.id, scope);
  const existing = await prisma.agent.findFirst({
    where: {
      ownerId: user.id,
      roles: { some: { roleId: role.id } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return c.redirect(`/tenants/${scope}/edit#codex-mcp`);

  const token = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then(c => c.createHash("sha256").update(token).digest("hex"));
  const agentName = await uniqueAgentName(`${scope}-codex`);
  const agent = await prisma.agent.create({
    data: {
      name: agentName,
      description: `Codex MCP token for tenant ${scope}`,
      hashedToken: tokenHash,
      tokenPrefix: token.slice(0, 16),
      ownerId: user.id,
      roles: { create: [{ roleId: role.id }] },
    },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Codex MCP created — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>Codex MCP ready for <code>${escapeHtml(scope)}</code></h1>
      <div class="card">
        <h2>Internal token</h2>
        <p><code>${escapeHtml(agent.name)}</code> is bound to <code>${escapeHtml(role.name)}</code>.</p>
      </div>
      ${agentTokenCard(token)}
      ${mcpConfigCard(publicOrigin(c), agent.name, token, true, scope)}
      <p><a href="/tenants/${scope}/edit#codex-mcp">← Back to ${scope}</a></p>
    </main></body></html>
  `);
});

// --- /tenants/:scope/codex-mcp/:agentId/rotate ---
dashboardApp.post("/tenants/:scope/codex-mcp/:agentId/rotate", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  const agentId = c.req.param("agentId");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  const userIdShort = user.id.slice(0, 8);
  const role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort}`, ownerId: user.id } });
  if (!role) return c.html("<h1>tenant role not found</h1>", 404);
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { roles: true },
  });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your token</h1>", 403);
  if (!agent.roles.some((r) => r.roleId === role.id)) return c.html("<h1>token is not bound to this tenant</h1>", 403);

  const token = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then(c => c.createHash("sha256").update(token).digest("hex"));
  await prisma.agent.update({
    where: { id: agent.id },
    data: {
      hashedToken: tokenHash,
      tokenPrefix: token.slice(0, 16),
      lastUsedAt: null,
    },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Codex MCP rotated — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>Codex MCP token rotated for <code>${escapeHtml(scope)}</code></h1>
      ${agentTokenCard(token)}
      ${mcpConfigCard(publicOrigin(c), agent.name, token, true, scope)}
      <p><a href="/tenants/${scope}/edit#codex-mcp">← Back to ${scope}</a></p>
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
    // Tenant display name/description. The slug itself is immutable (wire key).
    if (body.tenant_display_name !== undefined || body.tenant_description !== undefined) {
      const tenantRow = await ensureTenant(user.id, scope);
      const displayName = String(body.tenant_display_name ?? "").trim() || scope;
      const description = String(body.tenant_description ?? "").trim() || null;
      if (displayName !== tenantRow.displayName || description !== tenantRow.description) {
        await prisma.tenant.update({
          where: { id: tenantRow.id },
          data: { displayName, description },
        });
      }
    }

    const connections = await prisma.connection.findMany({
      where: { scope, ownerId: user.id },
    });

    // Update each connection's label + enabled
    const connUpdates: Array<{ id: string; label: string; enabled: boolean }> = [];
    for (const cn of connections) {
      const labelField = `conn_label_${cn.id}`;
      const enabledField = `conn_enabled_${cn.id}`;
      const serverCredentialField = `conn_server_credential_${cn.id}`;
      const clearServerCredentialField = `conn_clear_server_credential_${cn.id}`;
      if (body[labelField] !== undefined) {
        const newLabel = String(body[labelField]).trim() || cn.label;
        const newEnabled = body[enabledField] !== undefined; // checkbox present = on
        const serverCredential = String(body[serverCredentialField] ?? "").trim();
        const clearServerCredential = body[clearServerCredentialField] !== undefined;
        const updateData: Record<string, unknown> = {};
        if (newLabel !== cn.label) updateData.label = newLabel;
        if (newEnabled !== cn.enabled) updateData.enabled = newEnabled;
        if (cn.provider === "google_ads" && serverCredential) {
          updateData.encryptedServerCredential = encrypt(serverCredential);
        }
        if (cn.provider === "google_ads" && clearServerCredential) updateData.encryptedServerCredential = null;
        if (Object.keys(updateData).length > 0) {
          await prisma.connection.update({
            where: { id: cn.id },
            data: updateData,
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
    let roleTools: string[] = [];
    const roleToolsJson = String(body.role_tools_json ?? "").trim();
    if (roleToolsJson) {
      try {
        const parsed = JSON.parse(roleToolsJson);
        roleTools = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        roleTools = [];
      }
    } else {
      roleTools = Array.isArray(body.role_tools) ? body.role_tools.map(String) : (body.role_tools ? [String(body.role_tools)] : []);
    }

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
    if (role) {
      const enabledConnections = await prisma.connection.findMany({
        where: { scope, ownerId: user.id, enabled: true },
        select: { provider: true },
      });
      const existingTools = safeJsonArray(role.allowedTools);
      const connectedTools = enabledConnections.flatMap((cn) => toolsForProvider(cn.provider));
      const mergedTools = Array.from(new Set([...existingTools, ...connectedTools]));
      role = await prisma.role.update({
        where: { id: role.id },
        data: { allowedTools: JSON.stringify(mergedTools) },
      });
    }

    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Saved — grantry</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
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
        <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a> · <a href="/tenants">All tenants</a></p>
      </main></body></html>
    `);
  }

  // --- add_service: add a new provider connection (existing behavior) ---
  if (action === "add_service") {
    const provider = String(body.provider ?? "").trim();
    const authMethod = String(body.auth_method ?? "").trim();
    const credential = String(body.credential ?? "").trim();
    const userIdShort2 = user.id.slice(0, 8);
    let tools: string[] = [];
    const toolsJson = String(body.tools_json ?? "").trim();
    if (toolsJson) { try { tools = JSON.parse(toolsJson); } catch {} }

    const providerDef = getProvider(provider);
    if (!providerDef) return c.html("<h1>unknown provider</h1>", 400);
    if (providerDef.implemented === false) return c.html("<h1>provider not implemented</h1>", 400);
    const wantsOauth = authMethod === "oauth" || (providerDef.authTypes.includes("oauth") && !providerDef.authTypes.includes("pat"));
    const wantsPat = authMethod === "pat" || (providerDef.authTypes.includes("pat") && !providerDef.authTypes.includes("oauth"));
    if (!wantsPat && credential) {
      return c.html("<h1>pasted credentials are not accepted for this OAuth-only provider</h1>", 400);
    }
    if (wantsOauth) {
      if (!providerDef.authTypes.includes("oauth")) return c.html("<h1>OAuth is not supported for this provider</h1>", 400);
      const selectedTools = tools.length > 0 ? tools : toolsForProvider(provider);
      let role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort2}`, ownerId: user.id } });
      const currentTools: string[] = role ? safeJsonArray(role.allowedTools) : [];
      const currentScopes: string[] = role ? safeJsonArray(role.allowedScopes) : [scope];
      const mergedTools = Array.from(new Set([...currentTools, ...selectedTools]));
      const mergedScopes = currentScopes.length === 0 ? [scope] : Array.from(new Set([...currentScopes, scope]));
      if (role) {
        await prisma.role.update({
          where: { id: role.id },
          data: { allowedTools: JSON.stringify(mergedTools), allowedScopes: JSON.stringify(mergedScopes) },
        });
      } else {
        await prisma.role.create({
          data: {
            name: `${scope}-dev-${userIdShort2}`,
            allowedTools: JSON.stringify(mergedTools),
            allowedScopes: JSON.stringify([scope]),
            ownerId: user.id,
          },
        });
      }
      return c.redirect(`/oauth/${provider}/start?tenant=${encodeURIComponent(scope)}&reauth=1`);
    }
    if (!wantsPat || !providerDef.authTypes.includes("pat")) return c.html("<h1>paste token is not supported for this provider</h1>", 400);
    if (!credential) return c.html("<h1>credential required</h1>", 400);

    // 1) Create or rotate the PAT connection for this provider/auth type.
    const tenantRow = await ensureTenant(user.id, scope);
    const existingConn = await prisma.connection.findFirst({
      where: { provider, authType: "pat", scope, ownerId: user.id },
    });
    const credentialMeta = await credentialMetadataForStorage(provider, "pat", credential);
    const conn = existingConn
      ? await prisma.connection.update({
          where: { id: existingConn.id },
          data: {
            encryptedCredential: encrypt(credential),
            refreshToken: null,
            accessTokenExpiresAt: null,
            ...credentialMeta,
          },
        })
      : await prisma.connection.create({
          data: {
            provider,
            authType: "pat",
            label: `${provider}-${scope}-pat`,
            scope,
            tenantId: tenantRow.id,
            ownerId: user.id,
            encryptedCredential: encrypt(credential),
            ...credentialMeta,
          },
        });

    // 2) Find or create role, then merge allowedTools (union)
    let role = await prisma.role.findFirst({ where: { name: `${scope}-dev-${userIdShort2}`, ownerId: user.id } });
    let currentTools: string[] = role ? safeJsonArray(role.allowedTools) : [];
    let currentScopes: string[] = role ? safeJsonArray(role.allowedScopes) : [];
    if (currentScopes.length === 0) {
      currentScopes = [scope];
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
          allowedScopes: JSON.stringify([scope]),
          ownerId: user.id,
        },
      });
    }

    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Service added — grantry</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
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
        <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a> · <a href="/tenants">All tenants</a></p>
      </main></body></html>
    `);
  }

  return c.html("<h1>unknown action</h1>", 400);
});

// --- /tenants/:scope/connections/:connectionId/recheck (POST) — validate saved PAT-like credential ---
dashboardApp.post("/tenants/:scope/connections/:connectionId/recheck", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  const connectionId = c.req.param("connectionId");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  const conn = await prisma.connection.findFirst({
    where: { id: connectionId, scope, ownerId: user.id },
  });
  if (!conn) {
    return c.html(`<h1>connection not found</h1><p><a href="/tenants/${scope}/edit">← Back</a></p>`, 404);
  }
  if (conn.authType === "oauth") {
    return c.html(`<h1>OAuth connection uses Reconnect</h1><p>Use the Reconnect button to refresh this credential.</p><p><a href="/tenants/${scope}/edit">← Back</a></p>`, 400);
  }

  const token = decrypt(conn.encryptedCredential);
  const credentialMeta = await credentialMetadataForStorage(conn.provider, conn.authType, token);
  await prisma.connection.update({
    where: { id: conn.id },
    data: credentialMeta,
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Connection rechecked — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Rechecked <code>${escapeHtml(conn.label)}</code></h1>
      <div class="card">
        <p>${renderCredentialSummary({ ...conn, ...credentialMeta })}</p>
        <p class="field-hint">The saved token remains hidden. Only the validation result is updated.</p>
      </div>
      <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a></p>
    </main></body></html>
  `);
});

// --- /tenants/:scope/connections/:connectionId/delete (POST) — delete one connection ---
dashboardApp.post("/tenants/:scope/connections/:connectionId/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  const connectionId = c.req.param("connectionId");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  const conn = await prisma.connection.findFirst({
    where: { id: connectionId, scope, ownerId: user.id },
    select: { id: true, label: true, provider: true, scope: true },
  });
  if (!conn) {
    return c.html(`<h1>connection not found</h1><p>The connection either does not exist, is not yours, or does not belong to <code>${escapeHtml(scope)}</code>.</p><p><a href="/tenants/${scope}/edit">← Back</a></p>`, 404);
  }

  await prisma.connection.delete({ where: { id: conn.id } });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Connection deleted — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Deleted connection <code>${escapeHtml(conn.label)}</code></h1>
      <div class="card">
        <p>Provider <code>${escapeHtml(conn.provider)}</code> was removed from scope <code>${escapeHtml(conn.scope)}</code>.</p>
        <p>Roles and agents were left unchanged. Calls to this provider will be denied until a new connection is added.</p>
      </div>
      <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a></p>
    </main></body></html>
  `);
});

// --- /tenants/new ---
dashboardApp.get("/tenants/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const providers = listProviders();
  const knownProviders = Object.values(PROVIDERS);
  const providerAuthOptions = knownProviders.flatMap((p) =>
    p.authTypes.map((authType) => ({ provider: p, authType }))
  );
  // Get existing tenants (distinct scope values) and which providers each has.
  // We need provider-by-provider info so the wizard can hide the credential
  // field when reusing an existing connection.
  const existingConns = await prisma.connection.findMany({
    where: { ownerId: user.id },
    select: { scope: true, provider: true, authType: true, label: true },
    orderBy: { scope: "asc" },
  });
  const existingScopes = Array.from(new Set(existingConns.map((c: { scope: string }) => c.scope).filter((s: string) => s.length > 0)));
  // Map: scope -> { "provider:authType" -> label } so the JS can detect "reusing" mode
  const scopeProviders: Record<string, Record<string, string>> = {};
  for (const c of existingConns) {
    if (!c.scope) continue;
    if (!scopeProviders[c.scope]) scopeProviders[c.scope] = {};
    scopeProviders[c.scope][`${c.provider}:${c.authType}`] = c.label;
  }

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>New tenant — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>+ New tenant</h1>
      <p style="color:#8a8d93;margin-top:-16px;margin-bottom:24px;">
        Create an isolated tenant in one step. This sets up: a <b>connection</b> with scope=&lt;tenant&gt;,
        a <b>role</b> with allowed_scopes bound to that tenant, an <b>agent</b>, and a fresh <b>token</b>.
      </p>
      <form method="post" action="/tenants/new" id="wizForm">
        <div class="step-card">
          <h2><span class="num">1</span> Tenant</h2>
          <div class="field field-primary">
            <label for="tenant">New tenant name</label>
            <input type="text" name="tenant" id="tenant" pattern="[a-z0-9_-]+" placeholder="my-new-tenant" autofocus required>
            <div class="field-hint">lowercase, alphanumeric, hyphens, underscores. This is the <b>scope</b> for all your API calls — it cannot be changed later, so pick carefully.</div>
          </div>
          <div class="field">
            <label for="display_name">Display name (optional)</label>
            <input type="text" name="display_name" id="display_name" placeholder="e.g. Grantry 開発環境">
            <div class="field-hint">Human-facing label shown in dashboards. Unlike the tenant name, you can rename this anytime.</div>
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
            <div class="field-hint">Comma-separated. The role will be allowed to access <i>these scopes too</i> in addition to the new tenant. Leave empty to allow <b>only the new tenant</b>. Your other tenants: ${existingScopes.map((s) => `<code>${s}</code>`).join(", ")}.</div>
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
          <h2><span class="num">2</span> Providers</h2>
          <p class="field-hint" style="margin-top:0;">Pick one or more services to wire into this tenant. Each one gets its own connection; you can tune which tools each enables.</p>
          ${providerAuthOptions.map(({ provider: p, authType }) => {
            const authLabel = authTypeLabel(p.key, authType);
            const hasPat = p.authTypes.includes("pat");
            const hasOauth = p.authTypes.includes("oauth");
            const isImplemented = p.implemented !== false;
            const optionKey = `${p.key}:${authType}`;
            return `
          <div class="provider-block" data-provider="${p.key}" data-auth-type="${authType}" data-haspat="${hasPat}" data-hasoauth="${hasOauth}" data-implemented="${isImplemented}" style="border:1px solid #2a2d33;border-radius:8px;padding:12px 16px;margin-bottom:12px;${isImplemented ? "" : "opacity:.62;"}">
            <label style="font-weight:600;display:flex;align-items:center;gap:8px;cursor:${isImplemented ? "pointer" : "not-allowed"};margin:0;">
              <input type="checkbox" class="provider-check" value="${optionKey}" ${isImplemented ? "" : "disabled"}> ${providerIcon(p.key)} ${p.label}
              <span style="color:#8a8d93;font-weight:normal;font-size:13px;">(${authLabel})</span>
              ${isImplemented ? "" : '<span class="badge unscoped" style="margin-left:auto;">Coming soon</span>'}
            </label>
            ${isImplemented ? `
            <div class="provider-detail" style="display:none;margin-top:12px;padding-left:24px;">
              ${authType === "pat" ? `
              <div class="field cred-row">
                <label>Credential</label>
                <textarea name="credential_${p.key}_${authType}" class="cred-input" rows="2" placeholder="${escapeHtml(credentialPlaceholder(p.key, p.label, authType))}"></textarea>
                <div class="field-hint">${escapeHtml(p.helpText)}</div>
                ${p.tokenUrl ? `<div style="margin-top:4px;"><a href="${p.tokenUrl}" target="_blank" rel="noopener" style="font-size:13px;">${escapeHtml(tokenLinkLabel(p.key, p.label))}</a></div>` : ""}
                <div class="reusing-notice" style="display:none;margin-top:6px;padding:8px;background:rgba(110,168,254,0.08);border-radius:6px;font-size:13px;">
                  ♻️ Reusing the existing <code class="reusing-label"></code> connection. <a href="#" class="rotate-link" style="margin-left:4px;">rotate credential</a> to paste a new one.
                </div>
              </div>` : ""}
              ${authType === "oauth" ? `
              <div class="field oauth-row">
                <div class="field-hint" style="margin-top:0;">${escapeHtml(p.helpText)} You'll be redirected to authorize after clicking <b>Create tenant</b>.</div>
                ${serverCredentialHint(p.key)}
                ${p.oauthSetupUrl ? `<div style="margin-top:4px;"><a href="${p.oauthSetupUrl}" target="_blank" rel="noopener" style="font-size:13px;">${p.key === "google_ads" ? "🔗 Register/manage Google OAuth client here →" : p.key === "yahoo_ads" ? "🔗 Register/manage LINE Yahoo Ads application here →" : `🔗 Register/manage your ${p.label} OAuth app here →`}</a></div>` : ""}
              </div>` : ""}
              <div class="field" style="margin-bottom:0;">
                <label style="font-size:13px;">Tools</label>
                <div class="tools-list">
                  ${p.tools.map(t => `<label style="font-weight:normal;display:block;padding:2px 0;"><input type="checkbox" class="tool-check" value="${t}" checked> <code>${t}</code></label>`).join("")}
                </div>
              </div>
            </div>
            ` : `
            <div class="field-hint" style="margin:8px 0 0 34px;">Provider registration is defined, but MCP tools and dispatch are not enabled yet.</div>
            `}
          </div>`;
          }).join("")}
          <input type="hidden" name="providers_json" id="providersJson" value="">
          <input type="hidden" name="provider_auths_json" id="providerAuthsJson" value="">
          <input type="hidden" name="tools_json" id="toolsJson" value="">
        </div>

        <div style="display:flex;gap:8px;">
          <button type="submit">Create tenant</button>
          <a href="/tenants" class="btn secondary">Cancel</a>
        </div>
      </form>
      <script>
        const PROVIDERS = ${JSON.stringify(Object.fromEntries(knownProviders.map(p => [p.key, p])))};
        const SCOPE_PROVIDERS = ${JSON.stringify(scopeProviders)};
        const tenantField = document.getElementById('tenant');
        const blocks = Array.from(document.querySelectorAll('.provider-block'));

        // Returns the current scope (either typed or selected) and whether it's an existing tenant.
        function getCurrentScope() {
          const tSelect = document.getElementById('tenant_select');
          const selected = tSelect && tSelect.value ? tSelect.value : '';
          const typed = tenantField.value.trim();
          return { scope: selected || typed, isExisting: !!selected };
        }

        // Show/hide a provider's detail panel based on its checkbox, and refresh
        // its "reusing existing connection" notice for the current scope.
        function updateBlock(block) {
          const key = block.dataset.provider;
          const authType = block.dataset.authType;
          const check = block.querySelector('.provider-check');
          const detail = block.querySelector('.provider-detail');
          if (!detail) return;
          detail.style.display = check.checked ? "" : "none";

          const { scope } = getCurrentScope();
          const existingConnLabel = (SCOPE_PROVIDERS[scope] || {})[key + ':' + authType];
          const reusing = !!existingConnLabel;
          const credRow = block.querySelector('.cred-row');
          const notice = block.querySelector('.reusing-notice');
          if (credRow && notice) {
            const credInput = credRow.querySelector('.cred-input');
            if (reusing) {
              credRow.querySelectorAll('a, .field-hint').forEach(el => el.style.display = "none");
              credInput.style.display = "none";
              notice.style.display = "";
              notice.querySelector('.reusing-label').textContent = existingConnLabel;
              const rotate = notice.querySelector('.rotate-link');
              if (rotate) rotate.onclick = (e) => {
                e.preventDefault();
                credInput.style.display = "";
                credInput.placeholder = key === "hubspot"
                  ? "Paste a new HubSpot Private App access token here (rotates credential)"
                  : (key === "attio"
                    ? "Paste a new Attio access token here (rotates credential)"
                    : (key === "clay"
                      ? "Paste a new Clay API key here (rotates credential)"
                      : (key === "heyreach"
                        ? "Paste a new HeyReach Public API key here (rotates credential)"
                        : (key === "railway"
                          ? "Paste a new Railway Project Token here (rotates credential)"
                          : (key === "resend"
                            ? "Paste a new Resend API key here (rotates credential)"
                            : "Paste a new " + (PROVIDERS[key] ? PROVIDERS[key].label : key) + " token here (rotates credential)")))));
                credInput.focus();
                notice.style.display = "none";
              };
            } else {
              credRow.querySelectorAll('a, .field-hint').forEach(el => el.style.display = "");
              credInput.style.display = "";
              notice.style.display = "none";
            }
          }
        }

        function updateAllBlocks() { blocks.forEach(updateBlock); }

        blocks.forEach((block) => {
          block.querySelector('.provider-check').addEventListener('change', () => updateBlock(block));
        });

        document.getElementById('wizForm').addEventListener('submit', (e) => {
          const selectedProviders = [];
          const selectedProviderAuths = [];
          const toolsMap = {};
          blocks.forEach((block) => {
            const check = block.querySelector('.provider-check');
            if (!check.checked) return;
            if (check.disabled || block.dataset.implemented === 'false') return;
            const key = block.dataset.provider;
            const authType = block.dataset.authType;
            selectedProviders.push(key);
            selectedProviderAuths.push({ provider: key, authType });
            toolsMap[key + ':' + authType] = Array.from(block.querySelectorAll('.tool-check:checked')).map(i => i.value);
          });
          if (selectedProviders.length === 0) {
            e.preventDefault();
            alert('Select at least one provider.');
            return;
          }
          document.getElementById('providersJson').value = JSON.stringify(selectedProviders);
          document.getElementById('providerAuthsJson').value = JSON.stringify(selectedProviderAuths);
          document.getElementById('toolsJson').value = JSON.stringify(toolsMap);
        });
        updateAllBlocks();

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
              // Re-evaluate credential reuse: a chosen provider may have an
              // existing connection for this scope, which means we don't need
              // to ask for a new credential.
              updateAllBlocks();
            }
          });
        }
        tenantInput.addEventListener('input', () => {
          if (tenantSelect) tenantSelect.value = '';
          // Tenant name changed: re-evaluate reuse too (user might be typing
          // a name that matches an existing scope).
          updateAllBlocks();
        });
        // User-typed agent names should not be overwritten by auto-suggest.
        agentInput.addEventListener('input', () => {
          if (agentInput.value) agentInput.dataset.autoSuggested = '';
        });
      </script>
    </main></body></html>
  `);
});

// --- /tenants/new POST handler ---
dashboardApp.post("/tenants/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const body = await c.req.parseBody();
  // Tenant resolution: text input wins over dropdown selection.
  const tenantText = String(body.tenant ?? "").trim();
  const tenantSelect = String(body.tenant_select ?? "").trim();
  const tenant = tenantText || tenantSelect;
  // Optional human-facing name; the slug stays the immutable wire key.
  const tenantDisplayName = String(body.display_name ?? "").trim();
  // Additional scopes the role should allow (comma-separated).
  const additionalScopesRaw = String(body.additional_scopes ?? "").trim();
  const additionalScopes = additionalScopesRaw
    ? additionalScopesRaw.split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9_-]+$/.test(s))
    : [];
  const agent = String(body.agent ?? "").trim();
  const agentDesc = String(body.agent_desc ?? "").trim();

  // --- Multi-provider parsing ---
  // The wizard submits the chosen providers as a JSON array (providers_json)
  // and the per-provider tool selection as a JSON object map (tools_json:
  // { providerKey: ["tool", ...] }). Per-provider credentials arrive in
  // separate fields named credential_<providerKey>. JSON blobs are used
  // because Hono's parseBody keeps only the last value for repeated keys.
  let providers: string[] = [];
  let providerAuths: Array<{ provider: string; authType: string }> = [];
  const providerAuthsJson = String(body.provider_auths_json ?? "").trim();
  if (providerAuthsJson) {
    try {
      const parsed = JSON.parse(providerAuthsJson);
      if (Array.isArray(parsed)) {
        providerAuths = parsed
          .map((item) => ({
            provider: String(item?.provider ?? "").trim(),
            authType: String(item?.authType ?? item?.auth_type ?? "").trim(),
          }))
          .filter((item) => item.provider && item.authType);
      }
    } catch { providerAuths = []; }
  }
  const providersJson = String(body.providers_json ?? "").trim();
  if (providersJson) {
    try { providers = JSON.parse(providersJson); } catch { providers = []; }
  }
  // Backwards-compat: a single `provider` field still works.
  if (providers.length === 0 && body.provider) {
    providers = [String(body.provider).trim()];
  }
  if (providers.length === 0 && providerAuths.length > 0) {
    providers = providerAuths.map((item) => item.provider);
  }
  providers = Array.from(new Set(providers.map((p) => String(p).trim()).filter(Boolean)));
  if (providerAuths.length === 0) {
    providerAuths = providers.map((provider) => {
      const providerDef = getProvider(provider);
      return {
        provider,
        authType: providerDef?.authTypes.includes("oauth") && !providerDef.authTypes.includes("pat") ? "oauth" : "pat",
      };
    });
  }
  providerAuths = Array.from(
    new Map(providerAuths.map((item) => [`${item.provider}:${item.authType}`, item])).values()
  );

  // Per-provider tool selection map.
  let toolsByProvider: Record<string, string[]> = {};
  const toolsJson = String(body.tools_json ?? "").trim();
  if (toolsJson) {
    try {
      const parsed = JSON.parse(toolsJson);
      if (Array.isArray(parsed)) {
        // Legacy flat array — applies to the single selected provider.
        if (providers.length === 1) toolsByProvider[providers[0]] = parsed.map(String);
      } else if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v)) toolsByProvider[k] = v.map(String);
        }
      }
    } catch { toolsByProvider = {}; }
  }
  // Resolve the credential for a given provider (per-provider field first,
  // falling back to the legacy single `credential` field when there's one provider).
  const credentialFor = (p: string, authType = "pat") => {
    const specificAuth = String((body as any)[`credential_${p}_${authType}`] ?? "").trim();
    if (specificAuth) return specificAuth;
    const specific = String((body as any)[`credential_${p}`] ?? "").trim();
    if (specific) return specific;
    if (providerAuths.length === 1) return String(body.credential ?? "").trim();
    return "";
  };
  console.log("[tenants/new POST] tenant=", tenant, "providerAuths=", providerAuths);

  if (!/^[a-z0-9_-]+$/.test(tenant)) return c.html("<h1>invalid tenant id</h1>", 400);
  if (!agent) return c.html("<h1>agent name required</h1>", 400);
  if (additionalScopesRaw && additionalScopes.length === 0) {
    return c.html("<h1>additional_scopes must be lowercase a-z, 0-9, hyphens, underscores (comma-separated)</h1>", 400);
  }
  if (providers.length === 0) return c.html("<h1>select at least one provider</h1>", 400);
  if (providerAuths.length === 0) return c.html("<h1>select at least one provider</h1>", 400);
  for (const item of providerAuths) {
    const providerDef = getProvider(item.provider);
    if (!providerDef) return c.html(`<h1>unknown provider: ${escapeHtml(item.provider)}</h1>`, 400);
    if (providerDef.implemented === false) return c.html(`<h1>provider not implemented: ${escapeHtml(providerDef.label)}</h1>`, 400);
    if (!providerDef.authTypes.includes(item.authType as any)) {
      return c.html(`<h1>auth type not supported: ${escapeHtml(item.provider)} / ${escapeHtml(item.authType)}</h1>`, 400);
    }
  }

  // Check for agent name conflict up front so we can return a clean error
  // instead of letting Prisma's P2002 bubble up as a generic 500.
  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Agent name taken — grantry</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>⚠️  Agent name <code>${escapeHtml(agent)}</code> already exists</h1>
        <div class="card" style="border-color:#ff6b6b;">
          <p>Agent names are globally unique. Someone already created an agent with this name (created ${existingAgent.createdAt.toISOString().slice(0,10)}).</p>
          <p><b>Options:</b></p>
          <ul>
            <li>Pick a different agent name (e.g. <code>${escapeHtml(agent)}-v2</code>, <code>${escapeHtml(agent)}-${Date.now().toString(36).slice(-4)}</code>)</li>
            <li><a href="/agents/${existingAgent.id}">Reuse the existing agent</a> and rotate its token instead</li>
            <li><a href="/tenants/new">← Back to wizard</a></li>
          </ul>
        </div>
        <p style="color:#8a8d93;font-size:13px;">Why globally unique? Agent names double as the agent's display ID in audit logs and MCP routing. <a href="https://github.com/gentityapp/grantry/issues/new">file an issue</a> if you want per-user uniqueness.</p>
      </main></body></html>
    `, 409);
  }

  // Per-user role naming: each user gets their own role row for a given
  // tenant scope. The role NAME is just an internal label; the
  // `allowedScopes` field is what actually controls access. So two users
  // can both have a tenant called `grantry-dev` without colliding —
  // each gets role `grantry-dev-dev-${userIdShort}`.
  const userIdShort = user.id.slice(0, 8);
  const roleName = `${tenant}-dev-${userIdShort}`;

  // Tenant (= scope) names are still globally unique on connections, but
  // we don't need to enforce it at the role layer. If you really did own
  // a connection with the same scope from a previous account, you'd get
  // a separate conflict on the connection create — but that's your own
  // legacy data, not another user's.

  // 0) Materialize the tenant entity up front, before any connections. The
  //    OAuth callback later upserts the same (ownerId, slug) and would lose
  //    the display name, so it must be recorded here.
  const tenantRow = await ensureTenant(user.id, tenant, tenantDisplayName);

  // 1) Resolve each selected provider into either an immediate connection
  //    (PAT pasted, or an existing connection we reuse) or an OAuth step that
  //    must be authorized via a redirect. OAuth providers are queued and
  //    authorized one-by-one after the tenant scaffolding (role + PAT
  //    connections) is in place; the agent + token are minted at the very end
  //    of that chain. (MUST filter connection lookups by ownerId — otherwise
  //    user B could inherit user A's credential.)
  const connections: Array<{ label: string; scope: string; provider: string }> = [];
  const oauthQueue: string[] = [];
  for (const { provider, authType } of providerAuths) {
    const providerDef = getProvider(provider)!; // validated above
    const credential = authType === "pat" ? credentialFor(provider, authType) : "";

    const existingConn = await prisma.connection.findFirst({
      where: { provider, authType, scope: tenant, ownerId: user.id },
    });

    // Decide how to authenticate this provider:
    //   - credential pasted           -> create/rotate a PAT connection now
    //   - existing connection, no cred -> reuse as-is
    //   - supports OAuth, no cred      -> queue for OAuth authorization
    //   - PAT-only, no cred, no conn   -> error
    if (credential) {
      const credentialMeta = await credentialMetadataForStorage(provider, "pat", credential);
      const conn = existingConn
        ? await prisma.connection.update({
            where: { id: existingConn.id },
            data: { encryptedCredential: encrypt(credential), refreshToken: null, accessTokenExpiresAt: null, ...credentialMeta },
          })
        : await prisma.connection.create({
            data: {
              provider,
              authType: "pat",
              label: `${provider}-${tenant}-pat`,
              scope: tenant,
              tenantId: tenantRow.id,
              ownerId: user.id,
              encryptedCredential: encrypt(credential),
              ...credentialMeta,
            },
          });
      connections.push(conn);
    } else if (existingConn) {
      connections.push(existingConn);
    } else if (authType === "oauth" && providerDef.authTypes.includes("oauth")) {
      oauthQueue.push(provider);
    } else {
      return c.html(`<h1>credential required for ${escapeHtml(providerDef.label)}</h1>`, 400);
    }
  }

  // 2) Find or create role. Reuse existing ${tenant}-dev if present.
  // This way, running the wizard twice for the same tenant doesn't create
  // an orphan role; the new agent gets bound to the same role as before.
  //
  // allowedScopes logic:
  //   - Always pin new roles to [tenant, ...additionalScopes].
  //   - Empty [] still means "any scope" for legacy rows, but new rows should
  //     not use it by default because it broadens every future connection.
  // Union of every selected provider's chosen tools (falling back to that
  // provider's full tool set when the wizard sent no explicit selection).
  const desiredTools = Array.from(new Set(
    providerAuths.flatMap(({ provider, authType }) => {
      const t = toolsByProvider[`${provider}:${authType}`] ?? toolsByProvider[provider];
      return t && t.length > 0 ? t : toolsForProvider(provider);
    })
  ));
  // Decide the initial allowedScopes for a NEW role.
  const initialAllowedScopes = additionalScopes.length > 0
    ? Array.from(new Set([tenant, ...additionalScopes]))
    : [tenant];

  // roleName is globally unique (it encodes the owner via the per-user suffix),
  // so look it up by name alone — filtering by ownerId could miss it and fall
  // through to create(), hitting the unique constraint as an uncaught 500.
  let role = await prisma.role.findUnique({ where: { name: roleName } });
  if (role) {
    // Merge: keep existing scopes (don't shrink), union tools.
    const existingTools = safeJsonArray(role.allowedTools);
    const existingScopes = safeJsonArray(role.allowedScopes);
    const mergedTools = Array.from(new Set([...existingTools, ...desiredTools]));
    let mergedScopes: string[];
    if (existingScopes.length === 0) {
      mergedScopes = initialAllowedScopes;
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
        description: `Role for tenant '${tenant}' (per-user) — providers: ${providerAuths.map((item) => `${item.provider}:${item.authType}`).join(", ")}`,
        allowedTools: JSON.stringify(desiredTools),
        allowedScopes: JSON.stringify(initialAllowedScopes),
        ownerId: user.id,
      },
    });
  }

  // If any selected providers still need OAuth authorization, defer agent
  // creation and kick off the OAuth chain. The role (with all tools/scopes)
  // already exists, so each callback only attaches its connection; the final
  // callback mints the agent + token and shows the success page.
  if (oauthQueue.length > 0) {
    const [first, ...rest] = oauthQueue;
    const params = new URLSearchParams({
      tenant,
      tenant_select: tenantSelect,
      additional_scopes: additionalScopes.join(","),
      agent,
      agent_desc: agentDesc,
      tools_json: JSON.stringify(desiredTools),
      oauth_queue: rest.join(","),
    });
    return c.redirect(`/oauth/${first}/start?${params.toString()}`);
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
    <!doctype html><html><head><meta charset="utf-8"><title>Tenant created — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Tenant <code>${tenant}</code> created</h1>
      <div class="card">
        <h2>Connections (${connections.length})</h2>
        ${connections.map((cn) => `<p><code>${escapeHtml(cn.label)}</code> · scope=<code>${escapeHtml(cn.scope)}</code></p>`).join("")}
      </div>
      <div class="card">
        <h2>Role</h2>
        <p><code>${role.name}</code> · allowed_scopes=<code>${safeJsonArray(role.allowedScopes).join(", ") || "any"}</code> · ${JSON.parse(role.allowedTools).length} tools</p>
      </div>
      <div class="card">
        <h2>Agent</h2>
        <p><code>${agentRow.name}</code> · bound to <code>${role.name}</code></p>
      </div>
      ${agentTokenCard(token, "⚠️  Save this token now. You won't see it again. Revoke and re-mint in <a href=\"/agents\">/agents</a> if lost.")}
      ${mcpConfigCard(publicOrigin(c), agentRow.name, token, true, tenant)}
      <div class="card">
        <h2>Test it</h2>
        <pre>curl -X POST ${publicOrigin(c)}/mcp \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'</pre>
        ${providers.includes("notion") ? `
        <pre>curl -X POST ${publicOrigin(c)}/mcp \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notion/list_dbs","arguments":{"scope":"${tenant}"}}}'</pre>
        ` : ""}
      </div>
      <p><a href="/tenants">← Back to tenants</a> · <a href="/agents">Manage agents</a></p>
    </main></body></html>
  `);
});

// --- /agents ---
dashboardApp.get("/agents", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const agents = await prisma.agent.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    include: { roles: { include: { role: true } } },
  });
  const roles = await prisma.role.findMany({ where: { ownerId: user.id }, orderBy: { name: "asc" } });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Agents — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
    <main>
      <div class="row spread" style="margin-bottom:16px;">
        <h1 style="margin:0;">Agents</h1>
        <a href="/agents/new" class="btn">+ New agent</a>
      </div>
      <form method="post" action="/agents/bulk-delete" id="bulkAgentForm">
        <input type="hidden" name="agent_ids_csv" id="agentIdsCsv" value="">
        <div class="row spread" style="margin-bottom:8px;">
          <label style="font-size:13px;color:#c8ccd2;cursor:pointer;"><input type="checkbox" id="selAllAgents"> select all</label>
          <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" id="bulkAgentBtn" disabled>🗑 Delete selected (0)</button>
        </div>
      </form>
      ${agents.length === 0 ? '<div class="card"><div class="empty">No agents yet. <a href="/tenants/new">Create one via the tenant wizard</a>.</div></div>' : `
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
              ? '<span class="badge denied" title="Legacy broad access: this role can use any of your enabled connection scopes">any</span>'
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
                    <form method="post" action="/agents/${a.id}/bind">
                      <div style="margin-bottom:6px; font-size:12px; color:#8a8d93;">Replace bindings with:</div>
                      <select name="role_id" style="margin-bottom:6px; font-size:12px; padding:4px; width:100%;">
                        ${roles.map((r) => `<option value="${r.id}">${r.name} (scopes: ${safeJsonArray(r.allowedScopes).join(", ") || "any"})</option>`).join("")}
                      </select>
                      <button type="submit" style="font-size:12px; padding:4px 10px; width:100%;">Bind</button>
                    </form>
                  </div>
                </details>
                <form method="post" action="/agents/${a.id}/rotate" style="display:inline;" onsubmit="return confirm('Rotate token for ${a.name}?\\n\\nThe OLD token will be invalidated immediately. The NEW token will be shown ONCE on the next page.')">
                  <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;">Rotate</button>
                </form>
                <a href="/agents/${a.id}" class="btn secondary" style="font-size:12px;padding:4px 10px;">Details</a>
                <form method="post" action="/agents/${a.id}/delete" style="display:inline;" onsubmit="return confirm('Delete agent ${a.name}?\\n\\nThis permanently destroys its token. The role(s) it was bound to are not deleted.')">
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

// --- /agents/new — cross-tenant agent over existing tenants ---
// The dual of the tenant wizard: instead of tenant → role → agent, this flow
// starts from the agent and grants it existing tenants. One dedicated role is
// auto-created per agent (1:1), so the user never manages roles directly and
// broadening it never affects other agents. Registered before /agents/:id so
// the static segment wins the route match.
dashboardApp.get("/agents/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const [tenants, connections] = await Promise.all([
    prisma.tenant.findMany({ where: { ownerId: user.id }, orderBy: { slug: "asc" } }),
    prisma.connection.findMany({
      where: { ownerId: user.id, enabled: true, scope: { not: "" } },
      select: { provider: true, scope: true },
      orderBy: { provider: "asc" },
    }),
  ]);

  const providersByScope = new Map<string, string[]>();
  for (const cn of connections) {
    const def = getProvider(cn.provider);
    if (!def || def.implemented === false) continue;
    const list = providersByScope.get(cn.scope) ?? [];
    if (!list.includes(cn.provider)) list.push(cn.provider);
    providersByScope.set(cn.scope, list);
  }

  // Union of providers across every tenant — the tool set a full-tenant
  // manager (allowedScopes = []) can reach.
  const allProviders: string[] = [];
  for (const list of providersByScope.values()) {
    for (const p of list) if (!allProviders.includes(p)) allProviders.push(p);
  }
  allProviders.sort();

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>New agent — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents")}
    <main>
      <h1>+ New agent</h1>
      <p style="color:#8a8d93;margin-top:-16px;margin-bottom:24px;">
        Create an agent that spans <b>existing</b> tenants — e.g. a manager that reads several business areas with one token.
        To create a new tenant, use the <a href="/tenants/new">tenant wizard</a> instead.
      </p>
      ${tenants.length === 0 ? `<div class="card"><div class="empty">No tenants yet. <a href="/tenants/new">Create one first</a>.</div></div>` : `
      <form method="post" action="/agents/new" id="agentForm">
        <input type="hidden" name="scopes_json" id="scopesJson" value="[]">
        <input type="hidden" name="tools_json" id="toolsJson" value="[]">
        <input type="hidden" name="manager_mode" id="managerModeInput" value="0">

        <div class="card">
          <h2>Agent</h2>
          <label for="agent">Agent name</label>
          <input type="text" name="agent" id="agent" pattern="[a-zA-Z0-9_-]+" placeholder="manager-ai" autofocus required>
          <label for="agent_desc" style="margin-top:8px;">Description</label>
          <input type="text" name="agent_desc" id="agent_desc" placeholder="e.g. 経営横断レポート用">
        </div>

        <div class="card" style="border:1px solid rgba(240,180,41,0.45);">
          <label style="cursor:pointer;display:flex;align-items:flex-start;gap:10px;font-weight:600;">
            <input type="checkbox" id="managerToggle" style="transform:scale(1.3);margin-top:3px;">
            <span>
              Full-tenant manager
              <div class="field-hint" style="margin-top:4px;font-weight:normal;">
                Reach <b>all</b> your tenants with one token — including tenants you create later.
                Equivalent to <code>allowed_scopes = []</code> (any scope). Owner-bounded: only ever your own connections.
              </div>
            </span>
          </label>
        </div>

        <div id="tenantSection">
          <h2>Tenant access</h2>
          <p class="field-hint" style="margin-top:-8px;">
            Check the tenants this agent may reach, then untick any tools it should not use.
            Tool permissions apply role-wide: if the same provider is connected in two selected tenants, its tools are allowed in both.
          </p>
          ${tenants.map((t) => {
            const providers = providersByScope.get(t.slug) ?? [];
            const showName = t.displayName && t.displayName !== t.slug;
            return `
          <div class="card">
            <h2 style="margin-bottom:4px;">
              <label style="cursor:pointer;">
                <input type="checkbox" class="tenantCheck" value="${t.slug}" style="margin-right:8px;transform:scale(1.2);">
                ${showName ? `${escapeHtml(t.displayName)} ` : ""}<span class="badge scoped">${t.slug}</span>
              </label>
            </h2>
            ${providers.length === 0 ? `<div class="empty" style="padding:8px 0;">No enabled connections — selecting this tenant grants nothing.</div>` : providers.map((p) => `
            <div style="margin:10px 0 0 28px;">
              <code>${p}</code>
              <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;">
                ${toolsForProvider(p).map((tool) => `
                <label style="cursor:pointer;font-size:13px;white-space:nowrap;">
                  <input type="checkbox" class="toolCheck" data-scope="${t.slug}" value="${tool}" checked>
                  <code>${tool.split("/")[1] ?? tool}</code>
                </label>`).join("")}
              </div>
            </div>`).join("")}
          </div>`;
          }).join("")}
        </div>

        <div id="managerSection" style="display:none;">
          <div class="card" style="background:rgba(229,83,75,0.10);border:1px solid rgba(229,83,75,0.5);">
            <h2 style="color:#e5534b;margin-top:0;">⚠ Full-tenant access</h2>
            <p style="margin-top:0;">
              This token can call the selected tools against <b>every tenant you own — now and in the future</b>.
              If it leaks, your entire footprint is exposed at once. It also appears under
              <a href="/meta">Meta → Broad or unused roles</a> as <span class="badge denied">any-scope</span>.
            </p>
            <label style="cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;">
              <input type="checkbox" id="managerConfirm" name="manager_confirm" style="transform:scale(1.2);">
              I understand this agent reaches all my tenants, present and future.
            </label>
          </div>
          <div class="card">
            <h2>Tools</h2>
            ${allProviders.length === 0 ? '<div class="empty">No enabled connections in any tenant.</div>' : allProviders.map((p) => `
            <div style="margin:10px 0 0 0;">
              <code>${p}</code>
              <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;">
                ${toolsForProvider(p).map((tool) => `
                <label style="cursor:pointer;font-size:13px;white-space:nowrap;">
                  <input type="checkbox" class="managerToolCheck" value="${tool}" checked>
                  <code>${tool.split("/")[1] ?? tool}</code>
                </label>`).join("")}
              </div>
            </div>`).join("")}
          </div>
        </div>

        <div class="card" style="background:rgba(110,168,254,0.08);">
          <h2>👁 What this agent will be able to do</h2>
          <p id="previewText" style="margin-bottom:0;color:#8a8d93;">Select at least one tenant above.</p>
        </div>

        <button type="submit" id="createBtn" disabled>🔑 Create agent &amp; mint token</button>
        <p class="field-hint">A dedicated role is created for this agent automatically. The token is shown once, right after creation.</p>
      </form>
      <script>
        const managerToggle = document.getElementById('managerToggle');
        const managerConfirm = document.getElementById('managerConfirm');
        const managerToolChecks = Array.from(document.querySelectorAll('.managerToolCheck'));
        const tenantSection = document.getElementById('tenantSection');
        const managerSection = document.getElementById('managerSection');
        const managerModeInput = document.getElementById('managerModeInput');
        const tenantChecks = Array.from(document.querySelectorAll('.tenantCheck'));
        const toolChecks = Array.from(document.querySelectorAll('.toolCheck'));
        const previewText = document.getElementById('previewText');
        const createBtn = document.getElementById('createBtn');
        const scopesJson = document.getElementById('scopesJson');
        const toolsJson = document.getElementById('toolsJson');
        function updateAgentPreview() {
          const manager = managerToggle.checked;
          managerModeInput.value = manager ? '1' : '0';
          tenantSection.style.display = manager ? 'none' : '';
          managerSection.style.display = manager ? '' : 'none';
          if (manager) {
            const tools = managerToolChecks.filter(c => c.checked).map(c => c.value);
            scopesJson.value = '[]';
            toolsJson.value = JSON.stringify(tools);
            createBtn.textContent = '🔑 Create full-tenant manager & mint token';
            if (!managerConfirm.checked) {
              previewText.textContent = 'Tick the confirmation above to enable creation.';
              createBtn.disabled = true;
            } else if (tools.length === 0) {
              previewText.textContent = 'Select at least one tool.';
              createBtn.disabled = true;
            } else {
              previewText.innerHTML = '<b>Full-tenant manager</b> — ' + tools.length + ' tools across <b>all</b> tenants (any scope, incl. future). The MCP config has no scope lock; pass <code>scope</code> per call.';
              createBtn.disabled = false;
            }
            return;
          }
          createBtn.textContent = '🔑 Create agent & mint token';
          const scopes = tenantChecks.filter(c => c.checked).map(c => c.value);
          const tools = [];
          const perScope = {};
          toolChecks.forEach(t => {
            const on = scopes.includes(t.dataset.scope);
            t.disabled = !on;
            t.closest('label').style.opacity = on ? '1' : '0.45';
            if (on && t.checked) {
              if (!tools.includes(t.value)) tools.push(t.value);
              perScope[t.dataset.scope] = (perScope[t.dataset.scope] || 0) + 1;
            }
          });
          scopesJson.value = JSON.stringify(scopes);
          toolsJson.value = JSON.stringify(tools);
          if (scopes.length === 0) {
            previewText.textContent = 'Select at least one tenant above.';
            createBtn.disabled = true;
          } else {
            const parts = scopes.map(s => s + ' (' + (perScope[s] || 0) + ' tools)');
            previewText.innerHTML = 'Scopes: ' + parts.join(' · ') + ' — ' + tools.length + ' tools total. The MCP config has no scope lock; pass <code>scope</code> per call.';
            createBtn.disabled = tools.length === 0;
          }
        }
        managerToggle.addEventListener('change', updateAgentPreview);
        managerConfirm.addEventListener('change', updateAgentPreview);
        managerToolChecks.forEach(c => c.addEventListener('change', updateAgentPreview));
        tenantChecks.forEach(c => c.addEventListener('change', updateAgentPreview));
        toolChecks.forEach(c => c.addEventListener('change', updateAgentPreview));
        updateAgentPreview();
      </script>
      `}
      <p><a href="/agents">← Back to agents</a></p>
    </main></body></html>
  `);
});

dashboardApp.post("/agents/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const body = await c.req.parseBody();
  const agent = String(body.agent ?? "").trim();
  const agentDesc = String(body.agent_desc ?? "").trim();
  const managerMode = String(body.manager_mode ?? "") === "1";
  let scopes: string[] = [];
  let tools: string[] = [];
  try { scopes = (JSON.parse(String(body.scopes_json ?? "[]")) as unknown[]).map(String); } catch { scopes = []; }
  try { tools = (JSON.parse(String(body.tools_json ?? "[]")) as unknown[]).map(String); } catch { tools = []; }
  scopes = Array.from(new Set(scopes.filter((s) => /^[a-z0-9_-]+$/.test(s))));

  if (!agent || !/^[a-zA-Z0-9_-]+$/.test(agent)) return c.html("<h1>agent name required (alphanumeric, hyphens, underscores)</h1>", 400);

  // `availableProviders` is the set of providers whose tools may be granted.
  // Manager mode: allowedScopes = [] (any scope, incl. future tenants), tools
  // drawn from every tenant. Normal mode: tools confined to the chosen tenants.
  let availableProviders: Set<string>;
  if (managerMode) {
    if (String(body.manager_confirm ?? "") !== "on") {
      return c.html("<h1>confirm full-tenant access to create a manager</h1>", 400);
    }
    scopes = []; // any scope
    const conns = await prisma.connection.findMany({
      where: { ownerId: user.id, enabled: true, scope: { not: "" } },
      select: { provider: true },
    });
    availableProviders = new Set(conns.map((cn) => cn.provider));
  } else {
    if (scopes.length === 0) return c.html("<h1>select at least one tenant</h1>", 400);

    // Every requested scope must be one of the caller's own tenants.
    const ownTenants = await prisma.tenant.findMany({
      where: { ownerId: user.id, slug: { in: scopes } },
      select: { slug: true },
    });
    if (ownTenants.length !== scopes.length) {
      const owned = new Set(ownTenants.map((t) => t.slug));
      const missing = scopes.filter((s) => !owned.has(s));
      return c.html(`<h1>unknown tenant(s): ${escapeHtml(missing.join(", "))}</h1>`, 400);
    }

    const conns = await prisma.connection.findMany({
      where: { ownerId: user.id, enabled: true, scope: { in: scopes } },
      select: { provider: true },
    });
    availableProviders = new Set(conns.map((cn) => cn.provider));
  }

  // Tools must be real tools of providers with an enabled connection in scope.
  tools = Array.from(new Set(tools)).filter((t) => {
    const p = t.includes("/") ? t.split("/", 1)[0] : "";
    const def = getProvider(p);
    return !!def && def.implemented !== false && availableProviders.has(p) && toolsForProvider(p).includes(t);
  });
  if (tools.length === 0) return c.html(`<h1>select at least one tool${managerMode ? "" : " available in the chosen tenants"}</h1>`, 400);

  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`<h1>⚠️ Agent name <code>${escapeHtml(agent)}</code> already exists</h1><p>Pick a different name, or <a href="/agents/${existingAgent.id}">reuse the existing agent</a>. <a href="/agents/new">← Back</a></p>`, 409);
  }

  // Dedicated 1:1 role, named after the agent. Role names are globally
  // unique, so suffix with the user id (same convention as the wizard).
  const userIdShort = user.id.slice(0, 8);
  let roleName = `${agent}-${userIdShort}`;
  const roleClash = await prisma.role.findUnique({ where: { name: roleName } });
  if (roleClash && roleClash.ownerId !== user.id) {
    roleName = `${agent}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
  }
  const role = roleClash && roleClash.ownerId === user.id
    ? await prisma.role.update({
        where: { id: roleClash.id },
        data: { allowedTools: JSON.stringify(tools), allowedScopes: JSON.stringify(scopes), description: agentDesc || null },
      })
    : await prisma.role.create({
        data: {
          name: roleName,
          description: agentDesc || `Dedicated role for agent ${agent}`,
          allowedTools: JSON.stringify(tools),
          allowedScopes: JSON.stringify(scopes),
          ownerId: user.id,
        },
      });

  const token = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then((m) => m.createHash("sha256").update(token).digest("hex"));
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
    <!doctype html><html><head><meta charset="utf-8"><title>Agent created — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents")}
    <main>
      <h1>✓ Agent <code>${escapeHtml(agentRow.name)}</code> created</h1>
      <div class="card">
        <h2>Access</h2>
        <p>${managerMode ? `<span class="badge denied">all tenants (any scope, incl. future)</span>` : `Scopes: ${scopes.map((s) => `<span class="badge scoped">${s}</span>`).join(" ")}`} · ${tools.length} tools via dedicated role <code>${escapeHtml(role.name)}</code></p>
      </div>
      ${agentTokenCard(token)}
      ${mcpConfigCard(publicOrigin(c), agentRow.name, token, true)}
      <div class="card">
        <h2>Cross-tenant calls</h2>
        <p class="field-hint" style="margin-top:0;">This config has <b>no</b> <code>X-Grantry-Scope</code> lock. Pass the target tenant per call:</p>
        <pre>curl -X POST ${publicOrigin(c)}/mcp \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${tools[0]}","arguments":{"scope":"${scopes[0] ?? "&lt;any-of-your-tenants&gt;"}"}}}'</pre>
      </div>
      <p><a href="/agents">← Back to agents</a></p>
    </main></body></html>
  `);
});

// --- /agents/:id — agent detail + Codex MCP config ---
dashboardApp.get("/agents/:id", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const id = c.req.param("id");
  const agent = await prisma.agent.findUnique({
    where: { id },
    include: { roles: { include: { role: true } } },
  });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  const connections = await connectionsForAgent(agent.id);
  const scopeSet = new Set<string>();
  for (const conn of connections) {
    scopeSet.add(conn.scope);
  }
  const scopes = Array.from(scopeSet).sort();
  const tokenPlaceholder = `${agent.tokenPrefix}...ROTATE_TO_VIEW_FULL_TOKEN`;

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(agent.name)} — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
    <main>
      <h1>Agent <code>${escapeHtml(agent.name)}</code></h1>
      <div class="card">
        <h2>Binding</h2>
        <p>Status: ${agent.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</p>
        <p>Token prefix: <code>${escapeHtml(agent.tokenPrefix)}...</code></p>
        <p>Roles: ${agent.roles.length
          ? agent.roles.map((ar) => `<span class="tool-pill">${escapeHtml(ar.role.name)}</span>`).join(" ")
          : '<em style="color:#ff6b6b;">no role bound</em>'}</p>
        <p>Accessible tenants: ${scopeSet.size
          ? Array.from(scopeSet).sort().map((s) => `<span class="badge scoped">${escapeHtml(s)}</span>`).join(" ")
          : '<span class="badge denied">none</span>'}</p>
      </div>
      <div class="card">
        <h2>Callable connections</h2>
        ${connections.length === 0 ? '<div class="empty">No enabled connection is callable by this agent. Check role scopes, role tools, and tenant connections.</div>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Tenant</th><th>Provider</th><th>Auth</th><th>Label</th><th>Tools</th></tr></thead>
            <tbody>
              ${connections.map((conn) => `
                <tr>
                  <td><code>${escapeHtml(conn.scope)}</code></td>
                  <td><code>${escapeHtml(conn.provider)}</code></td>
                  <td><code>${escapeHtml(conn.authType)}</code></td>
                  <td>${escapeHtml(conn.label)}</td>
                  <td>${conn.tools.map((t) => `<span class="tool-pill">${escapeHtml(t)}</span>`).join(" ")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>`}
      </div>
      ${scopes.length
        ? scopes.map((scope) => mcpConfigCard(publicOrigin(c), agent.name, tokenPlaceholder, false, scope)).join("")
        : mcpConfigCard(publicOrigin(c), agent.name, tokenPlaceholder, false)}
      <div class="card">
        <h2>Quick checks</h2>
        <pre>curl -X POST ${publicOrigin(c)}/mcp \\
  -H "Authorization: Bearer YOUR_FULL_AGENT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</pre>
        <pre>curl -X POST ${publicOrigin(c)}/mcp \\
  -H "Authorization: Bearer YOUR_FULL_AGENT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"connections/list"}'</pre>
      </div>
      <p><a href="/agents">← Back to agents</a></p>
    </main></body></html>
  `);
});

// --- /agents/:id/bind POST (rebind to a different role) ---
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

  return c.redirect("/agents");
});

// --- /agents/:id/rotate (POST) ---
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

  const rotatedConnections = await connectionsForAgent(agent.id);
  const rotatedScopes = Array.from(new Set(rotatedConnections.map((conn) => conn.scope))).sort();

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Token rotated — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
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
      ${rotatedScopes.length
        ? rotatedScopes.map((scope) => mcpConfigCard(publicOrigin(c), agent.name, newToken, true, scope)).join("")
        : mcpConfigCard(publicOrigin(c), agent.name, newToken, true)}
      <div class="card">
        <h2>Test the new token</h2>
        <pre>curl -X POST ${publicOrigin(c)}/mcp \\
  -H "Authorization: Bearer ${newToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'</pre>
      </div>
      <p><a href="/agents">← Back to agents</a></p>
    </main></body></html>
  `);
});

// --- DEBUG: /debug/agents — dumps agent/role/connection state ---
dashboardApp.get("/debug/agents", async (c) => {
  return c.json({ error: "debug endpoint disabled; use /api/scopes" }, 410);
});

// --- /audit ---
dashboardApp.get("/audit", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const logs = await prisma.auditLog.findMany({
    where: { OR: [{ userId: user.id }, { agent: { ownerId: user.id } }] },
    take: 100,
    orderBy: { createdAt: "desc" },
    include: { agent: true },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Audit — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("audit", user?.email)}
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
  if (!user) return c.redirect("/login");

  const providerKey = c.req.param("provider");
  const providerDef = getProvider(providerKey);
  if (!providerDef || providerDef.implemented === false || !providerDef.authTypes.includes("oauth")) {
    return c.html(`<h1>unknown or non-OAuth provider: ${escapeHtml(providerKey)}</h1>`, 400);
  }
  if (!providerDef.authorizeUrl || !providerDef.oauthTokenUrl) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth not configured</h1><p>Missing <code>authorizeUrl</code> in registry. <a href="/tenants/new">← Back</a></p>`, 500);
  }

  // Per-provider env var names: GITHUB_CLIENT_ID / GOOGLE_GSC_CLIENT_ID / HUBSPOT_CLIENT_ID
  // (Simple uppercase-with-underscores convention.)
  const envPrefix = providerKey.toUpperCase();
  // Backwards compat: also accept GH_CLIENT_ID (legacy) and GRANTRY_GITHUB_CLIENT_ID
  const legacyAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_ID", "GRANTRY_GITHUB_CLIENT_ID"],
    google_gsc: ["GOOGLE_CLIENT_ID"],
    google_analytics: ["GOOGLE_CLIENT_ID"],
    google_ads: ["GOOGLE_CLIENT_ID"],
    google_drive: ["GOOGLE_CLIENT_ID"],
    gmail: ["GOOGLE_CLIENT_ID"],
    youtube: ["GOOGLE_CLIENT_ID"],
    google_calendar: ["GOOGLE_CLIENT_ID"],
    google_sheets: ["GOOGLE_CLIENT_ID"],
    google_tag_manager: ["GOOGLE_CLIENT_ID"],
    google_cloud: ["GOOGLE_CLIENT_ID"],
    bigquery: ["GOOGLE_CLIENT_ID"],
    yahoo_ads: ["YAHOO_CLIENT_ID"],
  };
  const clientId = process.env[`${envPrefix}_CLIENT_ID`]
    || (legacyAliases[providerKey] || []).map(k => process.env[k]).find(Boolean);
  if (!clientId) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth not configured</h1><p>Set <code>${envPrefix}_CLIENT_ID</code> env var. <a href="/tenants/new">← Back</a></p>`, 500);
  }
  const publicUrl = process.env.BETTER_AUTH_URL || `${publicOrigin(c)}`;

  // `reauth=1` means we're refreshing the tokens of an existing connection
  // (triggered by the "↻ Reconnect" button on the tenant edit page). In that
  // mode there is no wizard: no new agent is minted and we return to the edit
  // page once the new tokens are saved.
  const reauth = c.req.query("reauth") === "1";

  // Collect wizard data from query string
  const payload: Record<string, any> = {
    tenant: c.req.query("tenant") || "",
    tenant_select: c.req.query("tenant_select") || "",
    additional_scopes: c.req.query("additional_scopes") || "",
    agent: c.req.query("agent") || "",
    agent_desc: c.req.query("agent_desc") || "",
    tools_json: c.req.query("tools_json") || "[]",
    oauth_queue: c.req.query("oauth_queue") || "",
    connection_id: c.req.query("connection_id") || "",
    reauth,
    userId: user.id,
  };
  // Providers that require PKCE (Authorization Code + S256) for the token exchange.
  const usesPkce = providerKey === "hubspot" || providerKey === "x";
  const pkceVerifier = usesPkce ? pkceCodeVerifier() : "";
  if (pkceVerifier) {
    payload.pkce_code_verifier = pkceVerifier;
  }
  if (!/^[a-z0-9_-]+$/.test(payload.tenant)) {
    return c.html(`<h1>invalid tenant</h1><p>Tenant must match <code>[a-z0-9_-]+</code>. <a href="/tenants/new">← Back</a></p>`, 400);
  }

  // CSRF state
  const state = crypto.randomUUID().replace(/-/g, "");
  await prisma.oAuthState.create({
    data: {
      state,
      provider: providerKey,
      payload: JSON.stringify(payload),
      redirectTo: reauth ? `/tenants/${payload.tenant}/edit` : "/tenants/new",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });

  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/oauth/${providerKey}/callback`;
  // Per-provider authorize URL param tweaks
  let extraParams = "";
  if (providerKey === "github") {
    extraParams = `&allow_signup=true`;
  } else if (providerKey.startsWith("google_") || providerKey === "gmail" || providerKey === "youtube" || providerKey === "bigquery") {
    extraParams = `&access_type=offline&prompt=consent`; // request refresh_token
  } else if (providerKey === "reddit") {
    extraParams = `&duration=permanent`; // request a refresh_token (default is temporary/1h)
  }
  // Slack's OAuth v2 authorize endpoint expects a comma-separated scope list
  // (bot scopes in `scope`); most other providers use space-separated scopes.
  const scopeSeparator = providerKey === "slack" ? "," : " ";
  const scopeStr = (providerDef.oauthScopes || []).join(scopeSeparator);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopeStr,
    state,
  });
  if (pkceVerifier) {
    params.set("code_challenge", await pkceCodeChallenge(pkceVerifier));
    params.set("code_challenge_method", "S256");
  }
  return c.redirect(`${providerDef.authorizeUrl}?${params.toString()}${extraParams}`);
});

// --- /oauth/:provider/callback (GET) — handle OAuth callback for any provider ---
// Verifies state, exchanges code for token, encrypts + stores the connection,
// completes the wizard using the saved payload.
oauthApp.get("/:provider/callback", async (c) => {
 const providerKeyForError = c.req.param("provider");
 try {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login?error=oauth_session_expired");

  const providerKey = c.req.param("provider");
  const providerDef = getProvider(providerKey);
  if (!providerDef || providerDef.implemented === false) {
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
    return c.html(`<h1>OAuth state expired or invalid</h1><p>Try <a href="/tenants/new">creating the tenant</a> again.</p>`, 400);
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
    github: ["GH_CLIENT_ID", "GRANTRY_GITHUB_CLIENT_ID"],
    google_gsc: ["GOOGLE_CLIENT_ID"],
    google_analytics: ["GOOGLE_CLIENT_ID"],
    google_ads: ["GOOGLE_CLIENT_ID"],
    google_drive: ["GOOGLE_CLIENT_ID"],
    gmail: ["GOOGLE_CLIENT_ID"],
    youtube: ["GOOGLE_CLIENT_ID"],
    google_calendar: ["GOOGLE_CLIENT_ID"],
    google_sheets: ["GOOGLE_CLIENT_ID"],
    google_tag_manager: ["GOOGLE_CLIENT_ID"],
    google_cloud: ["GOOGLE_CLIENT_ID"],
    bigquery: ["GOOGLE_CLIENT_ID"],
    yahoo_ads: ["YAHOO_CLIENT_ID"],
  };
  const legacySecretAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_SECRET", "GRANTRY_GITHUB_CLIENT_SECRET"],
    google_gsc: ["GOOGLE_CLIENT_SECRET"],
    google_analytics: ["GOOGLE_CLIENT_SECRET"],
    google_ads: ["GOOGLE_CLIENT_SECRET"],
    google_drive: ["GOOGLE_CLIENT_SECRET"],
    gmail: ["GOOGLE_CLIENT_SECRET"],
    youtube: ["GOOGLE_CLIENT_SECRET"],
    google_calendar: ["GOOGLE_CLIENT_SECRET"],
    google_sheets: ["GOOGLE_CLIENT_SECRET"],
    google_tag_manager: ["GOOGLE_CLIENT_SECRET"],
    google_cloud: ["GOOGLE_CLIENT_SECRET"],
    bigquery: ["GOOGLE_CLIENT_SECRET"],
    yahoo_ads: ["YAHOO_CLIENT_SECRET"],
  };
  const clientId = process.env[`${envPrefix}_CLIENT_ID`]
    || (legacyAliases[providerKey] || []).map(k => process.env[k]).find(Boolean);
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`]
    || (legacySecretAliases[providerKey] || []).map(k => process.env[k]).find(Boolean);
  const publicUrl = process.env.BETTER_AUTH_URL || `${publicOrigin(c)}`;
  if (!clientId || !clientSecret) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth credentials missing</h1><p>Set <code>${envPrefix}_CLIENT_ID</code> and <code>${envPrefix}_CLIENT_SECRET</code> env vars.</p>`, 500);
  }
  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/oauth/${providerKey}/callback`;

  // Reddit and X authenticate the confidential client with HTTP Basic auth at
  // the token endpoint rather than client credentials in the body.
  const usesBasicAuth = providerKey === "reddit" || providerKey === "x";
  const tokenBody = new URLSearchParams({
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    state,
    grant_type: "authorization_code",
  });
  if (!usesBasicAuth) {
    tokenBody.set("client_secret", clientSecret);
  }
  const pkceVerifier = String(payload.pkce_code_verifier || "");
  if (pkceVerifier) {
    tokenBody.set("code_verifier", pkceVerifier);
  }
  const tokenHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json",
  };
  if (usesBasicAuth) {
    tokenHeaders.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  if (providerKey === "reddit") {
    tokenHeaders["User-Agent"] = "grantry/1.0 (MCP connector)";
  }
  const tokenResp = await fetch(providerDef.oauthTokenUrl!, {
    method: "POST",
    headers: tokenHeaders,
    body: tokenBody,
  });
  if (!tokenResp.ok) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} token exchange failed</h1><p>HTTP ${tokenResp.status}</p>`, 500);
  }
  const tokenJson: any = await tokenResp.json();
  if (tokenJson.error || !tokenJson.access_token) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} token exchange error</h1><pre>${escapeHtml(JSON.stringify(tokenJson, null, 2))}</pre>`, 500);
  }
  // Meta returns a short-lived token from the code exchange and issues no refresh
  // token. Swap it for a long-lived (~60 day) token so the connection stays usable.
  if (providerKey === "meta_ads") {
    try {
      const metaVersion = process.env.META_ADS_API_VERSION || "v21.0";
      const llParams = new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: clientId,
        client_secret: clientSecret,
        fb_exchange_token: tokenJson.access_token,
      });
      const llResp = await fetch(`https://graph.facebook.com/${metaVersion}/oauth/access_token?${llParams.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const llJson: any = await llResp.json();
      if (llResp.ok && llJson.access_token) {
        tokenJson.access_token = llJson.access_token;
        tokenJson.expires_in = llJson.expires_in ?? tokenJson.expires_in;
      }
    } catch { /* fall back to the short-lived token if the exchange fails */ }
  }
  const accessToken = tokenJson.access_token;
  const refreshToken = tokenJson.refresh_token || null;

  // Provider-specific user info fetch (for label)
  let userLogin = providerKey;
  try {
    if (providerKey === "github") {
      const u: any = await (await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "grantry" } })).json();
      if (u.login) userLogin = u.login;
    } else if (providerKey.startsWith("google_") || providerKey === "gmail" || providerKey === "bigquery") {
      const u: any = await (await fetch(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${accessToken}`)).json();
      if (u.email) userLogin = u.email;
    } else if (providerKey === "hubspot") {
      const u: any = await (await fetch("https://api.hubapi.com/oauth/v1/access-tokens/" + accessToken)).json();
      if (u.hub_id) userLogin = `hub-${u.hub_id}`;
    } else if (providerKey === "slack") {
      // Slack's oauth.v2.access response already carries the workspace info, so
      // we don't need an extra API call to name the connection.
      if (tokenJson.team?.name) userLogin = tokenJson.team.name;
      else if (tokenJson.team?.id) userLogin = tokenJson.team.id;
    } else if (providerKey === "freee") {
      const u: any = await (await fetch("https://api.freee.co.jp/api/1/users/me", { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } })).json();
      if (u?.user?.email) userLogin = u.user.email;
    } else if (providerKey === "moneyforward") {
      const u: any = await (await fetch("https://invoice.moneyforward.com/api/v3/office", { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } })).json();
      const office = u?.office ?? u?.data ?? u;
      if (office?.name) userLogin = office.name;
    } else if (providerKey === "meta_ads") {
      const metaVersion = process.env.META_ADS_API_VERSION || "v21.0";
      const u: any = await (await fetch(`https://graph.facebook.com/${metaVersion}/me?fields=id,name`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      if (u.name) userLogin = String(u.name).replace(/\s+/g, "-").toLowerCase();
      else if (u.id) userLogin = `fb-${u.id}`;
    } else if (providerKey === "reddit") {
      const u: any = await (await fetch("https://oauth.reddit.com/api/v1/me", { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "grantry/1.0 (MCP connector)" } })).json();
      if (u.name) userLogin = u.name;
    } else if (providerKey === "x") {
      const u: any = await (await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      if (u?.data?.username) userLogin = u.data.username;
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
  // The wizard already created the Tenant row (with its display name); this
  // upsert only covers direct /oauth/:provider/start?tenant=… entry points.
  const tenantRow = await ensureTenant(user.id, effectiveTenant);

  // --- Reconnect mode: refresh an existing connection's tokens in place. ---
  // No wizard, no agent: find the tenant's connection for this provider, update
  // its credentials, and return to the edit page. This is what the "↻ Reconnect"
  // button drives (e.g. when an agent reports an expired/revoked Google token).
  if (payload.reauth) {
    const requestedConnectionId = String(payload.connection_id || "");
    const conn = requestedConnectionId
      ? await prisma.connection.findFirst({
          where: { id: requestedConnectionId, provider: providerKey, authType: "oauth", scope: effectiveTenant, ownerId: user.id },
        })
      : await prisma.connection.findFirst({
          where: { provider: providerKey, authType: "oauth", scope: effectiveTenant, ownerId: user.id },
          orderBy: { createdAt: "desc" },
        });
    if (requestedConnectionId && !conn) {
      return c.html(`<h1>connection not found for reconnect</h1><p>The requested connection does not belong to this tenant/provider. <a href="/tenants/${effectiveTenant}/edit">Back</a></p>`, 404);
    }
    const data = {
      encryptedCredential: encrypt(accessToken),
      accessTokenExpiresAt: tokenJson.expires_in ? new Date(Date.now() + tokenJson.expires_in * 1000) : null,
      ...(await credentialMetadataForStorage(providerKey, "oauth", accessToken)),
      // Google only returns a refresh_token on first consent unless prompt=consent
      // (which the start route forces), so keep the old one if none came back.
      ...(refreshToken ? { refreshToken: encrypt(refreshToken) } : {}),
    };
    if (conn) {
      await prisma.connection.update({ where: { id: conn.id }, data });
    } else {
      // No existing connection for this tenant/provider — create one so the
      // reconnect still leaves a usable credential behind.
      await prisma.connection.create({
        data: {
          provider: providerKey,
          authType: "oauth",
          label: `${providerKey}-${userLogin}-${effectiveTenant}-oauth`,
          scope: effectiveTenant,
          tenantId: tenantRow.id,
          ownerId: user.id,
          ...data,
        },
      });
    }
    await syncTenantRoleTools(user.id, effectiveTenant);
    return c.redirect(`/tenants/${effectiveTenant}/edit?reauthed=${encodeURIComponent(providerKey)}`);
  }

  if (!agent) {
    return c.html(`<h1>agent name missing in saved payload</h1>`, 400);
  }

  // 1) Create connection (idempotent by provider+scope for this user)
  const existingConn = await prisma.connection.findFirst({
    where: { provider: providerKey, authType: "oauth", scope: effectiveTenant, ownerId: user.id },
    orderBy: { createdAt: "desc" },
  });
  const conn = existingConn ?? await prisma.connection.create({
    data: {
      provider: providerKey,
      authType: "oauth",
      label: `${providerKey}-${userLogin}-${effectiveTenant}-oauth`,
      scope: effectiveTenant,
      tenantId: tenantRow.id,
      ownerId: user.id,
      encryptedCredential: encrypt(accessToken),
      accessTokenExpiresAt: tokenJson.expires_in ? new Date(Date.now() + tokenJson.expires_in * 1000) : null,
      refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
      ...(await credentialMetadataForStorage(providerKey, "oauth", accessToken)),
    },
  });
  // If the connection already existed, update the credential (token may have rotated)
  if (existingConn) {
    await prisma.connection.update({
      where: { id: existingConn.id },
      data: {
        encryptedCredential: encrypt(accessToken),
        accessTokenExpiresAt: tokenJson.expires_in ? new Date(Date.now() + tokenJson.expires_in * 1000) : null,
        ...(await credentialMetadataForStorage(providerKey, "oauth", accessToken)),
        ...(refreshToken ? { refreshToken: encrypt(refreshToken) } : {}),
      },
    });
  }
  await syncTenantRoleTools(user.id, effectiveTenant);

  // 2) Find or create role. Use the per-user role name (matching the wizard
  //    and edit flows) so a chained multi-provider creation reuses the same
  //    role across every provider's callback.
  const userIdShort = user.id.slice(0, 8);
  const roleName = `${effectiveTenant}-dev-${userIdShort}`;
  const desiredTools = tools.length > 0 ? tools : toolsForProvider(providerKey);
  // Role.name is globally unique — look it up by name alone. Filtering by
  // ownerId here would miss an existing same-named role and fall through to
  // create(), triggering a unique-constraint violation (an uncaught 500).
  // roleName already encodes the owner (per-user suffix), so this is safe.
  let role = await prisma.role.findUnique({ where: { name: roleName } });
  if (role) {
    const existingTools = safeJsonArray(role.allowedTools);
    const existingScopes = safeJsonArray(role.allowedScopes);
    const mergedTools = Array.from(new Set([...existingTools, ...desiredTools]));
    const mergedScopes = existingScopes.length === 0 ? [effectiveTenant] : Array.from(new Set([...existingScopes, effectiveTenant]));
    role = await prisma.role.update({
      where: { id: role.id },
      data: { allowedTools: JSON.stringify(mergedTools), allowedScopes: JSON.stringify(mergedScopes) },
    });
  } else {
    role = await prisma.role.create({
      data: {
        name: roleName,
        description: `Role for tenant '${effectiveTenant}' (via OAuth)`,
        allowedTools: JSON.stringify(desiredTools),
        allowedScopes: JSON.stringify([effectiveTenant]),
        ownerId: user.id,
      },
    });
  }

  // If more providers in the chain still need OAuth authorization, hand off
  // to the next one before minting the agent. The role already carries every
  // provider's tools (set when the wizard was submitted), so each callback
  // just needs to attach its own connection.
  const remainingQueue = String(payload.oauth_queue || "")
    .split(",").map((s: string) => s.trim()).filter(Boolean);
  if (remainingQueue.length > 0) {
    const [nextProvider, ...rest] = remainingQueue;
    const params = new URLSearchParams({
      tenant: payload.tenant || "",
      tenant_select: payload.tenant_select || "",
      additional_scopes: payload.additional_scopes || "",
      agent: payload.agent || "",
      agent_desc: payload.agent_desc || "",
      tools_json: payload.tools_json || "[]",
      oauth_queue: rest.join(","),
    });
    return c.redirect(`/oauth/${nextProvider}/start?${params.toString()}`);
  }

  // 3) Create agent + bind role + mint token
  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Agent name taken — grantry</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>⚠️  Agent name <code>${escapeHtml(agent)}</code> already exists</h1>
        <div class="card" style="border-color:#ff6b6b;">
          <p>${escapeHtml(providerDef.label)} connection was created, but the agent name is taken. <a href="/agents/${existingAgent.id}">Reuse the existing agent</a> or pick a different name.</p>
        </div>
        <p><a href="/tenants">← Back to tenants</a></p>
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

  // List every connection on this tenant so chained multi-provider setups
  // show all the services that were wired up, not just the last one.
  const allConns = await prisma.connection.findMany({
    where: { scope: effectiveTenant, ownerId: user.id },
    orderBy: [{ provider: "asc" }, { authType: "asc" }],
  });
  const googleAdsConnectionNeedsDeveloperToken = allConns.some((cn) =>
    cn.provider === "google_ads" && !cn.encryptedServerCredential && !process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  );

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(providerDef.label)} connected — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ ${escapeHtml(providerDef.label)} connected · tenant <code>${effectiveTenant}</code> created</h1>
      ${googleAdsConnectionNeedsDeveloperToken ? `
      <div class="card" style="border-color:#f0b429;background:rgba(240,180,41,0.08);">
        <h2>Google Ads API token still required</h2>
        <p>OAuth は完了しましたが、Google Ads API を呼ぶには Google Ads API Center の <b>Developer token</b> も必要です。</p>
        <p>次の画面で <code>google_ads</code> connection の <b>Developer token</b> 欄に貼って保存してください。</p>
        <p><a href="/tenants/${effectiveTenant}/edit">Open tenant settings →</a> · <a href="https://ads.google.com/aw/apicenter" target="_blank" rel="noopener">Open Google Ads API Center →</a></p>
      </div>` : ""}
      <div class="card">
        <h2>Connections (${allConns.length})</h2>
        ${allConns.map((cn) => `<p><code>${escapeHtml(cn.label)}</code> · auth=<code>${escapeHtml(cn.authType)}</code> · scope=<code>${escapeHtml(cn.scope)}</code></p>`).join("")}
      </div>
      <div class="card">
        <h2>Role</h2>
        <p><code>${role.name}</code> · allowed_scopes=<code>${safeJsonArray(role.allowedScopes).join(", ") || "any"}</code> · ${JSON.parse(role.allowedTools).length} tools</p>
      </div>
      <div class="card">
        <h2>Agent</h2>
        <p><code>${agentRow.name}</code> · bound to <code>${role.name}</code></p>
      </div>
      ${agentTokenCard(token, "")}
      ${mcpConfigCard(publicOrigin(c), agentRow.name, token, true, effectiveTenant)}
      <p><a href="/tenants">← Back to tenants</a> · <a href="/agents">Manage agents</a></p>
    </main></body></html>
  `);
 } catch (err) {
    // Surface the real cause instead of an opaque "Internal Server Error".
    console.error(`[oauth callback] ${providerKeyForError} failed:`, err);
    const detail = err instanceof Error ? err.message : String(err);
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>OAuth failed — grantry</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants")}
      <main>
        <h1>⚠️  OAuth connection failed</h1>
        <div class="card" style="border-color:#ff6b6b;">
          <p>Something went wrong while completing the <code>${escapeHtml(providerKeyForError)}</code> connection.</p>
          <pre style="background:#0e0f12;border:1px solid #ff6b6b;white-space:pre-wrap;">${escapeHtml(detail)}</pre>
        </div>
        <p><a href="/tenants/new">← Try again</a></p>
      </main></body></html>
    `, 500);
 }
});

// --- /api/scopes (JSON dump of caller's wiring) ---
// Returns the user's distinct scopes, connections, roles, and agents.
// Useful for agents that need to know what they can call before hitting /mcp.
dashboardApp.get("/api/scopes", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const [tenants, conns, roles, agents] = await Promise.all([
    prisma.tenant.findMany({
      where: { ownerId: user.id },
      select: { id: true, slug: true, displayName: true, description: true, createdAt: true },
      orderBy: { slug: "asc" },
    }),
    prisma.connection.findMany({
      where: { ownerId: user.id },
      select: { id: true, provider: true, authType: true, scope: true, label: true, enabled: true, createdAt: true },
      orderBy: [{ scope: "asc" }, { provider: "asc" }, { authType: "asc" }],
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
    tenants: tenants.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    scopes: Array.from(new Set([
      ...tenants.map((t) => t.slug),
      ...conns.map((cn) => cn.scope).filter((s) => s),
    ])),
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

// --- /tenants/:scope/agents/new (POST) — add another agent to existing tenant ---
dashboardApp.post("/tenants/:scope/agents/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);
  const body = await c.req.parseBody();
  const agent = String(body.agent ?? "").trim();
  const agentDesc = String(body.agent_desc ?? "").trim();
  const toolsJson = String(body.tools_json ?? "").trim();
  if (!agent) return c.html("<h1>agent name required</h1>", 400);
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {
    return c.html("<h1>invalid agent name (a-z, 0-9, hyphens, underscores)</h1>", 400);
  }

  // Find the existing role for this tenant (per-user naming)
  const userIdShort = user.id.slice(0, 8);
  const role = await prisma.role.findFirst({
    where: { name: `${scope}-dev-${userIdShort}`, ownerId: user.id },
  });
  if (!role) {
    return c.html(`<h1>no role found for scope '${scope}' (yours). Use the wizard to create a new tenant first.</h1>`, 404);
  }

  // Check for agent name conflict up front
  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Agent name taken — grantry</title>
      <style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>⚠️ Agent name <code>${escapeHtml(agent)}</code> already exists</h1>
        <div class="card" style="border-color:#ff6b6b;">
          <p>Pick a different agent name (e.g. <code>${escapeHtml(agent)}-v2</code>).</p>
          <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a></p>
        </div>
      </main></body></html>
    `, 409);
  }

  // If the form provided a custom tools list, optionally update the role
  // with the union. (Most users won't customize this — they get the role's
  // existing tool set.)
  let customTools: string[] | null = null;
  if (toolsJson) {
    try { customTools = JSON.parse(toolsJson); } catch {}
  }
  if (customTools && customTools.length > 0) {
    const existing = safeJsonArray(role.allowedTools);
    const merged = Array.from(new Set([...existing, ...customTools]));
    if (merged.length !== existing.length) {
      await prisma.role.update({
        where: { id: role.id },
        data: { allowedTools: JSON.stringify(merged) },
      });
    }
  }

  // Mint token + create agent
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
    <!doctype html><html><head><meta charset="utf-8"><title>Agent created — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ New agent <code>${agentRow.name}</code> added to <code>${scope}</code></h1>
      <div class="card">
        <h2>Connection</h2>
        <p>Reused the existing <code>${scope}</code> connection(s) — no new PAT/OAuth needed.</p>
      </div>
      <div class="card">
        <h2>Role</h2>
        <p>Bound to <code>${role.name}</code> (allowed_scopes: <code>${safeJsonArray(role.allowedScopes).join(", ") || "<em>any</em>"}</code>)</p>
        <p>Tools: ${safeJsonArray(role.allowedTools).map((t: string) => `<span class="tool-pill">${t}</span>`).join(" ")}</p>
      </div>
      ${agentTokenCard(token)}
      ${mcpConfigCard(publicOrigin(c), agentRow.name, token, true, scope)}
      <div class="card">
        <h2>Test it</h2>
        <pre>curl -X POST ${publicOrigin(c)}/mcp \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'</pre>
      </div>
      <p>
        <a href="/tenants/${scope}/edit">← Back to ${scope}</a> ·
        <a href="/tenants/${scope}/edit">Add another agent</a> ·
        <a href="/agents">Manage all agents</a>
      </p>
    </main></body></html>
  `);
});

// --- /tenants/:scope/delete (POST) — single tenant delete ---
dashboardApp.post("/tenants/:scope/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  // 1) Find user's connections + tenant row for this scope. A tenant with
  //    zero connections is still deletable (the entity exists on its own).
  const [conns, tenantRow] = await Promise.all([
    prisma.connection.findMany({
      where: { scope, ownerId: user.id },
      select: { id: true, label: true },
    }),
    prisma.tenant.findUnique({
      where: { ownerId_slug: { ownerId: user.id, slug: scope } },
      select: { id: true },
    }),
  ]);
  if (conns.length === 0 && !tenantRow) {
    return c.html(`<h1>No tenant or connections found for scope '${scope}' (yours)</h1>`, 404);
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

  // 5) Delete the tenant entity itself.
  await prisma.tenant.deleteMany({ where: { slug: scope, ownerId: user.id } });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Deleted — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Deleted tenant <code>${scope}</code></h1>
      <div class="card">
        <p>Removed <b>${connDelete.count}</b> connection(s) and <b>${roleDelete.count}</b> role(s).</p>
        <p>Agents that were bound to this role are now unbound. Visit <a href="/agents">/agents</a> to re-bind or delete them.</p>
      </div>
      <p><a href="/tenants">← Back to all tenants</a></p>
    </main></body></html>
  `);
});

// --- /tenants/bulk-delete (POST) — bulk tenant delete ---
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
    await prisma.tenant.deleteMany({ where: { slug: scope, ownerId: user.id } });
    conns += connDelete.count;
    roles += roleDelete.count;
    detail.push(`<li><code>${escapeHtml(scope)}</code>: ${connDelete.count} conn, ${roleDelete.count} role</li>`);
  }
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Bulk deleted — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Bulk deleted ${scopes.length} tenant(s)</h1>
      <div class="card">
        <p>Total: <b>${conns}</b> connection(s), <b>${roles}</b> role(s) removed.</p>
        <ul>${detail.join("")}</ul>
      </div>
      <p><a href="/tenants">← Back to all tenants</a></p>
    </main></body></html>
  `);
});

// --- /agents/:id/delete (POST) — single agent delete ---
dashboardApp.post("/agents/:id/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const id = c.req.param("id");
  const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true } });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  // Cascade AgentRole rows via onDelete: Cascade; the agent itself is then deleted.
  await prisma.agent.delete({ where: { id: agent.id } });
  return c.redirect("/agents");
});

// --- /agents/bulk-delete (POST) — bulk agent delete ---
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
    <!doctype html><html><head><meta charset="utf-8"><title>Bulk deleted — grantry</title>
    <style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
    <main>
      <h1>✓ Bulk deleted ${result.count} agent(s)</h1>
      <p>${result.count < ids.length ? `(${ids.length - result.count} skipped — not yours or not found)` : ""}</p>
      <p><a href="/agents">← Back to all agents</a></p>
    </main></body></html>
  `);
});
