// grantry UI — login, dashboard, tenant wizard, audit log
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { auth } from "./auth.js";
import { prisma } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { PROVIDERS, getProvider, getProviderForWorkspace, listProvidersForWorkspace, normalizePathPrefixes, toolsForProviderForWorkspace, validateCustomProviderKey } from "./connectors/registry.js";
import { providerIcon, providerIconMap } from "./connectors/icons.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";
import { callGenericCheckConnection, callGenericListCapabilities } from "./connectors/generic_request.js";
import { parseServiceAccountInput, serviceAccountPublicMeta, invalidateDwdToken, mintDwdAccessToken, type ServiceAccountCredential } from "./google_dwd.js";
import { connectionsForAgent, findCapableAgents, normalizeToolName } from "./policy.js";
import { ensureTenant } from "./tenants.js";
import { createTenantConnectionFromCredential, ensureProviderCredentialForConnection, rotateSharedCredential, syncProviderCredentialFromConnection } from "./provider_credentials.js";
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
  if (authType === "service_account") return "Service Account (DWD)";
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
  if (authType === "service_account") return "Paste the full service account JSON key file";
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
  if (providerKey === "moneyforward") return "🔗 Open Money Forward App Portal →";
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
      <div class="card" style="background:rgba(99,91,255,0.08);">
        <h2>🔑 Agent token (save this — shown once!)</h2>
        <div class="row" style="align-items:stretch;gap:8px;">
          <pre style="background:#f6f9fc;border:1px solid #635bff;flex:1;margin:0;">${safe}</pre>
          <button type="button" class="secondary copy-token-btn" data-token="${safe}" style="white-space:nowrap;">📋 Copy</button>
        </div>
        <p style="font-size:13px;color:#687385;margin-bottom:0;margin-top:12px;">Use as <code>Authorization: Bearer ${safe}</code> when calling <code>/mcp</code>.</p>
        ${warningHtml ? `<p style="font-size:13px;color:#df1b41;margin-top:8px;">${warningHtml}</p>` : ""}
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
        <p style="font-size:13px;color:#687385;margin-top:0;">
          ${scope
            ? `Use one MCP server entry per scope. Tool names stay stable; the token and <code>X-Grantry-Scope</code> lock this entry to the selected scope.`
            : `This entry is <b>not</b> scope-locked: the token decides what it can reach, and each call picks its scope via the <code>scope</code> argument.`}
        </p>
        <p style="font-size:13px;color:#3c4257;margin:0 0 4px;">MCP endpoint: <code>${escapeHtml(origin)}/mcp</code> — authenticate with <code>Authorization: Bearer &lt;token&gt;</code>.</p>

        <div class="row spread" style="margin:20px 0 6px;">
          <h3 style="font-size:14px;margin:0;color:#3c4257;">Claude Code <span class="badge ok">Recommended — fastest</span></h3>
          ${copyButton("CLI", claudeCli)}
        </div>
        <p style="font-size:13px;color:#687385;margin:0 0 8px;">Run this one line in your terminal. It registers the server in <code>~/.claude.json</code> and Claude Code can use it right away — no manual file editing.</p>
        <pre>${escapeHtml(claudeCli)}</pre>

        <div class="row spread" style="margin:16px 0 6px;">
          <h3 style="font-size:14px;margin:0;color:#3c4257;">Claude Code — manual JSON <code>~/.claude.json</code></h3>
          ${copyButton("JSON", claudeJson)}
        </div>
        <p style="font-size:13px;color:#687385;margin:0 0 8px;">Prefer editing the config file directly? Merge this entry under <code>mcpServers</code>.</p>
        <pre>${escapeHtml(claudeJson)}</pre>

        <div class="row spread" style="margin:16px 0 6px;">
          <h3 style="font-size:14px;margin:0;color:#3c4257;">Claude Desktop <code>claude_desktop_config.json</code></h3>
          ${copyButton("Desktop", claudeDesktopJson)}
        </div>
        <pre>${escapeHtml(claudeDesktopJson)}</pre>

        <div class="row spread" style="margin:16px 0 6px;">
          <h3 style="font-size:14px;margin:0;color:#3c4257;">Codex <code>~/.codex/config.toml</code></h3>
          ${copyButton("Codex", codexToml)}
        </div>
        <pre>${escapeHtml(codexToml)}</pre>
        ${exactToken
          ? '<p style="font-size:13px;color:#687385;margin-bottom:0;">This config includes the newly minted token. <code>Mcp-Session-Id</code> is managed by the MCP client/server handshake.</p>'
          : '<p style="font-size:13px;color:#df1b41;margin-bottom:0;">The full token is only shown when created or rotated. Rotate this agent if you need a copy-pasteable config with a fresh token.</p>'}
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
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  :root {
    --bg: #f6f9fc; --surface: #ffffff; --border: #e3e8ee; --border-strong: #cdd5df;
    --ink: #0a2540; --ink-2: #3c4257; --muted: #687385; --faint: #8792a2;
    --accent: #635bff; --accent-strong: #5249e0; --accent-soft: rgba(99,91,255,0.09);
    --ok: #1a7f5a; --ok-soft: rgba(26,127,90,0.1); --danger: #df1b41; --danger-soft: rgba(223,27,65,0.1);
    --sidebar-w: 232px;
    --shadow-sm: 0 1px 2px rgba(50,50,93,0.07), 0 1px 3px rgba(0,0,0,0.05);
    --shadow-md: 0 4px 12px rgba(50,50,93,0.08), 0 2px 6px rgba(0,0,0,0.04);
  }
  * { box-sizing: border-box; }
  body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink-2); margin: 0; line-height: 1.55; -webkit-font-smoothing: antialiased; letter-spacing: -0.005em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Left sidebar navigation */
  nav { position: fixed; z-index: 50; top: 0; left: 0; width: var(--sidebar-w); height: 100vh; display: flex; flex-direction: column; gap: 2px; padding: 20px 14px; border-right: 1px solid var(--border); background: var(--surface); overflow-y: auto; }
  nav .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 18px; color: var(--ink); letter-spacing: -0.03em; padding: 6px 10px 14px; }
  nav .brand .brand-mark { width: 28px; height: 28px; flex-shrink: 0; color: var(--ink); }
  .nav-links { display: flex; flex-direction: column; gap: 2px; }
  .ws-switcher { padding: 4px 10px 12px; }
  .ws-switcher label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 4px; }
  .ws-switcher select { width: 100%; padding: 7px 8px; font-size: 13px; font-weight: 600; border-radius: 8px; }
  .ws-new-btn { width: 100%; margin-top: 6px; padding: 6px 8px; font-size: 12px; font-weight: 600; background: var(--surface); color: var(--accent); border: 1px dashed var(--border-strong); box-shadow: none; }
  .ws-new-btn:hover { background: var(--accent-soft); color: var(--accent); transform: none; }
  .ws-dialog { border: 1px solid var(--border); border-radius: 14px; padding: 24px; max-width: 440px; width: 90vw; box-shadow: var(--shadow-md); background: var(--surface); color: var(--ink-2); }
  .ws-dialog::backdrop { background: rgba(15,23,42,0.4); }
  .ws-dialog h2 { margin: 0 0 8px; }
  .ws-dialog label { display: block; font-size: 13px; color: var(--ink-2); margin: 14px 0 4px; font-weight: 600; }
  .ws-dialog-hint { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
  .ws-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
  nav a { color: var(--muted); padding: 8px 10px; border-radius: 8px; font-size: 14px; font-weight: 500; white-space: nowrap; transition: background .15s ease, color .15s ease; }
  nav a:hover { background: var(--bg); color: var(--ink); text-decoration: none; }
  nav a.active { background: var(--accent-soft); color: var(--accent); }
  .nav-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 14px; }
  .nav-user { font-size: 12px; color: var(--muted); }
  .nav-user:hover { color: var(--ink); text-decoration: none; }

  main { box-sizing: border-box; margin-left: var(--sidebar-w); padding: 40px clamp(24px, 4vw, 56px) 96px; max-width: calc(var(--sidebar-w) + 1240px); }
  h1 { font-size: 28px; margin: 0 0 24px; color: var(--ink); font-weight: 700; letter-spacing: -0.03em; }
  h2 { font-size: 18px; margin: 24px 0 12px; color: var(--ink); font-weight: 650; letter-spacing: -0.02em; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; margin-bottom: 16px; box-shadow: var(--shadow-sm); }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .row.spread { justify-content: space-between; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .provider-icon { flex-shrink: 0; vertical-align: -4px; }
  .provider-cell { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .conn-list { list-style: none; margin: 0; padding: 0; }
  .conn-item { display: flex; align-items: center; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
  .conn-item:last-child { border-bottom: 0; }
  .conn-item .provider-cell { width: 190px; flex-shrink: 0; }
  .conn-item .provider-cell code, .conn-auth { white-space: nowrap; overflow-wrap: normal; }
  .conn-auth { flex-shrink: 0; min-width: 66px; text-align: center; }
  .conn-label { flex: 1; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conn-meta { display: flex; align-items: center; gap: 10px; margin-left: auto; white-space: nowrap; }
  .scope-card { padding: 16px 18px; }
  .scope-row { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .scope-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-width: 0; }
  .scope-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex: 1; white-space: nowrap; }
  .scope-title-name { overflow: hidden; text-overflow: ellipsis; }
  .scope-controls { display: inline-flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .scope-actions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .scope-actions .btn { font-size: 12px; padding: 4px 10px; }
  .scope-services { display: flex; align-items: center; gap: 8px; min-width: 0; overflow-x: auto; white-space: nowrap; padding: 1px 0 2px; }
  .scope-service-pill { display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 3px 8px; background: var(--bg); border-radius: 6px; color: var(--ink-2); }
  .scope-service-pill code { white-space: nowrap; overflow-wrap: normal; }
  .scope-meta { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .badge.scoped { background: var(--accent-soft); color: var(--accent); }
  .badge.unscoped { background: rgba(135,146,162,0.16); color: var(--muted); }
  .badge.denied { background: var(--danger-soft); color: var(--danger); }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .table-wrap { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 14px; vertical-align: middle; }
  th { color: var(--muted); font-weight: 500; }
  td:first-child, th:first-child { padding-left: 0; }
  td:last-child, th:last-child { padding-right: 0; }
  code, pre { background: var(--bg); padding: 2px 6px; border-radius: 5px; font-size: 13px; font-family: ui-monospace, monospace; color: var(--ink); }
  code { overflow-wrap: anywhere; }
  pre { padding: 12px 16px; overflow-x: auto; border: 1px solid var(--border); }
  input[type=text], input[type=password], input[type=email], select, textarea {
    width: 100%; padding: 8px 10px; background: var(--surface); color: var(--ink);
    border: 1px solid var(--border-strong); border-radius: 8px; font-family: inherit; font-size: 14px;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  label { display: block; font-size: 13px; color: var(--ink-2); margin-bottom: 4px; }
  .field { margin-bottom: 12px; }
  .field-hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .field-primary input { font-size: 18px !important; padding: 12px 14px !important; border: 2px solid var(--accent) !important; background: var(--accent-soft) !important; }
  .field-primary input:focus { background: #fff !important; }
  .field-secondary { margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--border); }
  .field-secondary summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 4px 0; user-select: none; }
  .field-secondary summary:hover { color: var(--ink); }
  .field-secondary[open] summary { color: var(--accent); margin-bottom: 8px; }
  button, .btn {
    padding: 8px 16px; background: var(--accent); color: #fff; border: 0; border-radius: 8px;
    font-weight: 600; cursor: pointer; font-size: 14px; text-decoration: none; display: inline-block;
    box-shadow: var(--shadow-sm); transition: background .15s ease, transform .15s ease;
  }
  button:hover, .btn:hover { background: var(--accent-strong); text-decoration: none; color: #fff; transform: translateY(-1px); }
  button.secondary, .btn.secondary { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong); box-shadow: none; }
  button.secondary:hover, .btn.secondary:hover { background: var(--bg); color: var(--ink); transform: none; }
  .combo { position: relative; flex: 1; }
  .combo-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong); border-radius: 8px; font-weight: 400; font-size: 14px; text-align: left; box-shadow: none; }
  .combo-btn:hover { background: var(--surface); color: var(--ink-2); transform: none; }
  .combo-btn:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .combo-btn .combo-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .combo-caret { color: var(--muted); font-size: 11px; flex-shrink: 0; }
  .combo-list { position: absolute; z-index: 60; top: calc(100% + 4px); left: 0; right: 0; max-height: 320px; overflow-y: auto; margin: 0; padding: 4px; list-style: none; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-md); }
  .combo-opt { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 14px; color: var(--ink-2); }
  .combo-opt[hidden] { display: none; }
  .combo-opt .combo-icon { display: inline-flex; flex-shrink: 0; }
  .combo-opt:hover, .combo-opt.active { background: var(--accent-soft); }
  .combo-opt[aria-selected="true"] { font-weight: 600; }
  .combo-search-row { position: sticky; top: 0; padding: 4px 4px 6px; margin: -4px -4px 4px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .combo-search-row input { width: 100%; padding: 7px 10px; font-size: 14px; }
  .combo-empty { padding: 10px; color: var(--muted); font-size: 13px; text-align: center; }
  input[type=checkbox] { accent-color: var(--accent); }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  .tool-pill { display: inline-block; padding: 2px 8px; margin: 2px; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; font-size: 11px; font-family: ui-monospace, monospace; }
  .step-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 22px; margin-bottom: 16px; box-shadow: var(--shadow-sm); }
  .step-card h2 { margin-top: 0; display: flex; align-items: center; gap: 12px; }
  .step-card h2 .num { display: inline-block; width: 28px; height: 28px; line-height: 28px; text-align: center; background: var(--accent); color: #fff; border-radius: 50%; font-size: 14px; font-weight: 700; }
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
  @media (max-width: 900px) {
    nav { position: static; width: 100%; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 16px; border-right: 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
    nav .brand { padding: 6px 8px; font-size: 16px; }
    nav .brand .brand-mark { width: 24px; height: 24px; }
    .nav-links { flex-direction: row; flex-wrap: wrap; }
    .nav-foot { margin-top: 0; flex-direction: row; align-items: center; gap: 8px; border-top: 0; padding-top: 0; margin-left: auto; }
    main { margin-left: 0; padding: 24px 16px 64px; max-width: none; }
    h1 { font-size: 24px; }
    .card { padding: 16px; }
    th, td { padding: 9px 10px; }
    .connection-table { min-width: 860px; }
  }
`;

// Favicon: same brand mark as the sidebar, inlined as an SVG data URI so it
// ships on every page (including error pages) with no extra route. currentColor
// flips with the OS theme so the mark stays visible on light and dark tab bars.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 176 176"><style>svg{color:#0a2540}@media(prefers-color-scheme:dark){svg{color:#fff}}</style><circle cx="88" cy="88" r="76" stroke="currentColor" stroke-width="24" fill="none"/><line x1="100" y1="88" x2="100" y2="169" stroke="currentColor" stroke-width="24"/><line x1="76" y1="7" x2="76" y2="88" stroke="currentColor" stroke-width="24"/><rect x="64" y="75" width="48" height="24" fill="currentColor"/></svg>`;
const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

const NAV = (current: string, email?: string) => `
<nav>
  <span class="brand"><svg class="brand-mark" viewBox="0 0 176 176" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="88" cy="88" r="76" stroke="currentColor" stroke-width="24"/><line x1="100" y1="88" x2="100" y2="169" stroke="currentColor" stroke-width="24"/><line x1="76" y1="7" x2="76" y2="88" stroke="currentColor" stroke-width="24"/><rect x="64" y="75" width="48" height="24" fill="currentColor"/></svg>grantry</span>
  <div class="ws-switcher">
    <label for="gnWs">Workspace</label>
    <select id="gnWs" aria-label="Active workspace"><option>…</option></select>
    <button type="button" class="ws-new-btn" id="gnWsNew">+ New workspace</button>
  </div>
  <dialog id="gnWsDialog" class="ws-dialog">
    <form method="post" action="/workspaces">
      <h2>Create a new workspace</h2>
      <p class="ws-dialog-hint">A management wall — you become its owner. Invite teammates and assign agents afterward.</p>
      <label for="gnWsName">Name</label>
      <input type="text" id="gnWsName" name="displayName" placeholder="Acme Inc. workspace" required autocomplete="off">
      <label for="gnWsSlug">Slug <span style="color:var(--muted);font-weight:400;">(optional)</span></label>
      <input type="text" id="gnWsSlug" name="slug" placeholder="acme" pattern="[A-Za-z0-9-]*" autocomplete="off">
      <p class="ws-dialog-hint">Immutable; rides in the connector URL <code>/mcp/w/&lt;slug&gt;</code>. Leave blank to derive it from the name.</p>
      <div class="ws-dialog-actions">
        <button type="button" class="secondary" id="gnWsCancel">Cancel</button>
        <button type="submit">Create</button>
      </div>
    </form>
  </dialog>
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
    var dlg=document.getElementById('gnWsDialog');
    var openBtn=document.getElementById('gnWsNew');
    var cancelBtn=document.getElementById('gnWsCancel');
    if(dlg&&openBtn&&typeof dlg.showModal==='function'){
      openBtn.addEventListener('click',function(){dlg.showModal();var n=document.getElementById('gnWsName');if(n)n.focus();});
      if(cancelBtn)cancelBtn.addEventListener('click',function(){dlg.close();});
      dlg.addEventListener('click',function(e){if(e.target===dlg)dlg.close();});
    }else if(openBtn){
      openBtn.addEventListener('click',function(){window.location.href='/workspaces';});
    }
  })();
  </script>
  <div class="nav-links">
    <a href="/dashboard" class="${current === "dashboard" ? "active" : ""}">Dashboard</a>
    <a href="/tenants" class="${current === "tenants" ? "active" : ""}">Scopes</a>
    <a href="/providers" class="${current === "providers" ? "active" : ""}">Providers</a>
    <a href="/agents" class="${current === "agents" ? "active" : ""}">Agents</a>
    <a href="/workspaces" class="${current === "workspaces" ? "active" : ""}">Workspace</a>
    <a href="/audit" class="${current === "audit" ? "active" : ""}">Audit</a>
    <a href="/account" class="${current === "account" ? "active" : ""}">Account</a>
  </div>
  <div class="nav-foot">
    ${email ? `<a href="/account" class="nav-user" title="Signed in as ${escapeHtml(email)}">\u{1F464} <code style="font-size:12px;">${escapeHtml(email)}</code></a>` : ""}
    <form method="post" action="/logout" style="margin:0;">
      <button type="submit" class="secondary" style="font-size:13px;padding:6px 10px;">Sign out</button>
    </form>
  </div>
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

function safeJsonArrayText(s: string | null | undefined, fallback = ""): string {
  const values = safeJsonArray(s);
  return values.length ? values.join("\n") : fallback;
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

async function listWorkspaceProviderCatalog(workspaceId: string | null | undefined) {
  const providers = await listProvidersForWorkspace(workspaceId);
  if (!workspaceId) {
    return providers.map((provider) => ({ provider, enabled: true, pinned: false, explicit: false }));
  }
  const rows = await prisma.workspaceProvider.findMany({ where: { workspaceId } });
  const state = new Map(rows.map((row) => [row.providerKey, row]));
  return providers.map((provider) => {
    const row = state.get(provider.key);
    return {
      provider,
      enabled: row ? row.enabled : true,
      pinned: row ? row.pinned : false,
      explicit: !!row,
    };
  });
}

async function listConnectionCandidateProviders(workspaceId: string | null | undefined) {
  const catalog = await listWorkspaceProviderCatalog(workspaceId);
  return catalog
    .filter((item) => item.enabled)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.provider.label.localeCompare(b.provider.label))
    .map((item) => item.provider);
}

async function workspaceProviderEnabled(workspaceId: string | null | undefined, providerKey: string) {
  if (!workspaceId) return true;
  const item = (await listWorkspaceProviderCatalog(workspaceId)).find((entry) => entry.provider.key === providerKey);
  return !!item?.enabled;
}

function customProviderForm(action: string, prefix: string) {
  return `
    <form method="post" action="${escapeHtml(action)}">
      <div class="field"><label for="${prefix}_key">Provider key</label><input type="text" name="key" id="${prefix}_key" pattern="[a-z0-9_-]+" placeholder="one_stream" required></div>
      <div class="field"><label for="${prefix}_label">Label</label><input type="text" name="label" id="${prefix}_label" placeholder="OneStream" required></div>
      <div class="field"><label for="${prefix}_base_url">API base URL</label><input type="url" name="base_url" id="${prefix}_base_url" placeholder="https://example.com/api" required></div>
      <div class="field"><label for="${prefix}_auth_scheme">Auth style</label><select name="auth_scheme" id="${prefix}_auth_scheme"><option value="bearer">Authorization: Bearer token</option><option value="api_key">API key header</option></select></div>
      <div class="field"><label for="${prefix}_api_key_header">API key header</label><input type="text" name="api_key_header" id="${prefix}_api_key_header" placeholder="X-API-Key"></div>
      <div class="field"><label for="${prefix}_allowed_path_prefixes">Allowed path prefixes</label><textarea name="allowed_path_prefixes" id="${prefix}_allowed_path_prefixes" rows="3">/</textarea></div>
      <div class="field"><label for="${prefix}_smoke_path">Connection check path <span style="color:#687385;">(optional)</span></label><input type="text" name="smoke_path" id="${prefix}_smoke_path" placeholder="/v1/me"></div>
      <div class="field"><label for="${prefix}_token_url">Token settings URL <span style="color:#687385;">(optional)</span></label><input type="url" name="token_url" id="${prefix}_token_url" placeholder="https://example.com/settings/api"></div>
      <button type="submit" class="secondary">Add custom provider</button>
    </form>
  `;
}

async function createWorkspaceCustomProvider(c: any, workspaceId: string, ownerId: string, body: any, backHref: string) {
  const key = String(body.key ?? "").trim().toLowerCase();
  const label = String(body.label ?? "").trim();
  const baseUrl = String(body.base_url ?? "").trim();
  const authScheme = String(body.auth_scheme ?? "").trim() === "api_key" ? "api_key" : "bearer";
  const apiKeyHeader = String(body.api_key_header ?? "").trim();
  const allowedPathPrefixes = normalizePathPrefixes(String(body.allowed_path_prefixes ?? "/"));
  const smokePath = String(body.smoke_path ?? "").trim();
  const tokenUrl = String(body.token_url ?? "").trim();

  const keyErr = validateCustomProviderKey(key);
  if (keyErr) return c.html(`<h1>Invalid provider key</h1><p>${escapeHtml(keyErr)}</p><p><a href="${escapeHtml(backHref)}">Back</a></p>`, 400);
  if (!label) return c.html(`<h1>label required</h1><p><a href="${escapeHtml(backHref)}">Back</a></p>`, 400);
  try {
    const parsed = new URL(baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("API base URL must be http or https");
  } catch (e: any) {
    return c.html(`<h1>Invalid API base URL</h1><p>${escapeHtml(String(e?.message ?? e))}</p><p><a href="${escapeHtml(backHref)}">Back</a></p>`, 400);
  }
  if (authScheme === "api_key" && !apiKeyHeader) return c.html(`<h1>API key header required</h1><p><a href="${escapeHtml(backHref)}">Back</a></p>`, 400);
  if (tokenUrl) {
    try { new URL(tokenUrl); } catch {
      return c.html(`<h1>Invalid token settings URL</h1><p><a href="${escapeHtml(backHref)}">Back</a></p>`, 400);
    }
  }

  const smokeTests = smokePath ? [{ name: "default", method: "GET", path: smokePath.startsWith("/") ? smokePath : `/${smokePath}` }] : [];
  try {
    await prisma.$transaction([
      prisma.customProvider.create({
        data: {
          workspaceId,
          ownerId,
          key,
          label,
          helpText: `Paste your ${label} API key or access token.`,
          tokenUrl: tokenUrl || null,
          baseUrl: baseUrl.replace(/\/+$/, ""),
          authScheme,
          apiKeyHeader: authScheme === "api_key" ? apiKeyHeader : null,
          allowedPathPrefixes: JSON.stringify(allowedPathPrefixes),
          defaultMethods: JSON.stringify(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          smokeTests: JSON.stringify(smokeTests),
          operations: JSON.stringify([]),
          enabled: true,
        },
      }),
      prisma.workspaceProvider.upsert({
        where: { workspaceId_providerKey: { workspaceId, providerKey: key } },
        create: { workspaceId, providerKey: key, enabled: true, pinned: true, createdById: ownerId },
        update: { enabled: true },
      }),
    ]);
  } catch (e: any) {
    if (e?.code === "P2002") {
      return c.html(`<h1>custom provider already exists</h1><p><code>${escapeHtml(key)}</code> is already registered in this workspace.</p><p><a href="${escapeHtml(backHref)}">Back</a></p>`, 409);
    }
    throw e;
  }
  return null;
}

async function credentialMetadataForProviderDef(providerDef: any, authType: string, token: string) {
  if (!providerDef?.genericRequest || getProvider(providerDef.key)) return credentialMetadataForStorage(providerDef.key, authType, token);
  const checkedAt = new Date().toISOString();
  const metadata: any = { provider: providerDef.key, authType, status: "unknown", notes: ["Custom provider credentials are validated through the configured connection check path when available."], checkedAt };
  try {
    const [check, capabilities] = await Promise.all([callGenericCheckConnection({ provider: providerDef, credential: token }), callGenericListCapabilities({ provider: providerDef })]);
    const checkContent: any = check.structuredContent ?? {};
    const capabilityContent: any = capabilities.structuredContent ?? {};
    const smokeTests = Array.isArray(checkContent.tests) ? checkContent.tests : [];
    const operations = Array.isArray(capabilityContent.operations) ? capabilityContent.operations : [];
    metadata.status = checkContent.status === "ok" ? "ok" : checkContent.status === "error" ? "error" : "unknown";
    metadata.capabilities = { status: metadata.status, smokeTests, operations, missingScopes: Array.from(new Set(smokeTests.flatMap((test: any) => Array.isArray(test.missingScopes) ? test.missingScopes.map(String) : []))), checkedAt };
  } catch (e: any) { metadata.status = "unknown"; metadata.capabilities = { status: "unknown", checkedAt, error: String(e?.message ?? e).slice(0, 500) }; }
  return { credentialMetadata: JSON.stringify(metadata).slice(0, 16000), credentialValidatedAt: new Date() };
}

function parseScopeList(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const scope of String(raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  }
  return scopes;
}

function providerUsesWorkspaceOAuthApp(providerDef: any) {
  return Array.isArray(providerDef?.authTypes)
    && providerDef.authTypes.includes("oauth")
    && providerDef.oauthAppOwner === "workspace";
}

function providerRequiresWorkspaceOAuthApp(providerKey: string, providerDef?: any) {
  return providerUsesWorkspaceOAuthApp(providerDef ?? PROVIDERS[providerKey]);
}

function defaultOAuthClientAuthMethod(providerKey: string, providerDef?: any) {
  const configured = String((providerDef ?? PROVIDERS[providerKey])?.oauthClientAuthMethod ?? "").trim().toUpperCase();
  if (configured === "CLIENT_SECRET_BASIC" || configured === "CLIENT_SECRET_POST") return configured;
  return "CLIENT_SECRET_POST";
}

function workspaceOAuthAppProviderKeys() {
  return Object.values(PROVIDERS)
    .filter((providerDef) => providerUsesWorkspaceOAuthApp(providerDef))
    .map((providerDef) => providerDef.key);
}

function defaultOAuthClientAuthMethodsByProvider() {
  return Object.fromEntries(
    Object.values(PROVIDERS)
      .filter((providerDef) => providerUsesWorkspaceOAuthApp(providerDef))
      .map((providerDef) => [providerDef.key, defaultOAuthClientAuthMethod(providerDef.key, providerDef)]),
  );
}

function clientIdPreview(clientId: string | null | undefined) {
  const id = String(clientId || "").trim();
  if (!id) return "";
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}...${id.slice(-10)}`;
}

function oauthCallbackUrl(c: any, providerKey: string) {
  const origin = String(process.env.BETTER_AUTH_URL || publicOrigin(c)).replace(/\/+$/, "");
  return `${origin}/oauth/${providerKey}/callback`;
}

function oauthAppCredentialFromStructuredFields(body: any, suffix = "", defaultClientAuthMethod = "CLIENT_SECRET_POST") {
  const field = (name: string) => suffix ? `${name}_${suffix}` : name;
  const clientId = String(body[field("oauth_client_id")] ?? "").trim();
  const clientSecret = String(body[field("oauth_client_secret")] ?? "").trim();
  if (!clientId && !clientSecret) return "";
  const clientAuthMethod = String(body[field("oauth_client_auth_method")] ?? defaultClientAuthMethod).trim().toUpperCase() || defaultClientAuthMethod;
  return JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    client_auth_method: clientAuthMethod,
  });
}

function parseOAuthAppCredentialInput(raw: string, providerDef: any) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/);
      if (match) parsed[match[1]] = match[2].trim();
    }
  }
  const clientId = String(parsed.client_id ?? parsed.clientId ?? parsed.oauthClientId ?? "").trim();
  const clientSecret = String(parsed.client_secret ?? parsed.clientSecret ?? parsed.oauthClientSecret ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new Error('OAuth app credential must include client_id and client_secret, for example {"client_id":"...","client_secret":"..."}');
  }
  const parsedScopes = parseScopeList(String(parsed.oauth_scopes ?? parsed.scopes ?? ""));
  const parsedOptionalScopes = parseScopeList(String(parsed.oauth_optional_scopes ?? parsed.optional_scopes ?? ""));
  const oauthScopes = Array.isArray(parsed.oauthScopes)
    ? parsed.oauthScopes.map(String).filter(Boolean)
    : (parsedScopes.length ? parsedScopes : (providerDef.oauthScopes || []));
  const oauthOptionalScopes = Array.isArray(parsed.oauthOptionalScopes)
    ? parsed.oauthOptionalScopes.map(String).filter(Boolean)
    : (parsedOptionalScopes.length ? parsedOptionalScopes : (providerDef.oauthOptionalScopes || []));
  const oauthClientAuthMethod = String(
    parsed.client_auth_method
      ?? parsed.clientAuthMethod
      ?? parsed.oauthClientAuthMethod
      ?? "CLIENT_SECRET_BASIC",
  ).trim().toUpperCase();
  return { clientId, clientSecret, oauthScopes, oauthOptionalScopes, oauthClientAuthMethod };
}

async function upsertWorkspaceOAuthAppCredential(args: {
  workspaceId: string | null;
  ownerId: string;
  providerKey: string;
  providerDef: any;
  rawCredential: string;
}) {
  if (!args.workspaceId) throw new Error("workspace is required to store an OAuth app credential");
  const parsed = parseOAuthAppCredentialInput(args.rawCredential, args.providerDef);
  if (!parsed) return null;
  const existing = await prisma.providerCredential.findFirst({
    where: { workspaceId: args.workspaceId, provider: args.providerKey, authType: "oauth_app" },
    orderBy: { updatedAt: "desc" },
  });
  const data = {
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    provider: args.providerKey,
    authType: "oauth_app",
    label: `${args.providerKey} OAuth app`,
    encryptedCredential: encrypt(parsed.clientSecret),
    credentialMetadata: JSON.stringify({
      kind: "oauth_app",
      oauthClientId: parsed.clientId,
      oauthScopes: parsed.oauthScopes,
      oauthOptionalScopes: parsed.oauthOptionalScopes,
      oauthClientAuthMethod: parsed.oauthClientAuthMethod,
    }),
    credentialValidatedAt: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    enabled: true,
    createdById: args.ownerId,
  };
  return existing
    ? prisma.providerCredential.update({ where: { id: existing.id }, data })
    : prisma.providerCredential.create({ data });
}

async function resolveOAuthWorkspaceId(c: any, userId: string, providerKey: string, payload: Record<string, any>) {
  const requestedConnectionId = String(payload.connection_id || "");
  if (requestedConnectionId) {
    const conn = await prisma.connection.findFirst({
      where: { id: requestedConnectionId, ownerId: userId, provider: providerKey, authType: "oauth" },
      select: { workspaceId: true },
    });
    if (conn?.workspaceId) return conn.workspaceId;
  }
  const tenant = String(payload.tenant || payload.tenant_select || "");
  if (tenant) {
    const row = await prisma.tenant.findFirst({
      where: { ownerId: userId, slug: tenant },
      select: { workspaceId: true },
    });
    if (row?.workspaceId) return row.workspaceId;
  }
  return getActiveWorkspaceId(c);
}

async function resolveOAuthClientConfig(providerKey: string, providerDef: any, workspaceId: string | null, credentialId?: string | null) {
  const shouldUseWorkspaceCredential = !!credentialId || providerRequiresWorkspaceOAuthApp(providerKey, providerDef);
  if (workspaceId && shouldUseWorkspaceCredential) {
    const credential = credentialId
      ? await prisma.providerCredential.findFirst({
          where: { id: credentialId, workspaceId, provider: providerKey, authType: "oauth_app", enabled: true },
        })
      : await prisma.providerCredential.findFirst({
          where: { workspaceId, provider: providerKey, authType: "oauth_app", enabled: true },
          orderBy: { updatedAt: "desc" },
        });
    if (credential) {
      const meta = safeJsonObject(credential.credentialMetadata);
      const clientId = typeof meta.oauthClientId === "string" ? meta.oauthClientId.trim() : "";
      if (clientId) {
        return {
          source: "workspace" as const,
          credentialId: credential.id,
          clientId,
          clientSecret: decrypt(credential.encryptedCredential),
          oauthScopes: Array.isArray(meta.oauthScopes) ? meta.oauthScopes.map(String).filter(Boolean) : [],
          oauthOptionalScopes: Array.isArray(meta.oauthOptionalScopes) ? meta.oauthOptionalScopes.map(String).filter(Boolean) : [],
          oauthClientAuthMethod: typeof meta.oauthClientAuthMethod === "string" ? meta.oauthClientAuthMethod : "CLIENT_SECRET_BASIC",
        };
      }
    }
  }
  if (providerRequiresWorkspaceOAuthApp(providerKey, providerDef)) {
    return {
      source: "workspace_missing" as const,
      credentialId: null,
      clientId: "",
      clientSecret: "",
      oauthScopes: providerDef.oauthScopes || [],
      oauthOptionalScopes: providerDef.oauthOptionalScopes || [],
      oauthClientAuthMethod: "CLIENT_SECRET_BASIC",
    };
  }
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
    google_admin: ["GOOGLE_CLIENT_ID"],
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
    google_admin: ["GOOGLE_CLIENT_SECRET"],
    yahoo_ads: ["YAHOO_CLIENT_SECRET"],
  };
  return {
    source: "env" as const,
    credentialId: null,
    clientId: process.env[`${envPrefix}_CLIENT_ID`] || (legacyAliases[providerKey] || []).map(k => process.env[k]).find(Boolean) || "",
    clientSecret: process.env[`${envPrefix}_CLIENT_SECRET`] || (legacySecretAliases[providerKey] || []).map(k => process.env[k]).find(Boolean) || "",
    oauthScopes: providerDef.oauthScopes || [],
    oauthOptionalScopes: providerDef.oauthOptionalScopes || [],
    oauthClientAuthMethod: process.env[`${envPrefix}_CLIENT_AUTH_METHOD`] || "CLIENT_SECRET_POST",
  };
}

function renderCredentialSummary(cn: {
  provider?: string;
  authType?: string;
  credentialMetadata?: string | null;
  credentialValidatedAt?: Date | null;
}) {
  const meta = safeJsonObject(cn.credentialMetadata);
  if (!meta.status) return '<span style="color:#687385;font-size:12px;">not checked</span>';
  if (meta.status === "error") {
    return `<span class="badge denied">check failed</span> <span style="color:#687385;font-size:12px;">${escapeHtml(String(meta.error ?? "")).slice(0, 80)}</span>`;
  }
  const scopes = Array.isArray(meta.scopes) ? meta.scopes.map(String) : [];
  const resources = Array.isArray(meta.resources) ? meta.resources : [];
  const subject = meta.subject && typeof meta.subject === "object" ? meta.subject : {};
  const parts: string[] = [];
  if (scopes.length) parts.push(scopes.slice(0, 4).map((s) => `<code>${escapeHtml(s)}</code>`).join(" "));
  if (resources.length) parts.push(`<span style="color:#687385;font-size:12px;">${resources.length} resource${resources.length === 1 ? "" : "s"}</span>`);
  if (subject.login) parts.push(`<span style="color:#687385;font-size:12px;">@${escapeHtml(String(subject.login))}</span>`);
  if (subject.email) parts.push(`<span style="color:#687385;font-size:12px;">${escapeHtml(String(subject.email))}</span>`);
  if (!parts.length) parts.push(`<span style="color:#687385;font-size:12px;">${escapeHtml(String(meta.status))}</span>`);
  // For PAT connections the provider's API rarely exposes the token's exact
  // permission set, so link out to the provider's token-management page where
  // the operator can verify the real scope of the credential.
  if (cn.authType === "pat" && cn.provider) {
    const def = getProvider(cn.provider);
    if (def?.tokenUrl) {
      parts.push(`<a href="${escapeHtml(def.tokenUrl)}" target="_blank" rel="noopener" style="font-size:12px;">Verify token permissions →</a>`);
    }
  }
  const validated = cn.credentialValidatedAt ? ` title="Checked ${cn.credentialValidatedAt.toISOString()}"` : "";
  const capabilities = renderCapabilitySummary(cn.provider, cn.authType, meta);
  return `<div class="credential-summary"${validated}>${parts.join("<br>")}${capabilities}</div>`;
}

function renderCapabilitySummary(provider: string | undefined, authType: string | undefined, meta: Record<string, any>) {
  const caps = meta.capabilities && typeof meta.capabilities === "object" ? meta.capabilities : null;
  if (!caps) return "";
  const status = String(caps.status ?? "unknown");
  const smokeTests = Array.isArray(caps.smokeTests) ? caps.smokeTests : [];
  const operations = Array.isArray(caps.operations) ? caps.operations : [];
  const missingScopes: string[] = Array.isArray(caps.missingScopes) ? caps.missingScopes.map(String).filter(Boolean) : [];
  const okTests = smokeTests.filter((t: any) => t?.status === "ok").length;
  const failedTests = smokeTests.filter((t: any) => t?.status === "error").length;
  const knownOps = operations.length;
  const badge = status === "ok"
    ? '<span class="badge ok">capabilities ok</span>'
    : status === "error"
      ? '<span class="badge denied">capability issue</span>'
      : '<span class="badge unscoped">capabilities unknown</span>';
  const rows: string[] = [
    `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #e3e8ee;">${badge}</div>`,
  ];
  if (okTests || failedTests) {
    rows.push(`<span style="color:#687385;font-size:12px;">Smoke tests: ${okTests} ok${failedTests ? `, ${failedTests} failed` : ""}</span>`);
  }
  if (knownOps) {
    rows.push(`<span style="color:#687385;font-size:12px;">Known capabilities: ${knownOps}</span>`);
  }
  if (missingScopes.length) {
    rows.push(`<span class="badge denied">missing ${missingScopes.map((s: string) => escapeHtml(s)).join(", ")}</span>`);
    rows.push(`<span style="color:#687385;font-size:12px;">Fix: ${authType === "oauth" ? "Reconnect after granting the missing scope." : "Add the missing permission to the provider token/private app, then recheck."}</span>`);
  }
  if (caps.error) {
    rows.push(`<span style="color:#687385;font-size:12px;">${escapeHtml(String(caps.error)).slice(0, 100)}</span>`);
  }
  const providerDef = provider ? getProvider(provider) : null;
  if (providerDef?.genericRequest) {
    rows.push(`<span style="color:#687385;font-size:12px;">Generic read request: enabled</span>`);
  }
  return rows.join("<br>");
}

// Onboarding panel for a Domain-Wide Delegation connection: the Client ID and
// scopes the customer's Workspace admin must register, plus the impersonated
// subject. Pulled from the non-secret credentialMetadata (never the SA key).
function renderDwdInfo(cn: { authType?: string; credentialMetadata?: string | null }) {
  if (cn.authType !== "service_account") return "";
  const meta = safeJsonObject(cn.credentialMetadata);
  const clientId = meta.client_id ? String(meta.client_id) : "";
  const subject = meta.subject ? String(meta.subject) : "";
  const scopes = Array.isArray(meta.scopes) ? meta.scopes.map(String) : [];
  return `
    <div style="margin-top:6px;padding-top:8px;border-top:1px dashed #e3e8ee;">
      <div class="field-hint" style="margin-bottom:4px;"><b>Domain-Wide Delegation</b> — register in the customer's <b>Admin console → Security → Access and data control → API controls → Domain-wide delegation</b>.</div>
      ${subject ? `<div class="field-hint">Impersonating: <code>${escapeHtml(subject)}</code></div>` : ""}
      <div class="field-hint">Client ID: <code>${escapeHtml(clientId || "(unknown)")}</code></div>
      ${scopes.length ? `<div class="field-hint" style="margin-top:4px;">OAuth scopes (comma-separated):</div><textarea rows="3" readonly style="width:100%;font-family:monospace;font-size:11px;">${escapeHtml(scopes.join(","))}</textarea>` : ""}
    </div>`;
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

// ---------- Active workspace context ----------
// The "active workspace" is the management context the dashboard operates in:
// new tenants/agents/roles/connections are created in it, and list pages are
// filtered to it. It's stored in the `gn_ws` cookie (SameSite=Lax so it also
// rides through the OAuth provider redirect back to /oauth/:p/callback). Falls
// back to the user's owner (personal) workspace, then their first membership.
async function resolveActiveWorkspace(c: any, userId: string) {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
  if (!memberships.length) return { memberships, active: null as (typeof memberships)[number]["workspace"] | null };
  const cookieId = getCookie(c, "gn_ws");
  const active =
    (cookieId ? memberships.find((m) => m.workspaceId === cookieId)?.workspace : undefined) ??
    memberships.find((m) => m.role === "owner")?.workspace ??
    memberships[0].workspace;
  return { memberships, active };
}

// Resolve just the active workspace id for the signed-in user — used at every
// resource-creation site so new rows land in the right workspace.
async function getActiveWorkspaceId(c: any): Promise<string | null> {
  const user = await getSessionUser(c);
  if (!user?.id) return null;
  const { active } = await resolveActiveWorkspace(c, user.id);
  return active?.id ?? null;
}

function setActiveWorkspaceCookie(c: any, workspaceId: string) {
  setCookie(c, "gn_ws", workspaceId, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 365,
  });
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
      ${FAVICON}<style>${CSS} body { max-width: 420px; margin: 80px auto; padding: 0 24px; }</style></head><body>
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
       <span><b>${escapeHtml(a.name)}</b>${a.workspace ? ` <small style="color:#687385;">(${escapeHtml(a.workspace.displayName)})</small>` : ""}${a.description ? `<br><small style="color:#687385;">${escapeHtml(a.description)}</small>` : ""}</span></label>`,
    )
    .join("");
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose agent — grantry</title>
    ${FAVICON}<style>${CSS} body { max-width: 440px; margin: 60px auto; padding: 0 24px; }
    .agent-opt { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid #30343a; border-radius:8px; margin-bottom:8px; cursor:pointer; }
    .agent-opt:hover { border-color: #58a6ff; }
    </style></head><body>
    <h1>Connect ${escapeHtml(clientName)}</h1>
    <div class="card">
      <p>${escapeHtml(clientName)} will act as the agent you choose, using that agent's granted connections exactly as configured in the dashboard. You can change or revoke this anytime.</p>
      <form id="pick">${options}
        <button type="submit" style="width:100%;margin-top:8px;">Continue</button>
        <div id="err" style="color:#df1b41;margin-top:8px;font-size:13px;"></div>
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

// Mirror of scripts/backfill-workspaces.mjs slugify so manually-created and
// auto-created workspaces produce identical wire keys. The slug is immutable
// and rides in connector URLs (/mcp/w/<slug>).
function slugifyWorkspace(base: string) {
  return (
    base
      .toLowerCase()
      .replace(/@.*$/, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

async function requireWsAdmin(c: any, workspaceId: string) {
  const user = await getSessionUser(c);
  if (!user?.id) return null;
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: user.id, role: { in: ["owner", "admin"] } },
  });
  return member ? { user, member } : null;
}

// JSON feed for the nav workspace switcher (populated client-side).
dashboardApp.get("/api/workspaces/active", async (c) => {
  const user = await getSessionUser(c);
  if (!user?.id) return c.json({ workspaces: [], activeId: null });
  const { memberships, active } = await resolveActiveWorkspace(c, user.id);
  return c.json({
    activeId: active?.id ?? null,
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      slug: m.workspace.slug,
      displayName: m.workspace.displayName,
      role: m.role,
    })),
  });
});

// Set the active workspace (validated against membership) and return where we were.
dashboardApp.get("/workspaces/switch", async (c) => {
  const user = await getSessionUser(c);
  if (!user?.id) return c.redirect("/login");
  const wsId = c.req.query("ws") ?? "";
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: wsId, userId: user.id } });
  if (member) setActiveWorkspaceCookie(c, wsId);
  const next = c.req.query("next");
  return c.redirect(next && next.startsWith("/") ? next : "/dashboard");
});

dashboardApp.get("/workspaces", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");
  const flash = c.req.query("ok") ?? "";

  // Slack-style isolation: this page shows ONLY the active workspace, never the
  // full directory of memberships. Switching workspaces in the nav switcher
  // changes the whole world — you never see another workspace's members,
  // agents, or invites while a different one is active.
  const { active, memberships } = await resolveActiveWorkspace(c, user.id);

  const sections: string[] = [];
  const m = active ? memberships.find((mm) => mm.workspaceId === active.id) : undefined;
  if (m) {
    const ws = m.workspace;
    const isAdmin = m.role === "owner" || m.role === "admin";
    if (!isAdmin) {
      sections.push(`<div class="card"><b>${escapeHtml(ws.displayName)}</b> <span class="badge unscoped">${escapeHtml(m.role)}</span>
        <div style="color:#687385;font-size:13px;margin-top:6px;">Connector URL: <code>${escapeHtml(BASE_URL())}/mcp/w/${escapeHtml(ws.slug)}</code></div></div>`);
    } else {

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
      <div style="color:#687385;font-size:13px;">Workspace-locked connector URL (parallel connectors per client):<br>
        <code>${escapeHtml(BASE_URL())}/mcp/w/${escapeHtml(ws.slug)}</code></div>

      <h3>Members</h3>
      <table>
        <thead><tr><th>Member</th><th>Role</th><th>Assigned agents</th><th></th></tr></thead>
        <tbody>
        ${members.map((mm) => {
          const mine = assignments.filter((a) => a.user.id === mm.user.id);
          return `<tr>
            <td>${escapeHtml(mm.user.email)}${mm.user.name ? ` <small style="color:#687385;">${escapeHtml(mm.user.name)}</small>` : ""}</td>
            <td><span class="badge ${mm.role === "member" ? "unscoped" : "ok"}">${escapeHtml(mm.role)}</span></td>
            <td>${mine.length ? mine.map((a) => `
              <form method="post" action="/workspaces/${ws.id}/unassign" style="display:inline-block;margin:0 6px 4px 0;">
                <input type="hidden" name="agentId" value="${escapeHtml(a.agent.id)}"><input type="hidden" name="userId" value="${escapeHtml(mm.user.id)}">
                <span class="badge scoped">${escapeHtml(a.agent.name)} <button type="submit" title="Unassign" style="all:unset;cursor:pointer;color:#df1b41;">&times;</button></span>
              </form>`).join("") : '<span style="color:#687385;">—</span>'}
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
        <div style="margin-top:8px;color:#687385;font-size:13px;">Auto-assign agents on accept:</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;">
          ${agents.map((a) => `<label style="font-size:13px;"><input type="checkbox" name="agentIds" value="${escapeHtml(a.id)}"> ${escapeHtml(a.name)}</label>`).join("") || '<span style="color:#687385;font-size:13px;">No agents in this workspace yet.</span>'}
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
  }

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Workspace — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("workspaces", user?.email)}
    <main>
      <h1>Workspace</h1>
      ${flash ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">${escapeHtml(flash)}</div>` : ""}
      ${sections.join("\n") || '<div class="card"><div class="empty">No workspace yet — use <b>+ New workspace</b> in the sidebar to create one.</div></div>'}
    </main></body></html>
  `);
});

dashboardApp.post("/workspaces", async (c) => {
  const user = await getSessionUser(c);
  if (!user?.id) return c.redirect("/login");
  const form = await c.req.formData();
  const displayName = String(form.get("displayName") ?? "").trim();
  const slugInput = String(form.get("slug") ?? "").trim();
  if (!displayName) {
    return c.redirect(`/workspaces?ok=${encodeURIComponent("Workspace name is required")}`);
  }

  // Derive slug from the explicit input, else from the display name. Ensure
  // uniqueness by suffixing -2, -3, … just like the boot-time backfill.
  const base = slugifyWorkspace(slugInput || displayName);
  let slug = base;
  for (let i = 2; await prisma.workspace.findUnique({ where: { slug } }); i++) {
    slug = `${base}-${i}`;
  }

  const ws = await prisma.workspace.create({
    data: {
      slug,
      displayName,
      members: { create: { userId: user.id, role: "owner" } },
    },
    select: { id: true },
  });
  // Drop the creator straight into the new workspace as the active context.
  setActiveWorkspaceCookie(c, ws.id);
  return c.redirect(`/workspaces?ok=${encodeURIComponent(`Workspace "${displayName}" created (slug: ${slug}) — now active`)}`);
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
    ${FAVICON}<style>${CSS} body { max-width: 440px; margin: 80px auto; padding: 0 24px; }</style></head><body>
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

// --- /providers — workspace-level provider catalog selection ---
dashboardApp.get("/providers", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");
  const wsId = await getActiveWorkspaceId(c);
  if (!wsId) return c.html("<h1>workspace required</h1>", 400);
  const admin = await requireWsAdmin(c, wsId);
  const catalog = await listWorkspaceProviderCatalog(wsId);
  const connectionCounts = await prisma.connection.groupBy({
    by: ["provider"],
    where: { workspaceId: wsId },
    _count: { _all: true },
  });
  const countByProvider = new Map(connectionCounts.map((row) => [row.provider, row._count._all]));
  const customProviders = await prisma.customProvider.findMany({
    where: { workspaceId: wsId },
    orderBy: [{ enabled: "desc" }, { label: "asc" }],
  });
  const customKeys = new Set(customProviders.map((p) => p.key));
  const enabledCount = catalog.filter((item) => item.enabled).length;
  const disabledCount = catalog.length - enabledCount;

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Providers — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("providers", user?.email)}
    <main>
      <h1>Providers</h1>
      <p style="color:#687385;margin-top:-16px;margin-bottom:24px;">
        Choose which providers this workspace can add to scopes. Existing connections keep working; disabled providers are hidden from new scope connection pickers.
      </p>

      <div class="row" style="gap:16px;flex-wrap:wrap;margin-bottom:24px;">
        <div class="card" style="flex:1;min-width:160px;"><div style="color:#687385;font-size:12px;">Catalog</div><div style="font-size:24px;font-weight:700;">${catalog.length}</div></div>
        <div class="card" style="flex:1;min-width:160px;"><div style="color:#687385;font-size:12px;">Enabled</div><div style="font-size:24px;font-weight:700;">${enabledCount}</div></div>
        <div class="card" style="flex:1;min-width:160px;"><div style="color:#687385;font-size:12px;">Hidden</div><div style="font-size:24px;font-weight:700;">${disabledCount}</div></div>
        <div class="card" style="flex:1;min-width:160px;"><div style="color:#687385;font-size:12px;">Custom</div><div style="font-size:24px;font-weight:700;">${customProviders.length}</div></div>
      </div>

      <h2>Workspace provider catalog</h2>
      <div class="card">
        <input type="text" id="providerCatalogSearch" placeholder="Search providers..." autocomplete="off" style="margin-bottom:12px;">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Type</th><th>Auth</th><th>Connections</th><th>Workspace</th><th>Action</th></tr></thead>
            <tbody>
              ${catalog.map(({ provider: p, enabled, pinned, explicit }) => {
                const isCustom = customKeys.has(p.key);
                return `
                <tr class="provider-catalog-row" data-search="${escapeHtml((p.key + " " + p.label + " " + p.authTypes.join(" ")).toLowerCase())}">
                  <td><span class="provider-cell">${providerIcon(p.key)}<code>${escapeHtml(p.key)}</code></span><br><span style="color:#687385;font-size:12px;">${escapeHtml(p.label)}</span></td>
                  <td>${isCustom ? '<span class="badge scoped">custom</span>' : '<span class="badge unscoped">built-in</span>'} ${pinned ? '<span class="badge ok">pinned</span>' : ""}</td>
                  <td>${p.authTypes.map((a) => `<span class="tool-pill">${escapeHtml(authTypeLabel(p.key, a))}</span>`).join(" ")}</td>
                  <td>${countByProvider.get(p.key) ?? 0}</td>
                  <td>${enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge unscoped">hidden from scopes</span>'}${explicit ? "" : '<br><span style="color:#687385;font-size:12px;">default</span>'}</td>
                  <td>
                    ${admin ? `<form method="post" action="/providers/${encodeURIComponent(p.key)}/toggle" style="display:inline;">
                      <input type="hidden" name="enabled" value="${enabled ? "0" : "1"}">
                      <button type="submit" class="${enabled ? "secondary" : ""}" style="font-size:12px;padding:4px 10px;">${enabled ? "Hide" : "Enable"}</button>
                    </form>` : '<span style="color:#687385;">admin only</span>'}
                  </td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Custom providers</h2>
      <div class="card">
        <p class="field-hint" style="margin-top:0;">Custom providers are workspace-level definitions. Once enabled here, they appear in each scope's Add service picker.</p>
        ${customProviders.length ? `<div class="table-wrap" style="margin-bottom:18px;"><table><thead><tr><th>Provider</th><th>Base URL</th><th>Auth</th><th>Status</th><th>Action</th></tr></thead><tbody>${customProviders.map((p) => `<tr><td><code>${escapeHtml(p.key)}</code><br><span style="color:#687385;font-size:12px;">${escapeHtml(p.label)}</span></td><td><code>${escapeHtml(p.baseUrl)}</code></td><td><code>${escapeHtml(p.authScheme)}</code>${p.apiKeyHeader ? `<br><code>${escapeHtml(p.apiKeyHeader)}</code>` : ""}</td><td>${p.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</td><td>${admin ? `<form method="post" action="/providers/custom/${p.id}/delete" onsubmit="return confirm(${jsString(`Delete custom provider ${p.key}? Existing connections keep their provider key but the catalog definition will be removed.`)});"><button type="submit" class="danger" style="font-size:12px;padding:4px 10px;">Delete</button></form>` : '<span style="color:#687385;">admin only</span>'}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty" style="margin-bottom:14px;">No custom providers in this workspace yet.</div>'}
        ${admin ? customProviderForm("/providers/custom/new", "providers_custom") : '<p class="field-hint">Workspace admin required to add custom providers.</p>'}
      </div>
    </main>
    <script>
      (function () {
        var search = document.getElementById('providerCatalogSearch');
        var rows = Array.from(document.querySelectorAll('.provider-catalog-row'));
        if (!search) return;
        search.addEventListener('input', function () {
          var terms = search.value.toLowerCase().split(/\\s+/).filter(Boolean);
          rows.forEach(function (row) {
            var haystack = row.getAttribute('data-search') || '';
            row.style.display = terms.every(function (term) { return haystack.indexOf(term) !== -1; }) ? '' : 'none';
          });
        });
      })();
    </script>
    </body></html>
  `);
});

dashboardApp.post("/providers/:providerKey/toggle", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const wsId = await getActiveWorkspaceId(c);
  if (!wsId) return c.html("<h1>workspace required</h1>", 400);
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.html("<h1>workspace admin required</h1>", 403);
  const providerKey = c.req.param("providerKey");
  const providerDef = await getProviderForWorkspace(providerKey, wsId);
  if (!providerDef) return c.html(`<h1>unknown provider: ${escapeHtml(providerKey)}</h1>`, 404);
  const body = await c.req.parseBody();
  const enabled = String(body.enabled ?? "") === "1";
  await prisma.workspaceProvider.upsert({
    where: { workspaceId_providerKey: { workspaceId: wsId, providerKey } },
    create: { workspaceId: wsId, providerKey, enabled, createdById: user.id },
    update: { enabled },
  });
  return c.redirect("/providers");
});

dashboardApp.post("/providers/custom/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const wsId = await getActiveWorkspaceId(c);
  if (!wsId) return c.html("<h1>workspace required</h1>", 400);
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.html("<h1>workspace admin required</h1>", 403);
  const body = await c.req.parseBody();
  const errorResponse = await createWorkspaceCustomProvider(c, wsId, user.id, body, "/providers");
  if (errorResponse) return errorResponse;
  return c.redirect("/providers");
});

dashboardApp.post("/providers/custom/:providerId/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const wsId = await getActiveWorkspaceId(c);
  if (!wsId) return c.html("<h1>workspace required</h1>", 400);
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.html("<h1>workspace admin required</h1>", 403);
  const providerId = c.req.param("providerId");
  const row = await prisma.customProvider.findFirst({ where: { id: providerId, workspaceId: wsId } });
  if (row) {
    await prisma.$transaction([
      prisma.customProvider.delete({ where: { id: row.id } }),
      prisma.workspaceProvider.deleteMany({ where: { workspaceId: wsId, providerKey: row.key } }),
    ]);
  }
  return c.redirect("/providers");
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

// The agent-facing MCP host is split from the dashboard/OAuth host on purpose so
// the MCP URL never moves (see docs/skill.md). Connector configs and curl
// snippets that target /mcp must advertise this host — not whatever host the
// dashboard happens to be served on (e.g. app.grantry.ai). Falls back to the
// dashboard origin for local dev / single-host deployments.
function mcpOrigin(c: any): string {
  if (process.env.MCP_PUBLIC_BASE_URL) return process.env.MCP_PUBLIC_BASE_URL.replace(/\/+$/, "");
  return publicOrigin(c);
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
  google_admin: ["GOOGLE_CLIENT_ID"],
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
  google_admin: ["GOOGLE_CLIENT_SECRET"],
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

  const wsId = await getActiveWorkspaceId(c);
  const wsWhere = wsId ? { workspaceId: wsId } : {};
  const [connectionCount, agentCount, grantCount, recentAudits] = await Promise.all([
    prisma.connection.count({ where: { ownerId: user.id, ...wsWhere } }),
    prisma.agent.count({ where: { ownerId: user.id, ...wsWhere } }),
    prisma.agentConnectionGrant.count({
      where: {
        agent: { ownerId: user.id, ...(wsId ? { workspaceId: wsId } : {}) },
        connection: { ownerId: user.id, ...(wsId ? { workspaceId: wsId } : {}) },
      },
    }),
    prisma.auditLog.findMany({
      // Scope the feed to the active workspace so it never shows another
      // workspace's activity (wsId is membership-verified in resolveActiveWorkspace,
      // so filtering by the agent's workspace is safe). Tool calls always carry an
      // agent; only when there's no active workspace do we fall back to the
      // owner-wide view that also surfaces agent-less system events.
      where: wsId
        ? { agent: { ownerId: user.id, workspaceId: wsId } }
        : { OR: [{ userId: user.id }, { agent: { ownerId: user.id } }] },
      take: 10,
      orderBy: { createdAt: "desc" },
      include: { agent: true },
    }),
  ]);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("dashboard", user?.email)}
    <main>
      <h1>Dashboard</h1>
      <div class="row" style="gap:16px; margin-bottom:24px;">
        <div class="card" style="flex:1;"><div style="color:#687385;font-size:12px;">Connections</div><div style="font-size:24px;font-weight:700;">${connectionCount}</div></div>
        <div class="card" style="flex:1;"><div style="color:#687385;font-size:12px;">Agents</div><div style="font-size:24px;font-weight:700;">${agentCount}</div></div>
        <div class="card" style="flex:1;"><div style="color:#687385;font-size:12px;">Connection grants</div><div style="font-size:24px;font-weight:700;">${grantCount}</div></div>
      </div>
      <h2>Recent activity</h2>
      <div class="card">
        ${recentAudits.length === 0 ? '<div class="empty">No activity yet. Create your first scope → <a href="/tenants/new">+ New scope</a></div>' : `
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

// --- /_ops — system-wide admin overview (unlisted; not in nav, admin-only) ---
// Access is gated to admins on this email domain. Override via OPS_DOMAIN env.
const OPS_DOMAIN = (process.env.OPS_DOMAIN || "rootteam.co.jp").toLowerCase();
function isOpsDomain(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase().endsWith(`@${OPS_DOMAIN}`);
}

dashboardApp.get("/_ops", async (c) => {
  const dbUser = await getDbSessionUser(c);
  if (!dbUser) return c.redirect("/login");

  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  const bootstrapMode = adminCount === 0;
  // The ops view is restricted to admins whose email is on the rootteam.co.jp
  // domain. In bootstrap mode (no admins yet) the same domain gate still applies,
  // so only a rootteam account can promote itself to the first admin.
  if (!isOpsDomain(dbUser.email) || (dbUser.role !== "admin" && !bootstrapMode)) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Meta — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("_ops", dbUser?.email)}
      <main>
        <h1>Meta</h1>
        <div class="card"><h2>Forbidden</h2><p>This screen is restricted to <code>admin</code> users on the <code>${escapeHtml(OPS_DOMAIN)}</code> domain.</p></div>
      </main></body></html>
    `, 403);
  }

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const pruned = c.req.query("pruned");
  const disabledPlatformOauthApps = c.req.query("disabled_platform_oauth_apps");
  const providerDefs = Object.values(PROVIDERS);
  const platformOAuthProviderKeys = providerDefs
    .filter((p) => p.authTypes.includes("oauth") && !providerUsesWorkspaceOAuthApp(p))
    .map((p) => p.key);

  const [
    userCount,
    adminUserCount,
    connectionCount,
    enabledConnectionCount,
    agentCount,
    enabledAgentCount,
    grantCount,
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
    agentsWithoutGrants,
    platformOAuthAppCredentials,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "admin" } }),
    prisma.connection.count(),
    prisma.connection.count({ where: { enabled: true } }),
    prisma.agent.count(),
    prisma.agent.count({ where: { enabled: true } }),
    prisma.agentConnectionGrant.count(),
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
      include: { _count: { select: { connections: true, agents: true, connectionGrants: true, auditLogs: true } } },
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
      where: { connectionGrants: { none: {} } },
      take: 50,
      orderBy: { createdAt: "desc" },
      include: { owner: true },
    }),
    prisma.providerCredential.findMany({
      where: { authType: "oauth_app", provider: { in: platformOAuthProviderKeys }, enabled: true },
      take: 50,
      orderBy: { updatedAt: "desc" },
      select: { id: true, workspaceId: true, provider: true, label: true, updatedAt: true, credentialMetadata: true },
    }),
  ]);

  const oauthProviders = providerDefs.filter((p) => p.authTypes.includes("oauth") && !providerUsesWorkspaceOAuthApp(p));
  const totalToolCount = new Set(providerDefs.flatMap((p) => p.tools)).size;
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
      <div style="color:#687385;font-size:12px;">${escapeHtml(label)}</div>
      <div style="font-size:24px;font-weight:700;">${value}</div>
      ${hint ? `<div style="color:#687385;font-size:12px;margin-top:4px;">${hint}</div>` : ""}
    </div>
  `;
  const okBadge = (ok: boolean, label?: string) => ok
    ? `<span class="badge ok">${escapeHtml(label || "ok")}</span>`
    : `<span class="badge denied">${escapeHtml(label || "missing")}</span>`;

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Meta — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("_ops", dbUser?.email)}
    <main>
      <h1>Meta</h1>
      <p style="color:#687385;margin-top:-12px;">System-wide operational view. No raw credentials are shown.</p>

      ${bootstrapMode ? `
      <div class="card" style="border-color:#f0b429;background:rgba(240,180,41,0.08);">
        <h2>Admin bootstrap required</h2>
        <p>No admin user exists yet. You are viewing this screen because the system has zero admins.</p>
        <form method="post" action="/_ops/promote-self" onsubmit="return confirm('Promote your account to admin?')">
          <button type="submit">Promote me to admin</button>
        </form>
      </div>` : ""}

      ${pruned ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">Pruned <b>${escapeHtml(pruned)}</b> expired OAuth state row(s).</div>` : ""}
      ${disabledPlatformOauthApps ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">Disabled <b>${escapeHtml(disabledPlatformOauthApps)}</b> stale platform OAuth app credential row(s).</div>` : ""}

      <div class="row" style="gap:16px;flex-wrap:wrap;margin-bottom:24px;">
        ${card("Users", userCount, `${adminUserCount} admin`)}
        ${card("Connections", connectionCount, `${enabledConnectionCount} enabled`)}
        ${card("Agents", agentCount, `${enabledAgentCount} enabled`)}
        ${card("Connection grants", grantCount)}
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
            <tr><td>MCP host</td><td>${process.env.MCP_PUBLIC_BASE_URL ? okBadge(true, escapeHtml(process.env.MCP_PUBLIC_BASE_URL)) : okBadge(true, "dashboard host")}</td><td><code>MCP_PUBLIC_BASE_URL</code> — agent-facing <code>/mcp</code> URL shown in connector configs.</td></tr>
            <tr><td>Google Ads developer token</td><td>${okBadge(googleAdsDeveloperTokenPresent, googleAdsDeveloperTokenPresent ? "set" : "missing")}</td><td>Required for <code>google_ads/*</code> calls.</td></tr>
            <tr><td>Expired OAuth states</td><td>${expiredOAuthStateCount ? okBadge(false, `${expiredOAuthStateCount} expired`) : okBadge(true)}</td><td>
              <form method="post" action="/_ops/oauth-states/prune" style="display:inline;">
                <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" ${expiredOAuthStateCount ? "" : "disabled"}>Prune expired</button>
              </form>
            </td></tr>
            <tr><td>Agents without connection grants</td><td>${agentsWithoutGrants.length ? okBadge(false, String(agentsWithoutGrants.length)) : okBadge(true)}</td><td>Agents without grants cannot access provider connections.</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Platform OAuth Environment</h2>
      <div class="card">
        ${envRows.length === 0 ? '<div class="empty">No platform-owned OAuth apps. OAuth client credentials are stored per workspace connection.</div>' : `<div class="table-wrap">
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
        </div>`}
      </div>

      <h2>Stale Platform OAuth App Credentials</h2>
      <div class="card">
        <p class="field-hint" style="margin-top:0;">Platform providers use environment variables. Enabled workspace <code>oauth_app</code> credentials for these providers are ignored by the runtime and should be disabled to avoid confusing diagnostics.</p>
        ${platformOAuthAppCredentials.length === 0 ? '<div class="empty">No enabled stale platform OAuth app credentials.</div>' : `
          <form method="post" action="/_ops/platform-oauth-apps/disable" onsubmit="return confirm('Disable stale platform OAuth app credentials? Runtime platform OAuth uses env vars.');">
            <button type="submit" class="danger" style="margin-bottom:12px;">Disable stale rows</button>
          </form>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Provider</th><th>Workspace</th><th>Label</th><th>Saved client ID</th><th>Updated</th></tr></thead>
              <tbody>
                ${platformOAuthAppCredentials.map((row) => {
                  const meta = safeJsonObject(row.credentialMetadata);
                  return `
                    <tr>
                      <td><code>${escapeHtml(row.provider)}</code></td>
                      <td><code>${escapeHtml(row.workspaceId || "-")}</code></td>
                      <td>${escapeHtml(row.label)}</td>
                      <td><code>${escapeHtml(clientIdPreview(typeof meta.oauthClientId === "string" ? meta.oauthClientId : ""))}</code></td>
                      <td><code>${row.updatedAt.toISOString().slice(0, 19).replace("T", " ")}</code></td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `}
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
                  <td><span class="provider-cell">${providerIcon(p.key)}<code>${escapeHtml(p.key)}</code></span><br><span style="color:#687385;font-size:12px;">${escapeHtml(p.label)}</span></td>
                  <td>${p.authTypes.map((a) => `<span class="tool-pill">${escapeHtml(authTypeLabel(p.key, a))}</span>`).join(" ")}</td>
                  <td>${p.serverCredentialEnv
                    ? `${okBadge(!!process.env[p.serverCredentialEnv], process.env[p.serverCredentialEnv] ? "set" : "missing")} <code>${escapeHtml(p.serverCredentialEnv)}</code>`
                    : '<span style="color:#687385;">none</span>'}</td>
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

      <h2>Scopes</h2>
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
              `).join("") || '<tr><td colspan="2">No scopes.</td></tr>'}
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

        <h3>Agents without connection grants</h3>
        ${agentsWithoutGrants.length === 0 ? '<div class="empty">None.</div>' : `
        <table>
          <thead><tr><th>Owner</th><th>Agent</th><th>Created</th></tr></thead>
          <tbody>
            ${agentsWithoutGrants.map((a) => `
              <tr><td>${escapeHtml(a.owner.email)}</td><td><code>${escapeHtml(a.name)}</code></td><td><code>${a.createdAt.toISOString().slice(0, 10)}</code></td></tr>
            `).join("")}
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
            <thead><tr><th>Email</th><th>Role</th><th>Connections</th><th>Agents</th><th>Grants created</th><th>Audit</th><th>Created</th></tr></thead>
            <tbody>
              ${users.map((u) => `
                <tr>
                  <td>${escapeHtml(u.email)}<br><span style="color:#687385;font-size:12px;">${escapeHtml(u.name || "")}</span></td>
                  <td>${u.role === "admin" ? '<span class="badge ok">admin</span>' : '<span class="badge unscoped">user</span>'}</td>
                  <td>${u._count.connections}</td>
                  <td>${u._count.agents}</td>
                  <td>${u._count.connectionGrants}</td>
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

dashboardApp.post("/_ops/promote-self", async (c) => {
  const dbUser = await getDbSessionUser(c);
  if (!dbUser) return c.redirect("/login");
  if (!isOpsDomain(dbUser.email)) return c.html(`<h1>restricted to ${escapeHtml(OPS_DOMAIN)}</h1>`, 403);
  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  if (adminCount > 0 && dbUser.role !== "admin") return c.html("<h1>admin already exists</h1>", 403);
  await prisma.user.update({ where: { id: dbUser.id }, data: { role: "admin" } });
  return c.redirect("/_ops");
});

dashboardApp.post("/_ops/oauth-states/prune", async (c) => {
  const dbUser = await getDbSessionUser(c);
  if (!dbUser) return c.redirect("/login");
  if (!isOpsDomain(dbUser.email)) return c.html(`<h1>restricted to ${escapeHtml(OPS_DOMAIN)}</h1>`, 403);
  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  if (dbUser.role !== "admin" && adminCount > 0) return c.html("<h1>admin required</h1>", 403);
  const result = await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return c.redirect(`/_ops?pruned=${result.count}`);
});

dashboardApp.post("/_ops/platform-oauth-apps/disable", async (c) => {
  const dbUser = await getDbSessionUser(c);
  if (!dbUser) return c.redirect("/login");
  if (!isOpsDomain(dbUser.email)) return c.html(`<h1>restricted to ${escapeHtml(OPS_DOMAIN)}</h1>`, 403);
  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  if (dbUser.role !== "admin" && adminCount > 0) return c.html("<h1>admin required</h1>", 403);
  const platformOAuthProviderKeys = Object.values(PROVIDERS)
    .filter((p) => p.authTypes.includes("oauth") && !providerUsesWorkspaceOAuthApp(p))
    .map((p) => p.key);
  const result = await prisma.providerCredential.updateMany({
    where: { authType: "oauth_app", provider: { in: platformOAuthProviderKeys }, enabled: true },
    data: { enabled: false },
  });
  return c.redirect(`/_ops?disabled_platform_oauth_apps=${result.count}`);
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
    ${FAVICON}<style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
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
        <div id="err" style="color:#df1b41;margin-top:8px;font-size:13px;"></div>
      </form>
    </div>
    <p style="text-align:center;color:#687385;font-size:13px;">No account? <a href="/register${oauthQuery ? escapeHtml(`?${oauthQuery}`) : ""}">Create one</a> · <a href="/forgot-password">Forgot password?</a></p>
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
    ${FAVICON}<style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Create account</h1>
    <div class="card">
      <form id="regForm">
        <div class="field">
          <label for="email">Email</label>
          <input type="email" name="email" id="email" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" name="password" id="password" required minlength="8">
        </div>
        <button type="submit" style="width:100%;">Create account</button>
        <div id="err" style="color:#df1b41;margin-top:8px;font-size:13px;"></div>
      </form>
    </div>
    <p style="text-align:center;color:#687385;font-size:13px;">Already have one? <a href="/login${oauthQuery ? escapeHtml(`?${oauthQuery}`) : ""}">Sign in</a></p>
    <script>
      document.getElementById('regForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const email = fd.get('email');
        // No name field: better-auth requires a name, so derive a default
        // from the email local part. Users can rename later.
        const name = String(email || '').split('@')[0] || String(email || '');
        const r = await fetch('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, email: email, password: fd.get('password') })
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
    ${FAVICON}<style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Forgot password</h1>
    ${sent ? `
    <div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">
      ✓ If an account exists for that address, a reset link is on its way. The link is valid for 1 hour.
    </div>
    <p style="text-align:center;color:#687385;font-size:13px;"><a href="/login">← Back to sign in</a></p>
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
    <p style="text-align:center;color:#687385;font-size:13px;"><a href="/login">← Back to sign in</a></p>
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
      ${FAVICON}<style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
      <h1>Reset password</h1>
      <div class="card" style="border-color:#df1b41;background:rgba(255,107,107,0.08);">
        ⚠️ This reset link is invalid or has expired. <a href="/forgot-password">Request a new one</a>.
      </div>
      </body></html>
    `, 400);
  }
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Reset password — grantry</title>
    ${FAVICON}<style>${CSS} body { max-width: 360px; margin: 80px auto; padding: 0 24px; }</style></head><body>
    <h1>Choose a new password</h1>
    ${err ? `<div class="card" style="border-color:#df1b41;background:rgba(255,107,107,0.08);">⚠️ ${escapeHtml(String(err))}</div>` : ""}
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

  const [tenantCount, connectionCount, agentCount, grantCount, sessionCount] = await Promise.all([
    prisma.tenant.count({ where: { ownerId: user.id } }),
    prisma.connection.count({ where: { ownerId: user.id } }),
    prisma.agent.count({ where: { ownerId: user.id } }),
    prisma.agentConnectionGrant.count({ where: { agent: { ownerId: user.id } } }),
    prisma.session.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
  ]);

  const ok = c.req.query("ok");
  const err = c.req.query("err");
  const banner = ok
    ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);margin-bottom:20px;">✓ Password updated. Other sessions have been signed out.</div>`
    : err
      ? `<div class="card" style="border-color:#df1b41;background:rgba(255,107,107,0.08);margin-bottom:20px;">⚠️ ${escapeHtml(err)}</div>`
      : "";

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Account — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("account", user?.email)}
    <main>
      <h1>Account</h1>
      ${banner}
      <div class="card">
        <h2>Signed in as</h2>
        <p style="font-size:18px;margin:4px 0 12px;"><code>${escapeHtml(user.email)}</code></p>
        <table>
          <tbody>
            <tr><td style="color:#687385;">Name</td><td>${escapeHtml(user.name || "—")}</td></tr>
            <tr><td style="color:#687385;">User ID</td><td><code>${escapeHtml(user.id)}</code></td></tr>
            <tr><td style="color:#687385;">Role</td><td><code>${escapeHtml(user.role)}</code></td></tr>
            <tr><td style="color:#687385;">Registered</td><td><code>${user.createdAt.toISOString().slice(0, 10)}</code></td></tr>
            <tr><td style="color:#687385;">Active sessions</td><td>${sessionCount}</td></tr>
          </tbody>
        </table>
        <p class="field-hint" style="margin-bottom:0;">
          Everything below is owned by this account. If a scope or agent you expect is missing,
          it probably belongs to a different account — sign out and back in with that one.
        </p>
      </div>
      <div class="card">
        <h2>Owned by this account</h2>
        <p>
          <a href="/tenants">${tenantCount} scope${tenantCount === 1 ? "" : "s"}</a> ·
          ${connectionCount} connection${connectionCount === 1 ? "" : "s"} ·
          <a href="/agents">${agentCount} agent${agentCount === 1 ? "" : "s"}</a> ·
          ${grantCount} connection grant${grantCount === 1 ? "" : "s"}
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

  const wsId = await getActiveWorkspaceId(c);
  const wsWhere = wsId ? { workspaceId: wsId } : {};
  const [tenants, connections, grants] = await Promise.all([
    prisma.tenant.findMany({
      where: { ownerId: user.id, ...wsWhere },
      orderBy: { slug: "asc" },
    }),
    prisma.connection.findMany({
      where: { ownerId: user.id, ...wsWhere },
      orderBy: [{ scope: "asc" }, { provider: "asc" }],
    }),
    prisma.agentConnectionGrant.findMany({
      where: {
        agent: { ownerId: user.id, enabled: true, ...(wsId ? { workspaceId: wsId } : {}) },
        connection: { ownerId: user.id, ...(wsId ? { workspaceId: wsId } : {}) },
      },
      select: { connectionId: true },
    }),
  ]);

  const grantedConnectionIds = new Set(grants.map((g) => g.connectionId));
  const isOrphan = (conn: { id: string; enabled: boolean }): boolean =>
    conn.enabled && !grantedConnectionIds.has(conn.id);

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
    <!doctype html><html><head><meta charset="utf-8"><title>Scopes — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <div class="row spread" style="margin-bottom:16px;">
        <h1 style="margin:0;">Scopes</h1>
        <a href="/tenants/new" class="btn">+ New scope</a>
      </div>
      <p style="color:#687385;margin-top:-8px;">API: <code>GET /api/scopes</code> returns your full wiring as JSON.</p>
      <form method="post" action="/tenants/bulk-delete" id="bulkForm">
        <input type="hidden" name="scopes_csv" id="scopesCsv" value="">
        ${byScope.size === 0 ? '<div class="card"><div class="empty">No scopes yet. <a href="/tenants/new">Create your first one</a>.</div></div>' : `
        <div class="row spread" style="margin-bottom:8px;">
          <label style="font-size:13px;color:#3c4257;cursor:pointer;"><input type="checkbox" id="selectAll"> select all</label>
          <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" id="bulkDelBtn" disabled>🗑 Delete selected (0)</button>
        </div>
        ${Array.from(byScope.entries()).map(([scope, conns]) => {
          const t = tenantBySlug.get(scope);
          const showName = t && t.displayName && t.displayName !== t.slug;
          const orphanCount = conns.filter(isOrphan).length;
          const enabledCount = conns.filter((cn) => cn.enabled).length;
          const newest = conns.map((cn) => cn.createdAt).sort((a, b) => b.getTime() - a.getTime())[0];
          return `
        <div class="card scope-card">
          <div class="scope-row">
            <div class="scope-head">
              <span class="scope-title">
                ${scope === "(unscoped)"
                  ? '<span class="badge unscoped">unscoped</span> <span class="scope-title-name">Legacy connections</span>'
                  : `<input type="checkbox" name="scopes" value="${escapeHtml(scope)}" class="rowCheck" style="margin:0;transform:scale(1.2);">${showName ? `<span class="scope-title-name">${escapeHtml(t!.displayName)}</span>` : ""}<span class="badge scoped">${escapeHtml(scope)}</span>`}
              </span>
              <span class="scope-controls">
                <span class="scope-meta">
                  <span class="badge ${enabledCount === conns.length ? "ok" : "unscoped"}">${enabledCount}/${conns.length} enabled</span>
                  ${orphanCount ? `<span class="badge denied" title="Enabled, but no enabled agent has a grant to this connection.">no agent: ${orphanCount}</span>` : ""}
                  ${newest ? `<code>${newest.toISOString().slice(0, 10)}</code>` : ""}
                </span>
                ${scope !== "(unscoped)" ? `<span class="scope-actions"><a href="/tenants/${encodeURIComponent(scope)}/edit" class="btn secondary">+ Add service</a><a href="/tenants/${encodeURIComponent(scope)}/edit" class="btn secondary">✎ Edit</a></span>` : ""}
              </span>
            </div>
            <span class="scope-services">
              ${conns.length === 0
                ? `<span style="color:#687385;font-size:13px;">No connections yet</span>`
                : conns.map((cn) => `
                  <span class="scope-service-pill" title="${escapeHtml(cn.label)}">
                    ${providerIcon(cn.provider)}<code>${escapeHtml(cn.provider)}</code><code>${escapeHtml(cn.authType)}</code>
                  </span>
                `).join("")}
            </span>
          </div>
        </div>
      `;
        }).join("")}
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
  const wsId = tenantRow?.workspaceId ?? (await getActiveWorkspaceId(c));
  const connections = await prisma.connection.findMany({
    where: { scope, ownerId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const codexAgents = await prisma.agent.findMany({
    where: {
      ownerId: user.id,
      connectionGrants: { some: { connection: { scope, ownerId: user.id } } },
    },
    orderBy: { createdAt: "asc" },
  });
  const providers = await listConnectionCandidateProviders(wsId);
  const knownProviders = Object.values(PROVIDERS);

  const usedProviders = new Set(connections.map((c) => c.provider));
  const usedProviderAuthTypes = new Set(connections.map((c) => `${c.provider}:${c.authType}`));
  const availableToAdd = providers.flatMap((p) =>
    p.authTypes.map((authType) => ({ provider: p, authType }))
  ).filter((option) => !usedProviderAuthTypes.has(`${option.provider.key}:${option.authType}`));
  const comingSoonProviders = knownProviders.filter((p) => p.implemented === false && !usedProviders.has(p.key));
  const reusableConns = await prisma.connection.findMany({
    where: {
      ownerId: user.id,
      ...(tenantRow?.workspaceId ? { workspaceId: tenantRow.workspaceId } : {}),
      enabled: true,
      scope: { not: scope },
    },
    select: { id: true, provider: true, authType: true, label: true, scope: true },
    orderBy: [{ provider: "asc" }, { authType: "asc" }, { createdAt: "asc" }],
  });
  const reusableByProviderAuth: Record<string, Array<{ id: string; label: string; scope: string }>> = {};
  for (const cn of reusableConns) {
    const key = `${cn.provider}:${cn.authType}`;
    if (!reusableByProviderAuth[key]) reusableByProviderAuth[key] = [];
    reusableByProviderAuth[key].push({ id: cn.id, label: cn.label, scope: cn.scope });
  }

  // Flash banner after a successful reconnect (OAuth re-authorization).
  const reauthed = c.req.query("reauthed");
  const reauthBanner = reauthed
    ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);margin-bottom:20px;">
         ✓ Re-authorized <code>${escapeHtml(reauthed)}</code>. The connection's access token (and refresh token) have been refreshed.
       </div>`
    : "";

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Edit ${scope} — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>Edit scope ${tenantRow && tenantRow.displayName !== tenantRow.slug ? `${escapeHtml(tenantRow.displayName)} ` : ""}<code>${scope}</code></h1>
      <p style="color:#687385;margin-top:-16px;margin-bottom:24px;">
        Edit the scope's display labels and provider connections. To add a new service, scroll down.
      </p>
      ${reauthBanner}

      <h2 id="codex-mcp">Codex MCP</h2>
      <div class="card">
        <p style="font-size:13px;color:#687385;margin-top:0;">
          Connect this scope to Codex as one MCP server. The generated config is locked to <code>${scope}</code>, so Codex cannot cross into another scope through this entry.
        </p>
        ${codexAgents.length === 0 ? `
          <p>No Codex MCP token exists for this scope yet.</p>
          <form method="post" action="/tenants/${scope}/codex-mcp/create">
            <button type="submit">Create Codex MCP config</button>
          </form>
        ` : `
          <p>${codexAgents.length} token${codexAgents.length === 1 ? "" : "s"} can access this scope. Use the first one for the default Codex config.</p>
          ${mcpConfigBlock(mcpOrigin(c), codexAgents[0].name, `${codexAgents[0].tokenPrefix}...ROTATE_TO_VIEW_FULL_TOKEN`, false, scope)}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Internal token</th><th>Status</th><th>Last used</th><th>Created</th><th>Action</th></tr></thead>
              <tbody>
                ${codexAgents.map((a) => `
                  <tr>
                    <td><code>${escapeHtml(a.name)}</code><br><span style="color:#687385;font-size:12px;"><code>${escapeHtml(a.tokenPrefix)}...</code></span></td>
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

        <h2>Scope</h2>
        <div class="card">
          <p class="field-hint" style="margin-top:0;">
            The slug <code>${scope}</code> is the wire key agents send as <code>scope</code> / <code>X-Grantry-Scope</code> — it cannot be changed.
            The display name is only for dashboards and can be renamed freely.
          </p>
          <label for="tenant_display_name">Display name</label>
          <input type="text" name="tenant_display_name" id="tenant_display_name" value="${escapeHtml(tenantRow?.displayName ?? scope)}" placeholder="${scope}">
          <label for="tenant_description" style="margin-top:8px;">Description</label>
          <input type="text" name="tenant_description" id="tenant_description" value="${escapeHtml(tenantRow?.description ?? "")}" placeholder="What this scope is for">
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
                  ${renderDwdInfo(cn)}
                  ${cn.provider === "google_ads" ? `
                    <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #e3e8ee;">
                      <div class="field-hint" style="margin-bottom:6px;">
                        Google Ads Developer token:
                        ${cn.encryptedServerCredential || process.env.GOOGLE_ADS_DEVELOPER_TOKEN
                          ? '<span class="badge ok">set</span>'
                          : '<span class="badge denied">missing</span>'}
                      </div>
                      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
                        <input type="password" name="conn_server_credential_${cn.id}" placeholder="Paste Developer token from Google Ads API Center" style="font-size:13px;margin-bottom:0;">
                        <button type="submit" style="font-size:13px;white-space:nowrap;">Save token</button>
                      </div>
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
          <p class="field-hint">↻ <b>Reconnect</b> re-runs the provider's OAuth consent screen and refreshes this connection's access/refresh tokens in place. <b>Delete</b> removes only that credential connection; agents remain.</p>
        </div>`}

        <h2>Connection grants</h2>
        <div class="card">
          <p class="field-hint" style="margin-top:0;">Agents use explicit connection grants. Provider permissions come from each credential itself; Grantry does not maintain separate per-tool switches here.</p>
          ${connections.length === 0 ? '<div class="empty">No provider connections yet.</div>' : `<p>${connections.length} connection(s) available for this scope.</p>`}
        </div>

        <div style="display:flex;gap:8px;margin-bottom:32px;">
          <button type="submit">Save settings</button>
          <a href="/tenants" class="btn secondary">Cancel</a>
        </div>
      </form>
      ${connections.map((cn) => `
        <form id="recheck_connection_${cn.id}" method="post" action="/tenants/${scope}/connections/${cn.id}/recheck"></form>
        <form id="delete_connection_${cn.id}" method="post" action="/tenants/${scope}/connections/${cn.id}/delete" onsubmit="return confirm(${jsString(`Delete connection ${cn.label}?\n\nProvider: ${cn.provider}\nScope: ${cn.scope}\n\nRelated agent connection grants will be removed automatically.`)});"></form>
      `).join("")}

      <h2>Advanced: additional agent token</h2>
      <div class="card">
        <p class="field-hint" style="margin-top:0;">Most users should use <b>Codex MCP</b> above. This creates an extra internal agent token with grants to this scope's enabled connections.</p>
        <form method="post" action="/tenants/${scope}/agents/new" id="addAgentForm">
          <div class="field">
            <label for="agent">Agent name</label>
            <input type="text" name="agent" id="agent" pattern="[a-zA-Z0-9_-]+" placeholder="e.g. ${escapeHtml(scope)}-read-bot" required>
            <div class="field-hint">Globally unique. Suggestions: <code>${escapeHtml(scope)}-read</code>, <code>${escapeHtml(scope)}-write</code>, <code>${escapeHtml(scope)}-ci</code>.</div>
          </div>
          <div class="field">
            <label for="agent_desc">Description <span style="color:#687385;">(optional)</span></label>
            <input type="text" name="agent_desc" id="agent_desc" placeholder="What this agent is for">
          </div>
          <p class="field-hint">Tool visibility is derived from this scope's granted connections. Provider credentials may still reject calls if their own permissions are narrower.</p>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="secondary">Create additional token</button>
          </div>
        </form>
      </div>

      <h2 style="color:#df1b41;">Danger zone</h2>
      <div class="card" style="border-color:#df1b41;">
        <p>Delete this scope entirely. This removes <b>all your connections</b> for scope <code>${scope}</code>; related agent connection grants are removed automatically.</p>
        <form method="post" action="/tenants/${scope}/delete" onsubmit="return confirm('Delete scope ${scope}?\\n\\nThis removes all YOUR connections for this scope and related grants. This action cannot be undone.');">
          <button type="submit" style="background:#df1b41;color:#ffffff;">🗑 Delete scope ${scope}</button>
        </form>
      </div>

      <h2>Add a service</h2>
      ${availableToAdd.length === 0 ? `
      <div class="card">
        <div class="empty">All enabled provider/auth combinations are already connected for this scope.</div>
        <p class="field-hint" style="text-align:center;margin-top:14px;">Enable or add providers from <a href="/providers">Providers</a>.</p>
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
            <label for="providerBtn">Provider</label>
            <div class="combo" id="providerCombo">
              <input type="hidden" name="provider" id="provider" value="${availableToAdd[0].provider.key}" required>
              <input type="hidden" id="providerAuth" value="${availableToAdd[0].authType}">
              <button type="button" class="combo-btn" id="providerBtn" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="providerList">
                <span class="combo-icon" id="providerIconBox" style="display:inline-flex;flex-shrink:0;">${providerIcon(availableToAdd[0].provider.key, 24)}</span>
                <span class="combo-label" id="providerBtnLabel">${availableToAdd[0].provider.label} (${authTypeLabel(availableToAdd[0].provider.key, availableToAdd[0].authType)})</span>
                <span class="combo-caret" aria-hidden="true">▾</span>
              </button>
              <ul class="combo-list" id="providerList" role="listbox" hidden>
                <li class="combo-search-row" role="presentation"><input type="text" id="providerSearch" placeholder="Search providers…" autocomplete="off" aria-label="Search providers"></li>
                ${availableToAdd.map(({ provider: p, authType }, i) => `<li class="combo-opt" role="option" data-value="${p.key}" data-auth-type="${authType}" data-search="${escapeHtml((p.label + " " + p.key + " " + authType).toLowerCase())}" aria-selected="${i === 0 ? "true" : "false"}"><span class="combo-icon">${providerIcon(p.key, 24)}</span><span class="combo-opt-text">${p.label} (${authTypeLabel(p.key, authType)})</span></li>`).join("")}
                <li class="combo-empty" role="presentation" id="providerSearchEmpty" hidden>No providers match.</li>
              </ul>
            </div>
          </div>
          <input type="hidden" name="auth_method" id="authMethodHidden" value="">
          <div class="field" id="credFieldRow">
            <label for="credential">Credential</label>
            <textarea name="credential" id="credential" rows="3"></textarea>
            <div class="field-hint" id="credHint"></div>
            <div class="field-hint" id="reuseHint"></div>
            <div id="patLinkRow" style="margin-top:6px;display:none;">
              <a id="patLink" href="#" target="_blank" rel="noopener" style="font-size:13px;">🔗 Get a new token here →</a>
            </div>
            <div id="oauthSetupLinkRow" style="margin-top:6px;display:none;">
              <a id="oauthSetupLink" href="#" target="_blank" rel="noopener" style="font-size:13px;">🔗 Register/manage OAuth app here →</a>
            </div>
          </div>
          <div class="field" id="oauthAppFieldRow" style="display:none;">
            <label>OAuth app settings</label>
            <div class="field-hint" style="margin-top:0;">Create the OAuth app in the provider console, copy the redirect URI below into that app, then paste the issued Client ID and Client Secret here.</div>
            <div class="field" style="margin-bottom:10px;">
              <label for="oauthRedirectUri">Redirect URI</label>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" id="oauthRedirectUri" readonly value="" style="font-family:monospace;">
                <button type="button" class="secondary" id="copyOauthRedirectUri" style="white-space:nowrap;">Copy</button>
              </div>
            </div>
            <div class="field" style="margin-bottom:10px;">
              <label for="oauthClientId">Client ID</label>
              <input type="text" name="oauth_client_id" id="oauthClientId" autocomplete="off" placeholder="Client ID">
            </div>
            <div class="field" style="margin-bottom:10px;">
              <label for="oauthClientSecret">Client Secret</label>
              <input type="password" name="oauth_client_secret" id="oauthClientSecret" autocomplete="off" placeholder="Client Secret">
            </div>
            <div class="field" style="margin-bottom:0;">
              <label for="oauthClientAuthMethod">Client authentication method</label>
              <select name="oauth_client_auth_method" id="oauthClientAuthMethod">
                <option value="CLIENT_SECRET_BASIC">CLIENT_SECRET_BASIC</option>
                <option value="CLIENT_SECRET_POST">CLIENT_SECRET_POST</option>
              </select>
            </div>
            <div id="oauthAppSetupLinkRow" style="margin-top:8px;display:none;">
              <a id="oauthAppSetupLink" href="#" target="_blank" rel="noopener" style="font-size:13px;">🔗 Register/manage OAuth app here →</a>
            </div>
          </div>
          <div class="field-hint" id="serverCredentialHint"></div>
          <div class="field" id="subjectFieldRow" style="display:none;">
            <label for="subject">Impersonate admin email (subject)</label>
            <input type="text" name="subject" id="subject" autocomplete="off" placeholder="admin@customer-domain.com">
            <div class="field-hint">The Workspace admin whose authority the service account acts as (Domain-Wide Delegation). Must be a real admin in the customer's domain.</div>
          </div>
          <p class="field-hint">This creates a provider connection. Agents get access when this connection is granted to them; provider permissions are enforced by the credential itself.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="submit" id="addServiceButton">Add service</button>
        </div>
      </form>
      <script>
        const PROVIDERS = ${JSON.stringify(Object.fromEntries(providers.map(p => [p.key, p])))};
        const PROVIDER_ICONS = ${JSON.stringify(providerIconMap(24))};
        const REUSABLE_BY_PROVIDER_AUTH = ${JSON.stringify(reusableByProviderAuth)};
        const WORKSPACE_OAUTH_APP_PROVIDERS = new Set(${JSON.stringify(workspaceOAuthAppProviderKeys())});
        const DEFAULT_OAUTH_CLIENT_AUTH_METHOD_BY_PROVIDER = ${JSON.stringify(defaultOAuthClientAuthMethodsByProvider())};
        const OAUTH_REDIRECT_ORIGIN = ${JSON.stringify(String(process.env.BETTER_AUTH_URL || publicOrigin(c)).replace(/\/+$/, ""))};
        const providerIconBox = document.getElementById('providerIconBox');
        const sel = document.getElementById('provider');
        const providerAuth = document.getElementById('providerAuth');
        const providerCombo = document.getElementById('providerCombo');
        const providerBtn = document.getElementById('providerBtn');
        const providerList = document.getElementById('providerList');
        const providerBtnLabel = document.getElementById('providerBtnLabel');
        const providerOpts = Array.from(providerList.querySelectorAll('.combo-opt'));
        const providerSearch = document.getElementById('providerSearch');
        const providerSearchEmpty = document.getElementById('providerSearchEmpty');
        const credHint = document.getElementById('credHint');
        const reuseHint = document.getElementById('reuseHint');
        const credField = document.getElementById('credential');
        const credFieldRow = document.getElementById('credFieldRow');
        const serverCredentialHint = document.getElementById('serverCredentialHint');
        const authMethodHidden = document.getElementById('authMethodHidden');
        const patLinkRow = document.getElementById('patLinkRow');
        const patLink = document.getElementById('patLink');
        const oauthSetupLinkRow = document.getElementById('oauthSetupLinkRow');
        const oauthSetupLink = document.getElementById('oauthSetupLink');
        const oauthAppFieldRow = document.getElementById('oauthAppFieldRow');
        const oauthRedirectUri = document.getElementById('oauthRedirectUri');
        const oauthClientId = document.getElementById('oauthClientId');
        const oauthClientSecret = document.getElementById('oauthClientSecret');
        const oauthClientAuthMethod = document.getElementById('oauthClientAuthMethod');
        const oauthAppSetupLinkRow = document.getElementById('oauthAppSetupLinkRow');
        const oauthAppSetupLink = document.getElementById('oauthAppSetupLink');
        const addServiceButton = document.getElementById('addServiceButton');
        const subjectFieldRow = document.getElementById('subjectFieldRow');
        const subjectField = document.getElementById('subject');
        function escapeText(s) {
          return String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
        }

        function updateUI() {
          const p = PROVIDERS[sel.value];
          if (!p) return;
          if (providerIconBox) providerIconBox.innerHTML = PROVIDER_ICONS[sel.value] || '';
          const authType = providerAuth.value;
          authMethodHidden.value = authType;
          const usePat = authType === "pat";
          const useOauth = authType === "oauth";
          const useSa = authType === "service_account";
          const needsWorkspaceOAuthApp = useOauth && WORKSPACE_OAUTH_APP_PROVIDERS.has(sel.value);
          const reusable = REUSABLE_BY_PROVIDER_AUTH[sel.value + ':' + authType] || [];
          credHint.textContent = p.helpText;
          if (reuseHint) {
            reuseHint.innerHTML = usePat && reusable.length
              ? 'Leave blank to use an existing workspace connection: ' + reusable.slice(0, 3).map(c => '<code>' + escapeText(c.label) + '</code> <span style="color:#8792a2;">(' + escapeText(c.scope) + ')</span>').join(', ') + (reusable.length > 3 ? ' ...' : '')
              : '';
          }
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
          credField.placeholder = useSa
            ? "Paste the full service account JSON key file ({ \\"type\\": \\"service_account\\", ... })"
            : "Paste your " + tokenLabel + (sel.value === "hubspot" ? " here (starts with pat-)" : " here");
          credField.disabled = false;
          credField.required = (usePat && reusable.length === 0) || useSa;
          credFieldRow.style.opacity = "1";
          credFieldRow.style.display = useOauth ? "none" : "";
          if (oauthAppFieldRow) {
            oauthAppFieldRow.style.display = needsWorkspaceOAuthApp ? "" : "none";
            if (oauthRedirectUri) oauthRedirectUri.value = OAUTH_REDIRECT_ORIGIN + "/oauth/" + sel.value + "/callback";
            if (oauthClientId) oauthClientId.required = needsWorkspaceOAuthApp;
            if (oauthClientSecret) oauthClientSecret.required = needsWorkspaceOAuthApp;
            if (oauthClientAuthMethod && useOauth) oauthClientAuthMethod.value = DEFAULT_OAUTH_CLIENT_AUTH_METHOD_BY_PROVIDER[sel.value] || "CLIENT_SECRET_POST";
            if (!needsWorkspaceOAuthApp) {
              if (oauthClientId) oauthClientId.value = "";
              if (oauthClientSecret) oauthClientSecret.value = "";
            }
          }
          addServiceButton.textContent = useOauth ? "Connect with OAuth" : "Add service";
          if (!usePat && !useSa && !useOauth) credField.value = "";
          if (subjectFieldRow) subjectFieldRow.style.display = useSa ? "" : "none";
          if (subjectField) { subjectField.required = useSa; if (!useSa) subjectField.value = ""; }
          if (useSa) credHint.textContent = "Domain-Wide Delegation: the customer's Workspace admin authorizes this service account's client ID + scopes once in their Admin console. No per-user OAuth, no 7-day token expiry.";
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
          if (useOauth && needsWorkspaceOAuthApp && p.oauthSetupUrl) {
            oauthSetupLink.href = p.oauthSetupUrl;
            oauthSetupLink.textContent = sel.value === "google_ads"
              ? "🔗 Register/manage Google OAuth client here →"
              : (sel.value === "yahoo_ads" ? "🔗 Register/manage LINE Yahoo Ads application here →" : "🔗 Register/manage your " + p.label + " OAuth app here →");
            oauthSetupLinkRow.style.display = "";
            if (oauthAppSetupLinkRow && oauthAppSetupLink) {
              oauthAppSetupLink.href = p.oauthSetupUrl;
              oauthAppSetupLink.textContent = sel.value === "google_ads"
                ? "🔗 Register/manage Google OAuth client here →"
                : (sel.value === "yahoo_ads" ? "🔗 Register/manage LINE Yahoo Ads application here →" : "🔗 Register/manage your " + p.label + " OAuth app here →");
              oauthAppSetupLinkRow.style.display = "";
            }
          } else if (useSa && p.oauthSetupUrl) {
            oauthSetupLink.href = "https://console.cloud.google.com/iam-admin/serviceaccounts";
            oauthSetupLink.textContent = "🔗 Create/manage the service account & JSON key here →";
            oauthSetupLinkRow.style.display = "";
            if (oauthAppSetupLinkRow) oauthAppSetupLinkRow.style.display = "none";
          } else {
            oauthSetupLinkRow.style.display = "none";
            if (oauthAppSetupLinkRow) oauthAppSetupLinkRow.style.display = "none";
          }
        }
        const copyOauthRedirectUri = document.getElementById('copyOauthRedirectUri');
        if (copyOauthRedirectUri) {
          copyOauthRedirectUri.addEventListener('click', async () => {
            if (!oauthRedirectUri) return;
            try {
              await navigator.clipboard.writeText(oauthRedirectUri.value);
              copyOauthRedirectUri.textContent = "Copied";
              setTimeout(() => { copyOauthRedirectUri.textContent = "Copy"; }, 1200);
            } catch {
              oauthRedirectUri.select();
              document.execCommand('copy');
            }
          });
        }
        function closeProviderList() {
          providerList.hidden = true;
          providerBtn.setAttribute('aria-expanded', 'false');
        }
        function openProviderList() {
          providerList.hidden = false;
          providerBtn.setAttribute('aria-expanded', 'true');
          if (providerSearch) { providerSearch.value = ''; filterProviderOpts(); providerSearch.focus(); }
          const active = providerList.querySelector('.combo-opt[aria-selected="true"]') || providerOpts[0];
          if (active) active.scrollIntoView({ block: 'nearest' });
        }
        // Filter dropdown options against the search box (matches label, key,
        // and auth type). Returns the visible options.
        function filterProviderOpts() {
          const q = (providerSearch ? providerSearch.value : '').toLowerCase().trim();
          const terms = q.split(/\\s+/).filter(Boolean);
          let visible = 0;
          providerOpts.forEach((opt) => {
            const hay = opt.dataset.search || '';
            const match = terms.every(t => hay.indexOf(t) !== -1);
            opt.hidden = !match;
            if (match) visible++;
          });
          if (providerSearchEmpty) providerSearchEmpty.hidden = visible !== 0;
          return providerOpts.filter(o => !o.hidden);
        }
        if (providerSearch) {
          providerSearch.addEventListener('input', filterProviderOpts);
          providerSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const vis = providerOpts.filter(o => !o.hidden);
              if (vis.length) { selectProviderOpt(vis[0]); closeProviderList(); providerBtn.focus(); }
            } else if (e.key === 'Escape') {
              closeProviderList(); providerBtn.focus();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const vis = providerOpts.filter(o => !o.hidden);
              if (vis.length) { selectProviderOpt(vis[0]); vis[0].scrollIntoView({ block: 'nearest' }); }
            }
          });
        }
        function selectProviderOpt(opt) {
          providerOpts.forEach((o) => o.setAttribute('aria-selected', String(o === opt)));
          sel.value = opt.dataset.value;
          providerAuth.value = opt.dataset.authType;
          providerBtnLabel.textContent = opt.querySelector('.combo-opt-text').textContent;
          updateUI();
        }
        providerBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (providerList.hidden) openProviderList(); else closeProviderList();
        });
        providerOpts.forEach((opt) => {
          opt.addEventListener('click', () => { selectProviderOpt(opt); closeProviderList(); providerBtn.focus(); });
        });
        document.addEventListener('click', (e) => {
          if (!providerCombo.contains(e.target)) closeProviderList();
        });
        providerBtn.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (providerList.hidden) { openProviderList(); return; }
            const cur = providerList.querySelector('.combo-opt[aria-selected="true"]') || providerOpts[0];
            let idx = providerOpts.indexOf(cur);
            idx = e.key === 'ArrowDown' ? Math.min(providerOpts.length - 1, idx + 1) : Math.max(0, idx - 1);
            selectProviderOpt(providerOpts[idx]);
            providerOpts[idx].scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'Escape') {
            closeProviderList();
          } else if ((e.key === 'Enter' || e.key === ' ') && !providerList.hidden) {
            e.preventDefault();
            closeProviderList();
          }
        });
        updateUI();
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

async function grantConnectionsToAgent(agentId: string, connectionIds: string[], createdById: string) {
  const ids = Array.from(new Set(connectionIds.filter(Boolean)));
  if (!ids.length) return 0;
  let granted = 0;
  for (const connectionId of ids) {
    await prisma.agentConnectionGrant.upsert({
      where: { agentId_connectionId: { agentId, connectionId } },
      create: { agentId, connectionId, createdById },
      update: {},
    });
    granted++;
  }
  return granted;
}

async function grantTenantConnectionsToAgent(userId: string, agentId: string, scope: string) {
  const connections = await prisma.connection.findMany({
    where: { ownerId: userId, scope, enabled: true },
    select: { id: true },
  });
  return grantConnectionsToAgent(agentId, connections.map((cn) => cn.id), userId);
}

async function grantConnectionToTenantAgents(userId: string, scope: string, connectionId: string) {
  const agents = await prisma.agent.findMany({
    where: {
      ownerId: userId,
      connectionGrants: { some: { connection: { scope } } },
    },
    select: { id: true },
  });
  let granted = 0;
  for (const agent of agents) {
    granted += await grantConnectionsToAgent(agent.id, [connectionId], userId);
  }
  return granted;
}

// --- /tenants/:scope/codex-mcp/create ---
dashboardApp.post("/tenants/:scope/codex-mcp/create", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  const tw = await prisma.tenant.findFirst({ where: { ownerId: user.id, slug: scope }, select: { workspaceId: true } });
  const wsId = tw?.workspaceId ?? (await getActiveWorkspaceId(c));
  const existing = await prisma.agent.findFirst({
    where: {
      ownerId: user.id,
      connectionGrants: { some: { connection: { scope } } },
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
      description: `Codex MCP token for scope ${scope}`,
      hashedToken: tokenHash,
      tokenPrefix: token.slice(0, 16),
      ownerId: user.id,
      workspaceId: wsId,
    },
  });
  const granted = await grantTenantConnectionsToAgent(user.id, agent.id, scope);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Codex MCP created — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>Codex MCP ready for <code>${escapeHtml(scope)}</code></h1>
      <div class="card">
        <h2>Internal token</h2>
        <p><code>${escapeHtml(agent.name)}</code> was granted ${granted} connection(s) for <code>${escapeHtml(scope)}</code>.</p>
      </div>
      ${agentTokenCard(token)}
      ${mcpConfigCard(mcpOrigin(c), agent.name, token, true, scope)}
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

  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      ownerId: user.id,
      connectionGrants: { some: { connection: { scope, ownerId: user.id } } },
    },
  });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);

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
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>Codex MCP token rotated for <code>${escapeHtml(scope)}</code></h1>
      ${agentTokenCard(token)}
      ${mcpConfigCard(mcpOrigin(c), agent.name, token, true, scope)}
      <p><a href="/tenants/${scope}/edit#codex-mcp">← Back to ${scope}</a></p>
    </main></body></html>
  `);
});

dashboardApp.post("/tenants/:scope/custom-providers/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  const body = await c.req.parseBody();
  const tenantRow = await prisma.tenant.findFirst({ where: { ownerId: user.id, slug: scope }, select: { workspaceId: true } });
  const wsId = tenantRow?.workspaceId ?? (await getActiveWorkspaceId(c));
  if (!wsId) return c.html("<h1>workspace required</h1>", 400);
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.html("<h1>workspace admin required</h1>", 403);
  const errorResponse = await createWorkspaceCustomProvider(c, wsId, user.id, body, `/tenants/${scope}/edit`);
  if (errorResponse) return errorResponse;
  return c.redirect("/providers");
});

dashboardApp.post("/tenants/:scope/custom-providers/:providerId/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  const providerId = c.req.param("providerId");
  const tenantRow = await prisma.tenant.findFirst({ where: { ownerId: user.id, slug: scope }, select: { workspaceId: true } });
  const wsId = tenantRow?.workspaceId ?? (await getActiveWorkspaceId(c));
  if (!wsId) return c.html("<h1>workspace required</h1>", 400);
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.html("<h1>workspace admin required</h1>", 403);
  const row = await prisma.customProvider.findFirst({ where: { id: providerId, workspaceId: wsId } });
  if (row) {
    await prisma.$transaction([
      prisma.customProvider.delete({ where: { id: row.id } }),
      prisma.workspaceProvider.deleteMany({ where: { workspaceId: wsId, providerKey: row.key } }),
    ]);
  }
  return c.redirect("/providers");
});

dashboardApp.post("/tenants/:scope/edit", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const scope = c.req.param("scope");
  const userIdShort = user.id.slice(0, 8);
  const body = await c.req.parseBody();
  const action = String(body._action ?? "").trim();

  // Connection updates belong to the tenant's own workspace, not
  // whatever workspace happens to be active in the cookie.
  const tw = await prisma.tenant.findFirst({ where: { ownerId: user.id, slug: scope }, select: { workspaceId: true } });
  const wsId = tw?.workspaceId ?? (await getActiveWorkspaceId(c));

  // --- save_settings: update connection labels/enabled + role desc/tools/scopes ---
  if (action === "save_settings") {
    // Tenant display name/description. The slug itself is immutable (wire key).
    if (body.tenant_display_name !== undefined || body.tenant_description !== undefined) {
      const tenantRow = await ensureTenant(user.id, scope, undefined, wsId);
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
          const updated = await prisma.connection.update({
            where: { id: cn.id },
            data: updateData,
          });
          if (serverCredential || clearServerCredential) await syncProviderCredentialFromConnection(updated);
          connUpdates.push({ id: cn.id, label: newLabel, enabled: newEnabled });
        }
      }
    }

    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Saved — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>✓ Settings saved for <code>${scope}</code></h1>
        <div class="card">
          <h2>Connections updated (${connUpdates.length})</h2>
          ${connUpdates.length === 0 ? '<p><em>No changes.</em></p>' : `
          <ul>${connUpdates.map((u) => `<li><code>${escapeHtml(u.label)}</code> · ${u.enabled ? "enabled" : "DISABLED"}</li>`).join("")}</ul>
          `}
        </div>
        <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a> · <a href="/tenants">All scopes</a></p>
      </main></body></html>
    `);
  }

  // --- add_service: add a new provider connection (existing behavior) ---
  if (action === "add_service") {
    const provider = String(body.provider ?? "").trim();
    const authMethod = String(body.auth_method ?? "").trim();
    let credential = String(body.credential ?? "").trim();

    const providerDef = await getProviderForWorkspace(provider, wsId);
    if (!providerDef) return c.html("<h1>unknown provider</h1>", 400);
    if (!(await workspaceProviderEnabled(wsId, provider))) {
      return c.html(`<h1>provider disabled for this workspace</h1><p>Enable <code>${escapeHtml(provider)}</code> from <a href="/providers">Providers</a> before adding it to a scope.</p>`, 400);
    }
    if (providerDef.implemented === false) return c.html("<h1>provider not implemented</h1>", 400);
    // Explicit auth_method from the form is authoritative; the includes()-based
    // inference is only a fallback for providers with a single auth method.
    const wantsSa = authMethod === "service_account";
    const wantsOauth = authMethod === "oauth" || (!authMethod && providerDef.authTypes.includes("oauth") && !providerDef.authTypes.includes("pat") && !providerDef.authTypes.includes("service_account"));
    const wantsPat = authMethod === "pat" || (!authMethod && providerDef.authTypes.includes("pat") && !providerDef.authTypes.includes("oauth"));
    if (wantsOauth) {
      const structuredOAuthAppCredential = oauthAppCredentialFromStructuredFields(body, "", defaultOAuthClientAuthMethod(provider, providerDef));
      if (structuredOAuthAppCredential) credential = structuredOAuthAppCredential;
    }

    // --- service_account (Domain-Wide Delegation) ---
    if (wantsSa) {
      if (!providerDef.authTypes.includes("service_account")) return c.html("<h1>service account is not supported for this provider</h1>", 400);
      const subject = String(body.subject ?? "").trim();
      let saCred;
      try {
        saCred = parseServiceAccountInput(credential, subject);
      } catch (e: any) {
        return c.html(`<h1>Invalid service account credential</h1><p>${escapeHtml(String(e?.message ?? e))}</p><p><a href="/tenants/${scope}/edit">← Back</a></p>`, 400);
      }
      const scopes = providerDef.dwdScopes ?? [];
      const blob = JSON.stringify({ sa_key: saCred.sa_key, subject: saCred.subject });
      const credentialMetadata = JSON.stringify({ kind: "service_account", ...serviceAccountPublicMeta(saCred, scopes) });
      const tenantRow = await ensureTenant(user.id, scope, undefined, wsId);
      const existingSa = await prisma.connection.findFirst({
        where: { provider, authType: "service_account", scope, ownerId: user.id },
      });
      const saData = {
        encryptedCredential: encrypt(blob),
        refreshToken: null,
        accessTokenExpiresAt: null,
        credentialMetadata,
        credentialValidatedAt: null,
      };
      const conn = existingSa
        ? await prisma.connection.update({ where: { id: existingSa.id }, data: saData })
        : await prisma.connection.create({
            data: {
              provider,
              authType: "service_account",
              label: `${provider}-${scope}-service_account`,
              scope,
              tenantId: tenantRow.id,
              ownerId: user.id,
              workspaceId: tenantRow.workspaceId ?? wsId,
              ...saData,
            },
          });
      invalidateDwdToken(conn.id);
      await ensureProviderCredentialForConnection(conn, user.id);
      await syncProviderCredentialFromConnection(conn);
      await grantConnectionToTenantAgents(user.id, scope, conn.id);

      const clientId = saCred.sa_key.client_id ?? "";
      return c.html(`
        <!doctype html><html><head><meta charset="utf-8"><title>Service account added — grantry</title>
        ${FAVICON}<style>${CSS}</style></head><body>
        ${NAV("tenants", user?.email)}
        <main>
          <h1>✓ Service account connected to <code>${escapeHtml(scope)}</code></h1>
          <div class="card">
            <h2>${escapeHtml(providerDef.label)} · Domain-Wide Delegation</h2>
            <p>Connection <code>${escapeHtml(conn.label)}</code> · impersonating <code>${escapeHtml(saCred.subject)}</code></p>
            <p>The customer's Workspace admin must authorize this in <strong>Admin console → Security → Access and data control → API controls → Domain-wide delegation</strong>:</p>
            <p><strong>Client ID</strong>: <code>${escapeHtml(clientId)}</code></p>
            <p><strong>OAuth scopes</strong> (comma-separated):</p>
            <textarea rows="4" readonly style="width:100%;font-family:monospace;font-size:12px;">${escapeHtml(scopes.join(","))}</textarea>
          </div>
          <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a> · <a href="/tenants">All scopes</a></p>
        </main></body></html>
      `);
    }

    if (!wantsPat && !wantsSa && !wantsOauth && credential) {
      return c.html("<h1>pasted credentials are not accepted for this OAuth-only provider</h1>", 400);
    }
    if (wantsOauth) {
      if (!providerDef.authTypes.includes("oauth")) return c.html("<h1>OAuth is not supported for this provider</h1>", 400);
      let oauthAppCredentialId = "";
      if (credential) {
        try {
          const oauthAppCredential = await upsertWorkspaceOAuthAppCredential({
            workspaceId: wsId,
            ownerId: user.id,
            providerKey: provider,
            providerDef,
            rawCredential: credential,
          });
          oauthAppCredentialId = oauthAppCredential?.id || "";
        } catch (e: any) {
          return c.html(`<h1>Invalid OAuth app credential</h1><p>${escapeHtml(String(e?.message ?? e))}</p><p><a href="/tenants/${scope}/edit">← Back</a></p>`, 400);
        }
      }
      const params = new URLSearchParams({ tenant: scope, reauth: "1" });
      if (oauthAppCredentialId) params.set("oauth_app_credential_id", oauthAppCredentialId);
      return c.redirect(`/oauth/${provider}/start?${params.toString()}`);
    }
    if (!wantsPat || !providerDef.authTypes.includes("pat")) return c.html("<h1>paste token is not supported for this provider</h1>", 400);

    // 1) Create or rotate the PAT connection for this provider/auth type.
    const tenantRow = await ensureTenant(user.id, scope, undefined, wsId);
    const existingConn = await prisma.connection.findFirst({
      where: { provider, authType: "pat", scope, ownerId: user.id },
    });
    let conn;
    if (credential) {
      const credentialMeta = await credentialMetadataForProviderDef(providerDef, "pat", credential);
      conn = existingConn
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
              workspaceId: tenantRow.workspaceId ?? wsId,
              encryptedCredential: encrypt(credential),
              ...credentialMeta,
            },
          });
      await ensureProviderCredentialForConnection(conn, user.id);
      await syncProviderCredentialFromConnection(conn);
    } else if (existingConn) {
      conn = existingConn;
      await ensureProviderCredentialForConnection(existingConn, user.id);
    } else {
      const reusableConnsForProvider = await prisma.connection.findMany({
        where: {
          provider,
          authType: "pat",
          ownerId: user.id,
          workspaceId: tenantRow.workspaceId ?? wsId,
          enabled: true,
          scope: { not: scope },
        },
        orderBy: { createdAt: "asc" },
      });
      if (reusableConnsForProvider.length > 1) {
        return c.html(`<h1>multiple existing ${escapeHtml(providerDef.label)} connections</h1><p>Paste a new credential for now, or delete/disable the extra existing connection so Grantry can safely infer which one to reuse.</p><p><a href="/tenants/${scope}/edit">Back</a></p>`, 400);
      }
      const reusableConn = reusableConnsForProvider[0];
      if (!reusableConn) return c.html(`<h1>credential required for ${escapeHtml(providerDef.label)}</h1>`, 400);
      conn = await createTenantConnectionFromCredential({
        tenant: tenantRow,
        sourceConnection: reusableConn,
        createdById: user.id,
      });
    }
    await grantConnectionToTenantAgents(user.id, scope, conn.id);

    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Service added — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>✓ Service added to <code>${scope}</code></h1>
        <div class="card">
          <h2>New connection</h2>
          <p><code>${conn.label}</code> · scope=<code>${conn.scope}</code></p>
        </div>
        <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a> · <a href="/tenants">All scopes</a></p>
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

  // Service account: the stored blob is the SA key + subject, not a bearer token.
  // Validate by actually minting a DWD access token for the provider's scopes;
  // surface Google's error (usually unauthorized_client) if the admin hasn't
  // registered the client ID + scopes yet.
  if (conn.authType === "service_account") {
    const scopes = getProvider(conn.provider)?.dwdScopes ?? [];
    let ok = false;
    let errorMsg = "";
    try {
      const cred = JSON.parse(decrypt(conn.encryptedCredential)) as ServiceAccountCredential;
      invalidateDwdToken(conn.id);
      await mintDwdAccessToken(conn.id, cred, scopes);
      ok = true;
    } catch (e: any) {
      errorMsg = String(e?.message ?? e);
    }
    const meta = safeJsonObject(conn.credentialMetadata);
    const newMeta = JSON.stringify({ ...meta, status: ok ? "ok" : "error", ...(ok ? {} : { error: errorMsg.slice(0, 300) }) });
    await rotateSharedCredential({
      credentialId: conn.credentialId,
      connectionId: conn.id,
      data: { credentialMetadata: newMeta, credentialValidatedAt: ok ? new Date() : null },
    });
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Connection rechecked — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>${ok ? "✓" : "✗"} Rechecked <code>${escapeHtml(conn.label)}</code></h1>
        <div class="card">
          ${ok
            ? `<p>Successfully minted a Domain-Wide Delegation access token. The delegation is correctly configured.</p>`
            : `<p>Could not mint a token:</p><pre style="white-space:pre-wrap;font-size:12px;">${escapeHtml(errorMsg)}</pre>`}
        </div>
        <p><a href="/tenants/${scope}/edit">← Back to ${escapeHtml(scope)}</a></p>
      </main></body></html>
    `);
  }

  const token = decrypt(conn.encryptedCredential);
  const providerDef = await getProviderForWorkspace(conn.provider, conn.workspaceId);
  if (!providerDef) return c.html(`<h1>unknown provider</h1><p><a href="/tenants/${scope}/edit">← Back</a></p>`, 400);
  const credentialMeta = await credentialMetadataForProviderDef(providerDef, conn.authType, token);
  await rotateSharedCredential({
    credentialId: conn.credentialId,
    connectionId: conn.id,
    data: credentialMeta,
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Connection rechecked — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
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
  invalidateDwdToken(conn.id);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Connection deleted — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Deleted connection <code>${escapeHtml(conn.label)}</code></h1>
      <div class="card">
        <p>Provider <code>${escapeHtml(conn.provider)}</code> was removed from scope <code>${escapeHtml(conn.scope)}</code>.</p>
        <p>Agents were left unchanged. Calls to this provider will be denied until a new connection is added and granted.</p>
      </div>
      <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a></p>
    </main></body></html>
  `);
});

dashboardApp.post("/tenants/new/custom-providers", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const wsId = await getActiveWorkspaceId(c);
  if (!wsId) return c.html("<h1>workspace required</h1>", 400);
  const admin = await requireWsAdmin(c, wsId);
  if (!admin) return c.html("<h1>workspace admin required</h1>", 403);

  const body = await c.req.parseBody();
  const errorResponse = await createWorkspaceCustomProvider(c, wsId, user.id, body, "/providers");
  if (errorResponse) return errorResponse;
  return c.redirect("/providers");
});

// --- /tenants/new ---
dashboardApp.get("/tenants/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const wsId = await getActiveWorkspaceId(c);
  const providers = await listConnectionCandidateProviders(wsId);
  const knownProviders = providers;
  // service_account (DWD) needs a JSON-key paste + subject email, which the
  // multi-provider new-tenant wizard isn't set up to collect. Add it from the
  // tenant edit page (/tenants/:scope/edit) instead.
  const providerAuthOptions = knownProviders.flatMap((p) =>
    p.authTypes.filter((authType) => authType !== "service_account").map((authType) => ({ provider: p, authType }))
  );
  // Get existing tenants (distinct scope values) and which providers each has.
  // We need provider-by-provider info so the wizard can hide the credential
  // field when reusing an existing connection.
  const existingConns = await prisma.connection.findMany({
    where: { ownerId: user.id, ...(wsId ? { workspaceId: wsId } : {}) },
    select: { id: true, scope: true, provider: true, authType: true, label: true },
    orderBy: { scope: "asc" },
  });
  // Map: scope -> { "provider:authType" -> label } so the JS can detect "reusing" mode
  const scopeProviders: Record<string, Record<string, string>> = {};
  for (const c of existingConns) {
    if (!c.scope) continue;
    if (!scopeProviders[c.scope]) scopeProviders[c.scope] = {};
    scopeProviders[c.scope][`${c.provider}:${c.authType}`] = c.label;
  }
  const reusableByProviderAuth: Record<string, Array<{ id: string; label: string; scope: string }>> = {};
  for (const c of existingConns) {
    if (!c.scope) continue;
    const key = `${c.provider}:${c.authType}`;
    if (!reusableByProviderAuth[key]) reusableByProviderAuth[key] = [];
    reusableByProviderAuth[key].push({ id: c.id, label: c.label, scope: c.scope });
  }

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>New scope — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>+ New scope</h1>
      <p style="color:#687385;margin-top:-16px;margin-bottom:24px;">
        Step 1 creates a scope and its provider connections. Step 2 assigns or creates the agent that can use this scope.
      </p>
      <form method="post" action="/tenants/new" id="wizForm">
        <div class="step-card">
          <h2><span class="num">1</span> Scope</h2>
          <div class="field field-primary">
            <label for="tenant">Scope key</label>
            <input type="text" name="tenant" id="tenant" pattern="[a-z0-9_-]+" placeholder="backoffice" title="Lowercase letters, numbers, hyphens and underscores only (a-z 0-9 - _). Use the Display name field below for Japanese or other names." autofocus required>
            <div class="field-hint">lowercase, alphanumeric, hyphens, underscores. Agents send this as <b>scope</b> in API calls — it cannot be changed later, so pick carefully.</div>
            <div class="field-hint" id="tenantWarn" style="display:none;color:#df1b41;"></div>
          </div>
          <div class="field">
            <label for="display_name">Display name (optional)</label>
            <input type="text" name="display_name" id="display_name" placeholder="e.g. Grantry 開発環境">
            <div class="field-hint">Human-facing label shown in dashboards. Unlike the scope key, you can rename this anytime.</div>
          </div>
        </div>

        <div class="step-card">
          <h2><span class="num">2</span> Connections</h2>
          <p class="field-hint" style="margin-top:0;">Pick one or more services to wire into this scope. If this workspace already has a matching connection, leaving the credential blank reuses that existing provider credential for the new scope.</p>
          <p class="field-hint" style="margin-top:-4px;">Only providers enabled in <a href="/providers">Providers</a> are shown here.</p>
          <input type="text" id="providerSearch" placeholder="Search providers… (e.g. notion, github, oauth)" autocomplete="off" style="margin-bottom:12px;">
          <p class="field-hint" id="providerSearchEmpty" style="display:none;margin-top:0;">No providers match your search.</p>
          ${providerAuthOptions.map(({ provider: p, authType }) => {
            const authLabel = authTypeLabel(p.key, authType);
            const hasPat = p.authTypes.includes("pat");
            const hasOauth = p.authTypes.includes("oauth");
            const isImplemented = p.implemented !== false;
            const optionKey = `${p.key}:${authType}`;
            const reusableOptions = reusableByProviderAuth[optionKey] || [];
            const requiresWorkspaceOAuthApp = authType === "oauth" && providerRequiresWorkspaceOAuthApp(p.key, p);
            const redirectUri = authType === "oauth" ? oauthCallbackUrl(c, p.key) : "";
            const defaultClientAuthMethod = authType === "oauth" ? defaultOAuthClientAuthMethod(p.key, p) : "CLIENT_SECRET_POST";
            return `
          <div class="provider-block" data-provider="${p.key}" data-auth-type="${authType}" data-haspat="${hasPat}" data-hasoauth="${hasOauth}" data-implemented="${isImplemented}" style="border:1px solid #e3e8ee;border-radius:8px;padding:12px 16px;margin-bottom:12px;${isImplemented ? "" : "opacity:.62;"}">
            <label style="font-weight:600;display:flex;align-items:center;gap:8px;cursor:${isImplemented ? "pointer" : "not-allowed"};margin:0;">
              <input type="checkbox" class="provider-check" value="${optionKey}" ${isImplemented ? "" : "disabled"}> ${providerIcon(p.key)} ${p.label}
              <span style="color:#687385;font-weight:normal;font-size:13px;">(${authLabel})</span>
              ${reusableOptions.length ? `<span class="badge ok" style="margin-left:auto;">existing connection</span>` : ""}
              ${isImplemented ? "" : '<span class="badge unscoped" style="margin-left:auto;">Coming soon</span>'}
            </label>
            ${isImplemented ? `
            <div class="provider-detail" style="display:none;margin-top:12px;padding-left:24px;">
              ${authType === "pat" ? `
              <div class="field cred-row">
                ${reusableOptions.length ? `
                <label for="reuse_${p.key}_${authType}">Connection</label>
                <select name="reuse_connection_${p.key}_${authType}" id="reuse_${p.key}_${authType}" class="reuse-select">
                  ${reusableOptions.map((cn) => `<option value="${escapeHtml(cn.id)}">Use existing: ${escapeHtml(cn.label)} (${escapeHtml(cn.scope)})</option>`).join("")}
                  <option value="">Paste a new credential instead</option>
                </select>
                <div class="field-hint">Creates a new scope-scoped connection that uses the selected workspace credential.</div>
                ` : ""}
                <label>Credential</label>
                <textarea name="credential_${p.key}_${authType}" class="cred-input" rows="2" placeholder="${escapeHtml(credentialPlaceholder(p.key, p.label, authType))}"></textarea>
                <div class="field-hint">${escapeHtml(p.helpText)}</div>
                ${p.tokenUrl ? `<div style="margin-top:4px;"><a href="${p.tokenUrl}" target="_blank" rel="noopener" style="font-size:13px;">${escapeHtml(tokenLinkLabel(p.key, p.label))}</a></div>` : ""}
                <div class="reusing-notice" style="display:none;margin-top:6px;padding:8px;background:rgba(99,91,255,0.08);border-radius:6px;font-size:13px;">
                  ♻️ Reusing the existing <code class="reusing-label"></code> connection. <a href="#" class="rotate-link" style="margin-left:4px;">rotate credential</a> to paste a new one.
                </div>
              </div>` : ""}
              ${authType === "oauth" ? `
              <div class="field oauth-row">
                <div class="field-hint" style="margin-top:0;">${escapeHtml(p.helpText)} You'll be redirected to authorize after clicking <b>Create scope</b>.</div>
                ${requiresWorkspaceOAuthApp ? `
                <label>OAuth app settings</label>
                <div class="field" style="margin-bottom:10px;">
                  <label for="oauth_redirect_${p.key}_${authType}">Redirect URI</label>
                  <div style="display:flex;gap:8px;align-items:center;">
                    <input type="text" id="oauth_redirect_${p.key}_${authType}" class="oauth-redirect-uri" readonly value="${escapeHtml(redirectUri)}" style="font-family:monospace;">
                    <button type="button" class="secondary copy-oauth-redirect" data-copy-target="oauth_redirect_${p.key}_${authType}" style="white-space:nowrap;">Copy</button>
                  </div>
                  <div class="field-hint">Copy this redirect URI into the OAuth application settings in ${escapeHtml(p.label)}.</div>
                </div>
                <div class="field" style="margin-bottom:10px;">
                  <label for="oauth_client_id_${p.key}_${authType}">Client ID</label>
                  <input type="text" name="oauth_client_id_${p.key}_${authType}" id="oauth_client_id_${p.key}_${authType}" autocomplete="off" placeholder="Client ID" data-oauth-required="${requiresWorkspaceOAuthApp ? "1" : "0"}">
                </div>
                <div class="field" style="margin-bottom:10px;">
                  <label for="oauth_client_secret_${p.key}_${authType}">Client Secret</label>
                  <input type="password" name="oauth_client_secret_${p.key}_${authType}" id="oauth_client_secret_${p.key}_${authType}" autocomplete="off" placeholder="Client Secret" data-oauth-required="${requiresWorkspaceOAuthApp ? "1" : "0"}">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label for="oauth_client_auth_method_${p.key}_${authType}">Client authentication method</label>
                  <select name="oauth_client_auth_method_${p.key}_${authType}" id="oauth_client_auth_method_${p.key}_${authType}">
                    <option value="CLIENT_SECRET_BASIC" ${defaultClientAuthMethod === "CLIENT_SECRET_BASIC" ? "selected" : ""}>CLIENT_SECRET_BASIC</option>
                    <option value="CLIENT_SECRET_POST" ${defaultClientAuthMethod === "CLIENT_SECRET_POST" ? "selected" : ""}>CLIENT_SECRET_POST</option>
                  </select>
                </div>
                <div class="field-hint">Stored on this workspace and used for this provider's OAuth redirects and token refreshes.</div>
                ${serverCredentialHint(p.key)}
                ${p.oauthSetupUrl ? `<div style="margin-top:4px;"><a href="${p.oauthSetupUrl}" target="_blank" rel="noopener" style="font-size:13px;">${p.key === "google_ads" ? "🔗 Register/manage Google OAuth client here →" : p.key === "yahoo_ads" ? "🔗 Register/manage LINE Yahoo Ads application here →" : `🔗 Register/manage your ${p.label} OAuth app here →`}</a></div>` : ""}
                ` : ""}
              </div>` : ""}
              <p class="field-hint" style="margin-bottom:0;">This connection exposes provider tools according to the credential's own permissions.</p>
            </div>
            ` : `
            <div class="field-hint" style="margin:8px 0 0 34px;">Provider registration is defined, but MCP tools and dispatch are not enabled yet.</div>
            `}
          </div>`;
          }).join("")}
          <input type="hidden" name="providers_json" id="providersJson" value="">
          <input type="hidden" name="provider_auths_json" id="providerAuthsJson" value="">
        </div>

        <div style="display:flex;gap:8px;">
          <button type="submit">Create scope</button>
          <a href="/tenants" class="btn secondary">Cancel</a>
        </div>
      </form>
      <script>
        const PROVIDERS = ${JSON.stringify(Object.fromEntries(knownProviders.map(p => [p.key, p])))};
        const SCOPE_PROVIDERS = ${JSON.stringify(scopeProviders)};
        const REUSABLE_BY_PROVIDER_AUTH = ${JSON.stringify(reusableByProviderAuth)};
        const tenantField = document.getElementById('tenant');
        const blocks = Array.from(document.querySelectorAll('.provider-block'));

        // Returns the current scope key from the typed value.
        function getCurrentScope() {
          const typed = tenantField.value.trim();
          return { scope: typed, isExisting: false };
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
          block.querySelectorAll('input[name^="oauth_client_id_"], input[name^="oauth_client_secret_"]').forEach((input) => {
            input.required = !!check.checked && input.dataset.oauthRequired === "1";
          });

          const { scope } = getCurrentScope();
          const existingConnLabel = (SCOPE_PROVIDERS[scope] || {})[key + ':' + authType];
          const reusing = !!existingConnLabel;
          const credRow = block.querySelector('.cred-row');
          const notice = block.querySelector('.reusing-notice');
          const reuseSelect = block.querySelector('.reuse-select');
          if (credRow && notice) {
            const credInput = credRow.querySelector('.cred-input');
            const selectedReuseLabel = reuseSelect && reuseSelect.value
              ? reuseSelect.options[reuseSelect.selectedIndex].text.replace(/^Use existing:\\s*/, '')
              : "";
            if (selectedReuseLabel) {
              credRow.querySelectorAll('a, .field-hint').forEach(el => {
                if (!el.closest || !el.closest('select')) el.style.display = "none";
              });
              credInput.style.display = "none";
              notice.style.display = "";
              notice.querySelector('.reusing-label').textContent = selectedReuseLabel;
              const rotate = notice.querySelector('.rotate-link');
              if (rotate) rotate.onclick = (e) => {
                e.preventDefault();
                if (reuseSelect) reuseSelect.value = "";
                credInput.style.display = "";
                credInput.focus();
                notice.style.display = "none";
              };
            } else if (reusing) {
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

        // Filter provider blocks by a free-text query matched against the
        // provider label, key and auth type. Multiple space-separated terms
        // must all match (AND).
        const providerSearch = document.getElementById('providerSearch');
        const providerSearchEmpty = document.getElementById('providerSearchEmpty');
        function filterProviders() {
          const terms = providerSearch.value.toLowerCase().split(/\\s+/).filter(Boolean);
          let visible = 0;
          blocks.forEach((block) => {
            const key = (block.dataset.provider || '');
            const authType = (block.dataset.authType || '');
            const label = (PROVIDERS[key] ? PROVIDERS[key].label : key).toLowerCase();
            const haystack = key + ' ' + label + ' ' + authType;
            const match = terms.every(t => haystack.indexOf(t) !== -1);
            block.style.display = match ? '' : 'none';
            if (match) visible++;
          });
          providerSearchEmpty.style.display = visible === 0 ? '' : 'none';
        }
        providerSearch.addEventListener('input', filterProviders);

        blocks.forEach((block) => {
          block.querySelector('.provider-check').addEventListener('change', () => updateBlock(block));
          const reuseSelect = block.querySelector('.reuse-select');
          if (reuseSelect) reuseSelect.addEventListener('change', () => updateBlock(block));
        });
        document.querySelectorAll('.copy-oauth-redirect').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const target = document.getElementById(btn.dataset.copyTarget || '');
            if (!target) return;
            try {
              await navigator.clipboard.writeText(target.value);
              btn.textContent = 'Copied';
              setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
            } catch {
              target.select();
              document.execCommand('copy');
            }
          });
        });

        document.getElementById('wizForm').addEventListener('submit', (e) => {
          const selectedProviders = [];
          const selectedProviderAuths = [];
          blocks.forEach((block) => {
            const check = block.querySelector('.provider-check');
            if (!check.checked) return;
            if (check.disabled || block.dataset.implemented === 'false') return;
            const key = block.dataset.provider;
            const authType = block.dataset.authType;
            selectedProviders.push(key);
            selectedProviderAuths.push({ provider: key, authType });
          });
          if (selectedProviders.length === 0) {
            e.preventDefault();
            alert('Select at least one provider.');
            return;
          }
          document.getElementById('providersJson').value = JSON.stringify(selectedProviders);
          document.getElementById('providerAuthsJson').value = JSON.stringify(selectedProviderAuths);
        });
        updateAllBlocks();

        const tenantInput = document.getElementById('tenant');
        const tenantWarn = document.getElementById('tenantWarn');
        const displayNameInput = document.getElementById('display_name');
        // Live-flag non-ASCII scope keys (commonly Japanese) the moment they
        // are typed, instead of waiting for the browser's generic pattern error
        // on submit. Offer to move the value into the Display name field, where
        // any language is fine.
        function checkTenantChars() {
          const v = tenantInput.value;
          if (v && /[^a-z0-9_-]/.test(v)) {
            const slug = v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
            tenantWarn.innerHTML = 'Scope keys allow only <code>a-z 0-9 - _</code>. Japanese and other characters aren\\'t allowed here — put them in <b>Display name</b> below.'
              + (slug ? ' Suggested scope key: <code>' + slug + '</code>' : '')
              + ' <a href="#" id="moveToDisplay">move this to Display name →</a>';
            tenantWarn.style.display = '';
            const mv = document.getElementById('moveToDisplay');
            if (mv) mv.addEventListener('click', (ev) => {
              ev.preventDefault();
              if (displayNameInput && !displayNameInput.value) displayNameInput.value = v;
              tenantInput.value = slug;
              tenantWarn.style.display = 'none';
              updateAllBlocks();
            });
          } else {
            tenantWarn.style.display = 'none';
          }
        }
        tenantInput.addEventListener('input', () => {
          checkTenantChars();
          updateAllBlocks();
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
  // Scope resolution: text input wins over legacy dropdown selection.
  const tenantText = String(body.tenant ?? "").trim();
  const tenantSelect = String(body.tenant_select ?? "").trim();
  const tenant = tenantText || tenantSelect;
  // Optional human-facing name; the slug stays the immutable wire key.
  const tenantDisplayName = String(body.display_name ?? "").trim();
  const wsId = await getActiveWorkspaceId(c);

  // --- Multi-provider parsing ---
  // The wizard submits the chosen providers as a JSON array (providers_json).
  // Per-provider credentials arrive in separate fields named
  // credential_<providerKey>. JSON blobs are used because Hono's parseBody
  // keeps only the last value for repeated keys.
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
    providerAuths = await Promise.all(providers.map(async (provider) => {
      const providerDef = await getProviderForWorkspace(provider, wsId);
      return {
        provider,
        authType: providerDef?.authTypes.includes("oauth") && !providerDef.authTypes.includes("pat") ? "oauth" : "pat",
      };
    }));
  }
  providerAuths = Array.from(
    new Map(providerAuths.map((item) => [`${item.provider}:${item.authType}`, item])).values()
  );

  // Resolve the credential for a given provider (per-provider field first,
  // falling back to the legacy single `credential` field when there's one provider).
  const credentialFor = (p: string, authType = "pat", providerDef?: any) => {
    if (authType === "oauth") {
      const structuredOAuthAppCredential = oauthAppCredentialFromStructuredFields(body, `${p}_${authType}`, defaultOAuthClientAuthMethod(p, providerDef));
      if (structuredOAuthAppCredential) return structuredOAuthAppCredential;
    }
    const specificAuth = String((body as any)[`credential_${p}_${authType}`] ?? "").trim();
    if (specificAuth) return specificAuth;
    const specific = String((body as any)[`credential_${p}`] ?? "").trim();
    if (specific) return specific;
    if (providerAuths.length === 1) return String(body.credential ?? "").trim();
    return "";
  };
  const reuseConnectionIdFor = (p: string, authType = "pat") =>
    String((body as any)[`reuse_connection_${p}_${authType}`] ?? "").trim();
  console.log("[tenants/new POST] scope=", tenant, "providerAuths=", providerAuths);

  if (!/^[a-z0-9_-]+$/.test(tenant)) {
    // The slug is the immutable wire key (agents send it as `scope`), so it
    // must be ASCII [a-z0-9_-]. Non-ASCII input — most commonly a Japanese
    // tenant name — is a frequent mistake, so explain the rule, point at the
    // Display name field, and offer a slugified suggestion when we can derive
    // one from the input (pure-Japanese input slugifies to empty).
    const suggestion = slugifyWorkspace(tenant);
    const hasSuggestion = !!tenant && suggestion !== "workspace";
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Invalid scope key — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>⚠️  Scope key ${tenant ? `<code>${escapeHtml(tenant)}</code> ` : ""}can't be used</h1>
        <div class="card" style="border-color:#df1b41;">
          <p>The <b>scope key</b> is the immutable key your agents send with every API call, so it's restricted to <b>lowercase letters, numbers, hyphens, and underscores</b> (<code>a-z 0-9 - _</code>). Japanese and other non-ASCII characters aren't allowed here.</p>
          <p>👉 Put the Japanese (or any human-friendly) name in the <b>Display name</b> field instead — that's shown in dashboards and can be renamed anytime.</p>
          ${hasSuggestion ? `<p>Suggested scope key based on what you typed: <code>${escapeHtml(suggestion)}</code></p>` : `<p>Example: scope key <code>kaihatsu</code> · display name <code>${escapeHtml(tenant || "開発環境")}</code></p>`}
          <p><a href="/tenants/new">← Back to the wizard</a></p>
        </div>
      </main></body></html>
    `, 400);
  }
  if (providers.length === 0) return c.html("<h1>select at least one provider</h1>", 400);
  if (providerAuths.length === 0) return c.html("<h1>select at least one provider</h1>", 400);
  for (const item of providerAuths) {
    const providerDef = await getProviderForWorkspace(item.provider, wsId);
    if (!providerDef) return c.html(`<h1>unknown provider: ${escapeHtml(item.provider)}</h1>`, 400);
    if (!(await workspaceProviderEnabled(wsId, item.provider))) {
      return c.html(`<h1>provider disabled for this workspace</h1><p>Enable <code>${escapeHtml(item.provider)}</code> from <a href="/providers">Providers</a> before adding it to a scope.</p>`, 400);
    }
    if (providerDef.implemented === false) return c.html(`<h1>provider not implemented: ${escapeHtml(providerDef.label)}</h1>`, 400);
    if (!providerDef.authTypes.includes(item.authType as any)) {
      return c.html(`<h1>auth type not supported: ${escapeHtml(item.provider)} / ${escapeHtml(item.authType)}</h1>`, 400);
    }
  }

  // 0) Materialize the tenant entity up front, before any connections. The
  //    OAuth callback later upserts the same (ownerId, slug) and would lose
  //    the display name, so it must be recorded here.
  const tenantRow = await ensureTenant(user.id, tenant, tenantDisplayName, wsId);

  // 1) Resolve each selected provider into either an immediate connection
  //    (PAT pasted, or an existing connection we reuse) or an OAuth step that
  //    must be authorized via a redirect. OAuth providers are queued and
  //    authorized one-by-one after the tenant scaffolding (PAT
  //    connections) is in place; the agent + token are minted at the very end
  //    of that chain. (MUST filter connection lookups by ownerId — otherwise
  //    user B could inherit user A's credential.)
  const connections: Array<{ label: string; scope: string; provider: string }> = [];
  const oauthQueue: Array<{ provider: string; oauthAppCredentialId?: string }> = [];
  for (const { provider, authType } of providerAuths) {
    const providerDef = (await getProviderForWorkspace(provider, wsId))!; // validated above
    const credential = (authType === "pat" || authType === "oauth") ? credentialFor(provider, authType, providerDef) : "";
    const requestedReuseConnectionId = authType === "pat" && !credential ? reuseConnectionIdFor(provider, authType) : "";

    const existingConn = await prisma.connection.findFirst({
      where: { provider, authType, scope: tenant, ownerId: user.id },
    });
    const selectedReusableConn = requestedReuseConnectionId
      ? await prisma.connection.findFirst({
          where: {
            id: requestedReuseConnectionId,
            provider,
            authType,
            ownerId: user.id,
            workspaceId: tenantRow.workspaceId ?? wsId,
            enabled: true,
          },
        })
      : null;
    const reusableConnsForProvider = !existingConn
      ? await prisma.connection.findMany({
          where: {
            provider,
            authType,
            ownerId: user.id,
            workspaceId: tenantRow.workspaceId ?? wsId,
            enabled: true,
            scope: { not: tenant },
          },
          orderBy: { createdAt: "asc" },
        })
      : [];

    // Decide how to authenticate this provider:
    //   - credential pasted           -> create/rotate a PAT connection now
    //   - existing connection, no cred -> reuse as-is
    //   - supports OAuth, no cred      -> queue for OAuth authorization
    //   - PAT-only, no cred, no conn   -> error
    if (authType === "oauth" && providerDef.authTypes.includes("oauth")) {
      let oauthAppCredentialId = "";
      if (credential) {
        try {
          const oauthAppCredential = await upsertWorkspaceOAuthAppCredential({
            workspaceId: tenantRow.workspaceId ?? wsId,
            ownerId: user.id,
            providerKey: provider,
            providerDef,
            rawCredential: credential,
          });
          oauthAppCredentialId = oauthAppCredential?.id || "";
        } catch (e: any) {
          return c.html(`<h1>Invalid OAuth app credential for ${escapeHtml(providerDef.label)}</h1><p>${escapeHtml(String(e?.message ?? e))}</p><p><a href="/tenants/new">Back</a></p>`, 400);
        }
      }
      oauthQueue.push({ provider, oauthAppCredentialId });
    } else if (credential) {
      const credentialMeta = await credentialMetadataForProviderDef(providerDef, "pat", credential);
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
              workspaceId: tenantRow.workspaceId ?? wsId,
              encryptedCredential: encrypt(credential),
              ...credentialMeta,
            },
          });
      await ensureProviderCredentialForConnection(conn, user.id);
      await syncProviderCredentialFromConnection(conn);
      connections.push(conn);
    } else if (existingConn) {
      await ensureProviderCredentialForConnection(existingConn, user.id);
      connections.push(existingConn);
    } else if (requestedReuseConnectionId && !selectedReusableConn) {
      return c.html(`<h1>selected connection cannot be reused</h1><p>The selected ${escapeHtml(providerDef.label)} connection does not belong to this workspace, provider, or auth type.</p><p><a href="/tenants/new">Back</a></p>`, 400);
    } else if (selectedReusableConn) {
      const conn = await createTenantConnectionFromCredential({
        tenant: tenantRow,
        sourceConnection: selectedReusableConn,
        createdById: user.id,
      });
      connections.push(conn);
    } else if (reusableConnsForProvider.length === 1) {
      const conn = await createTenantConnectionFromCredential({
        tenant: tenantRow,
        sourceConnection: reusableConnsForProvider[0],
        createdById: user.id,
      });
      connections.push(conn);
    } else if (reusableConnsForProvider.length > 1) {
      return c.html(`<h1>multiple existing ${escapeHtml(providerDef.label)} connections</h1><p>Paste a new credential for now, or delete/disable the extra existing connection so Grantry can safely infer which one to reuse.</p><p><a href="/tenants/new">Back</a></p>`, 400);
    } else {
      return c.html(`<h1>credential required for ${escapeHtml(providerDef.label)}</h1>`, 400);
    }
  }

  // If any selected providers still need OAuth authorization, kick off the
  // OAuth chain. The final callback now redirects to the agent setup step.
  if (oauthQueue.length > 0) {
    const [first, ...rest] = oauthQueue;
    const params = new URLSearchParams({
      tenant,
      tenant_select: tenantSelect,
      oauth_queue: rest.map((item) => item.provider).join(","),
    });
    if (first.oauthAppCredentialId) params.set("oauth_app_credential_id", first.oauthAppCredentialId);
    return c.redirect(`/oauth/${first.provider}/start?${params.toString()}`);
  }

  return c.redirect(`/tenants/${tenant}/agents/setup?created=1&connections=${connections.length}`);
});

// --- /agents ---
dashboardApp.get("/agents", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const wsId = await getActiveWorkspaceId(c);
  const wsWhere = wsId ? { workspaceId: wsId } : {};
  const agents = await prisma.agent.findMany({
    where: { ownerId: user.id, ...wsWhere },
    orderBy: { createdAt: "desc" },
    include: {
      connectionGrants: {
        include: { connection: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Agents — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
    <main>
      <div class="row spread" style="margin-bottom:16px;">
        <h1 style="margin:0;">Agents</h1>
        <a href="/agents/new" class="btn">+ New agent</a>
      </div>
      <form method="post" action="/agents/bulk-delete" id="bulkAgentForm">
        <input type="hidden" name="agent_ids_csv" id="agentIdsCsv" value="">
        <div class="row spread" style="margin-bottom:8px;">
          <label style="font-size:13px;color:#3c4257;cursor:pointer;"><input type="checkbox" id="selAllAgents"> select all</label>
          <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;" id="bulkAgentBtn" disabled>🗑 Delete selected (0)</button>
        </div>
      </form>
      ${agents.length === 0 ? '<div class="card"><div class="empty">No agents yet. <a href="/tenants/new">Create one via the scope wizard</a>.</div></div>' : `
      <div class="card">
        <table>
          <thead><tr><th></th><th>Name</th><th>Token prefix</th><th>Granted connections</th><th>Accessible scopes</th><th>Status</th><th>Last used</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
          ${agents.map((a) => {
            const allScopes = new Set<string>();
            const liveGrants = a.connectionGrants.filter((g) => g.connection.enabled);
            for (const g of liveGrants) allScopes.add(g.connection.scope);
            const scopesDisplay = allScopes.size === 0
              ? '<span class="badge denied">none</span>'
              : Array.from(allScopes).map((s) => `<span class="badge scoped">${s}</span>`).join(" ");
            const grantsDisplay = liveGrants.length === 0
              ? '<em style="color:#df1b41;">no granted connections</em>'
              : `<span class="badge ok">${liveGrants.length}</span>`;
            return `
            <tr>
              <td><input type="checkbox" form="bulkAgentForm" name="agent_ids" value="${a.id}" class="agentCheck"></td>
              <td><code>${a.name}</code></td>
              <td><code>${a.tokenPrefix}...</code></td>
              <td>${grantsDisplay}</td>
              <td>${scopesDisplay}</td>
              <td>${a.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</td>
              <td>${a.lastUsedAt ? a.lastUsedAt.toISOString().slice(0, 16) : "—"}</td>
              <td>${a.createdAt.toISOString().slice(0, 10)}</td>
              <td style="position:relative;white-space:nowrap;">
                <form method="post" action="/agents/${a.id}/rotate" style="display:inline;" onsubmit="return confirm('Rotate token for ${a.name}?\\n\\nThe OLD token will be invalidated immediately. The NEW token will be shown ONCE on the next page.')">
                  <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px;">Rotate</button>
                </form>
                <a href="/agents/${a.id}" class="btn secondary" style="font-size:12px;padding:4px 10px;">Details</a>
                <form method="post" action="/agents/${a.id}/delete" style="display:inline;" onsubmit="return confirm('Delete agent ${a.name}?\\n\\nThis permanently destroys its token and connection grants.')">
                  <button type="submit" style="font-size:12px;padding:4px 10px;background:#df1b41;color:#ffffff;">🗑</button>
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
// The dual of the tenant wizard: instead of tenant -> agent, this flow starts
// from the agent and grants it existing tenant connections. Registered before
// /agents/:id so the static segment wins the route match.
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

  // Union of providers across every tenant, used only for compact UI summaries.
  const allProviders: string[] = [];
  for (const list of providersByScope.values()) {
    for (const p of list) if (!allProviders.includes(p)) allProviders.push(p);
  }
  allProviders.sort();

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>New agent — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("agents")}
    <main>
      <h1>+ New agent</h1>
      <p style="color:#687385;margin-top:-16px;margin-bottom:24px;">
        Create an agent that spans <b>existing</b> scopes — e.g. a manager that reads several business areas with one token.
        To create a new scope, use the <a href="/tenants/new">scope wizard</a> instead.
      </p>
      ${tenants.length === 0 ? `<div class="card"><div class="empty">No scopes yet. <a href="/tenants/new">Create one first</a>.</div></div>` : `
      <form method="post" action="/agents/new" id="agentForm">
        <input type="hidden" name="scopes_json" id="scopesJson" value="[]">
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
              Full-scope manager
              <div class="field-hint" style="margin-top:4px;font-weight:normal;">
                Reach <b>all</b> your scopes with one token — including scopes you create later.
                Grants every enabled scope connection you own. Owner-bounded: only ever your own connections.
              </div>
            </span>
          </label>
        </div>

        <div id="tenantSection">
          <h2>Scope access</h2>
          <p class="field-hint" style="margin-top:-8px;">
            Check the scopes this agent may reach. The agent receives grants to each enabled connection in the selected scopes. Provider permissions still come from the credential itself.
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
            ${providers.length === 0 ? `<div class="empty" style="padding:8px 0;">No enabled connections — selecting this scope grants nothing.</div>` : providers.map((p) => `
            <div style="margin:10px 0 0 28px;">
              <code>${p}</code>
            </div>`).join("")}
          </div>`;
          }).join("")}
        </div>

        <div id="managerSection" style="display:none;">
          <div class="card" style="background:rgba(229,83,75,0.10);border:1px solid rgba(229,83,75,0.5);">
            <h2 style="color:#e5534b;margin-top:0;">⚠ Full-scope access</h2>
            <p style="margin-top:0;">
              This token can use <b>every enabled scope connection you own</b>, including scopes created later.
              If it leaks, your granted footprint is exposed at once.
            </p>
            <label style="cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;">
              <input type="checkbox" id="managerConfirm" name="manager_confirm" style="transform:scale(1.2);">
              I understand this agent reaches all my scopes, present and future.
            </label>
          </div>
          <div class="card">
            <h2>Connections</h2>
            ${allProviders.length === 0 ? '<div class="empty">No enabled connections in any scope.</div>' : `<p>${connections.length} enabled connection(s) across ${providersByScope.size} scope(s) will be granted.</p>`}
          </div>
        </div>

        <div class="card" style="background:rgba(99,91,255,0.08);">
          <h2>👁 What this agent will be able to do</h2>
          <p id="previewText" style="margin-bottom:0;color:#687385;">Select at least one scope above.</p>
        </div>

        <button type="submit" id="createBtn" disabled>🔑 Create agent &amp; mint token</button>
        <p class="field-hint">Connection grants are created for this agent automatically. The token is shown once, right after creation.</p>
      </form>
      <script>
        const managerToggle = document.getElementById('managerToggle');
        const managerConfirm = document.getElementById('managerConfirm');
        const tenantSection = document.getElementById('tenantSection');
        const managerSection = document.getElementById('managerSection');
        const managerModeInput = document.getElementById('managerModeInput');
        const tenantChecks = Array.from(document.querySelectorAll('.tenantCheck'));
        const previewText = document.getElementById('previewText');
        const createBtn = document.getElementById('createBtn');
        const scopesJson = document.getElementById('scopesJson');
        function updateAgentPreview() {
          const manager = managerToggle.checked;
          managerModeInput.value = manager ? '1' : '0';
          tenantSection.style.display = manager ? 'none' : '';
          managerSection.style.display = manager ? '' : 'none';
          if (manager) {
            scopesJson.value = '[]';
            createBtn.textContent = '🔑 Create full-scope manager & mint token';
            if (!managerConfirm.checked) {
              previewText.textContent = 'Tick the confirmation above to enable creation.';
              createBtn.disabled = true;
            } else {
              previewText.innerHTML = '<b>Full-scope manager</b> — all enabled scope connections, including scopes created later. The MCP config has no scope lock; pass <code>scope</code> per call.';
              createBtn.disabled = false;
            }
            return;
          }
          createBtn.textContent = '🔑 Create agent & mint token';
          const scopes = tenantChecks.filter(c => c.checked).map(c => c.value);
          scopesJson.value = JSON.stringify(scopes);
          if (scopes.length === 0) {
            previewText.textContent = 'Select at least one scope above.';
            createBtn.disabled = true;
          } else {
            previewText.innerHTML = 'Scopes: ' + scopes.join(' · ') + '. The MCP config has no scope lock; pass <code>scope</code> per call.';
            createBtn.disabled = false;
          }
        }
        managerToggle.addEventListener('change', updateAgentPreview);
        managerConfirm.addEventListener('change', updateAgentPreview);
        tenantChecks.forEach(c => c.addEventListener('change', updateAgentPreview));
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
  try { scopes = (JSON.parse(String(body.scopes_json ?? "[]")) as unknown[]).map(String); } catch { scopes = []; }
  scopes = Array.from(new Set(scopes.filter((s) => /^[a-z0-9_-]+$/.test(s))));

  if (!agent || !/^[a-zA-Z0-9_-]+$/.test(agent)) return c.html("<h1>agent name required (alphanumeric, hyphens, underscores)</h1>", 400);

  let grantableConnectionCount = 0;
  if (managerMode) {
    if (String(body.manager_confirm ?? "") !== "on") {
      return c.html("<h1>confirm full-scope access to create a manager</h1>", 400);
    }
    scopes = []; // any scope
    const conns = await prisma.connection.findMany({
      where: { ownerId: user.id, enabled: true, scope: { not: "" } },
      select: { id: true },
    });
    grantableConnectionCount = conns.length;
  } else {
    if (scopes.length === 0) return c.html("<h1>select at least one scope</h1>", 400);

    // Every requested scope must be one of the caller's own tenants.
    const ownTenants = await prisma.tenant.findMany({
      where: { ownerId: user.id, slug: { in: scopes } },
      select: { slug: true },
    });
    if (ownTenants.length !== scopes.length) {
      const owned = new Set(ownTenants.map((t) => t.slug));
      const missing = scopes.filter((s) => !owned.has(s));
      return c.html(`<h1>unknown scope(s): ${escapeHtml(missing.join(", "))}</h1>`, 400);
    }

    const conns = await prisma.connection.findMany({
      where: { ownerId: user.id, enabled: true, scope: { in: scopes } },
      select: { id: true },
    });
    grantableConnectionCount = conns.length;
  }
  if (grantableConnectionCount === 0) return c.html("<h1>select at least one scope with an enabled connection</h1>", 400);

  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`<h1>⚠️ Agent name <code>${escapeHtml(agent)}</code> already exists</h1><p>Pick a different name, or <a href="/agents/${existingAgent.id}">reuse the existing agent</a>. <a href="/agents/new">← Back</a></p>`, 409);
  }

  const wsId = await getActiveWorkspaceId(c);
  const token = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then((m) => m.createHash("sha256").update(token).digest("hex"));
  const agentRow = await prisma.agent.create({
    data: {
      name: agent,
      description: agentDesc || null,
      hashedToken: tokenHash,
      tokenPrefix: token.slice(0, 16),
      ownerId: user.id,
      workspaceId: wsId,
      fullScopeManager: managerMode,
    },
  });
  let granted = 0;
  if (managerMode) {
    const conns = await prisma.connection.findMany({
      where: { ownerId: user.id, enabled: true, scope: { not: "" } },
      select: { id: true },
    });
    granted = await grantConnectionsToAgent(agentRow.id, conns.map((cn) => cn.id), user.id);
  } else {
    const conns = await prisma.connection.findMany({
      where: { ownerId: user.id, enabled: true, scope: { in: scopes } },
      select: { id: true },
    });
    granted = await grantConnectionsToAgent(agentRow.id, conns.map((cn) => cn.id), user.id);
  }

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Agent created — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("agents")}
    <main>
      <h1>✓ Agent <code>${escapeHtml(agentRow.name)}</code> created</h1>
      <div class="card">
        <h2>Access</h2>
        <p>${managerMode ? `<span class="badge denied">all present and future scope connections</span>` : `Scopes: ${scopes.map((s) => `<span class="badge scoped">${s}</span>`).join(" ")}`} · granted ${granted} current connection(s)</p>
      </div>
      ${agentTokenCard(token)}
      ${mcpConfigCard(mcpOrigin(c), agentRow.name, token, true)}
      <div class="card">
        <h2>Cross-scope calls</h2>
        <p class="field-hint" style="margin-top:0;">This config has <b>no</b> <code>X-Grantry-Scope</code> lock. Pass the target scope per call:</p>
        <pre>curl -X POST ${mcpOrigin(c)}/mcp \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"connections/list","params":{}}'</pre>
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
    include: { connectionGrants: true },
  });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  const connections = await connectionsForAgent(agent.id);
  const scopeSet = new Set<string>();
  for (const conn of connections) {
    scopeSet.add(conn.scope);
  }
  const scopes = Array.from(scopeSet).sort();
  const grantableConnectionWhere: any = {
    ownerId: user.id,
    enabled: true,
    scope: { not: "" },
  };
  if (agent.workspaceId) grantableConnectionWhere.workspaceId = agent.workspaceId;
  const grantableConnections = await prisma.connection.findMany({
    where: grantableConnectionWhere,
    select: { id: true, provider: true, scope: true },
    orderBy: [{ scope: "asc" }, { provider: "asc" }],
  });
  const addableScopes = Array.from(
    grantableConnections.reduce((acc, conn) => {
      if (scopeSet.has(conn.scope)) return acc;
      const item = acc.get(conn.scope) ?? { scope: conn.scope, providers: new Set<string>(), count: 0 };
      item.providers.add(conn.provider);
      item.count += 1;
      acc.set(conn.scope, item);
      return acc;
    }, new Map<string, { scope: string; providers: Set<string>; count: number }>())
  ).map(([, item]) => item);
  const tokenPlaceholder = `${agent.tokenPrefix}...ROTATE_TO_VIEW_FULL_TOKEN`;

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(agent.name)} — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
    <main>
      <h1>Agent <code>${escapeHtml(agent.name)}</code></h1>
      <div class="card">
        <h2>Connection grants</h2>
        <p>Status: ${agent.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge denied">disabled</span>'}</p>
        <p>Token prefix: <code>${escapeHtml(agent.tokenPrefix)}...</code></p>
        <p>Mode: ${agent.fullScopeManager ? '<span class="badge denied">full-scope manager</span>' : '<span class="badge scoped">selected scopes</span>'}</p>
        <p>Granted connections: ${connections.length
          ? `<span class="badge ok">${connections.length}</span>`
          : '<span class="badge denied">none</span>'}</p>
        <p>Accessible scopes: ${scopeSet.size
          ? Array.from(scopeSet).sort().map((s) => `<span class="badge scoped">${escapeHtml(s)}</span>`).join(" ")
          : '<span class="badge denied">none</span>'}</p>
      </div>
      <div class="card">
        <h2>Add existing scopes</h2>
        ${addableScopes.length === 0 ? '<div class="empty">No ungranted scopes with enabled connections are available for this agent.</div>' : `
        <form method="post" action="/agents/${escapeHtml(agent.id)}/scopes/grant">
          ${addableScopes.map((item) => `
            <label style="display:flex;align-items:flex-start;gap:10px;margin:10px 0;cursor:pointer;">
              <input type="checkbox" name="scopes" value="${escapeHtml(item.scope)}" style="margin-top:3px;transform:scale(1.15);">
              <span>
                <span class="badge scoped">${escapeHtml(item.scope)}</span>
                <span style="color:#687385;font-size:13px;">${item.count} connection(s): ${Array.from(item.providers).sort().map(escapeHtml).join(", ")}</span>
              </span>
            </label>
          `).join("")}
          <button type="submit" class="secondary" style="margin-top:8px;">Add selected scopes</button>
        </form>`}
      </div>
      <div class="card">
        <h2>Charter</h2>
        <p style="color:#687385;">What this agent is <em>for</em>, in plain language. Surfaced to <code>grantry_find_agent</code> so other agents route work here by purpose — not just by which tools you hold. Stored as the agent's description.</p>
        <form method="post" action="/agents/${escapeHtml(agent.id)}/charter">
          <textarea name="charter" rows="3" style="width:100%;box-sizing:border-box;" placeholder="e.g. 曖昧なGitHub issueを取得し、不足情報を補って具体化する係">${escapeHtml(agent.description ?? "")}</textarea>
          <button type="submit" style="margin-top:8px;">Save charter</button>
        </form>
      </div>
      <div class="card">
        <h2>Callable connections</h2>
        ${connections.length === 0 ? '<div class="empty">No enabled connection is callable by this agent. Grant at least one connection to enable provider tools.</div>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Scope</th><th>Provider</th><th>Auth</th><th>Label</th><th>Tools</th></tr></thead>
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
        ? scopes.map((scope) => mcpConfigCard(mcpOrigin(c), agent.name, tokenPlaceholder, false, scope)).join("")
        : mcpConfigCard(mcpOrigin(c), agent.name, tokenPlaceholder, false)}
      <div class="card">
        <h2>Quick checks</h2>
        <pre>curl -X POST ${mcpOrigin(c)}/mcp \\
  -H "Authorization: Bearer YOUR_FULL_AGENT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</pre>
        <pre>curl -X POST ${mcpOrigin(c)}/mcp \\
  -H "Authorization: Bearer YOUR_FULL_AGENT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"connections/list"}'</pre>
      </div>
      <p><a href="/agents">← Back to agents</a></p>
    </main></body></html>
  `);
});

// --- /agents/:id/scopes/grant POST (grant existing scopes to an existing agent) ---
dashboardApp.post("/agents/:id/scopes/grant", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");
  const id = c.req.param("id");
  const agent = await prisma.agent.findUnique({
    where: { id },
    select: { id: true, ownerId: true, workspaceId: true },
  });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  const body = await c.req.parseBody();
  const rawScopes = (body as any).scopes;
  const selectedScopes = (Array.isArray(rawScopes) ? rawScopes : [rawScopes])
    .map((scope) => String(scope ?? "").trim())
    .filter((scope) => /^[a-z0-9_-]+$/.test(scope));
  const scopes = Array.from(new Set(selectedScopes));
  if (scopes.length === 0) return c.html("<h1>select at least one scope</h1>", 400);

  const where: any = {
    ownerId: user.id,
    enabled: true,
    scope: { in: scopes },
  };
  if (agent.workspaceId) where.workspaceId = agent.workspaceId;
  const connections = await prisma.connection.findMany({
    where,
    select: { id: true },
  });
  if (connections.length === 0) {
    return c.html("<h1>no enabled connections found for selected scopes</h1>", 400);
  }

  await grantConnectionsToAgent(agent.id, connections.map((conn) => conn.id), user.id);
  return c.redirect(`/agents/${agent.id}`);
});

// --- /agents/:id/charter POST (edit the agent's charter / description) ---
dashboardApp.post("/agents/:id/charter", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");
  const id = c.req.param("id");
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);
  if (agent.ownerId !== user.id) return c.html("<h1>not your agent</h1>", 403);

  const body = await c.req.parseBody();
  const charter = String(body.charter ?? "").trim();
  await prisma.agent.update({ where: { id: agent.id }, data: { description: charter || null } });

  return c.redirect(`/agents/${agent.id}`);
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
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
    <main>
      <h1>✓ Token rotated for <code>${agent.name}</code></h1>
      <div class="card" style="background:rgba(255,107,107,0.08); border-color:#df1b41;">
        <h2>⚠️  Old token invalidated</h2>
        <p>The old token (prefix <code>${oldPrefix}...</code>) is no longer valid. Any system still using it will get <code>401 authentication required</code>.</p>
      </div>
      <div class="card" style="background:rgba(99,91,255,0.08); border-color:#635bff;">
        <h2>🔑 New token (save this — shown once!)</h2>
        <pre style="background:#f6f9fc;border:1px solid #635bff;">${newToken}</pre>
        <p style="font-size:13px;color:#687385;margin-bottom:0;">Use as <code>Authorization: Bearer ${newToken}</code> when calling <code>/mcp</code>.</p>
        <p style="font-size:13px;color:#df1b41;margin-top:8px;">⚠️  Save this token now. If you lose it, you'll need to rotate again.</p>
      </div>
      ${rotatedScopes.length
        ? rotatedScopes.map((scope) => mcpConfigCard(mcpOrigin(c), agent.name, newToken, true, scope)).join("")
        : mcpConfigCard(mcpOrigin(c), agent.name, newToken, true)}
      <div class="card">
        <h2>Test the new token</h2>
        <pre>curl -X POST ${mcpOrigin(c)}/mcp \\
  -H "Authorization: Bearer ${newToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'</pre>
      </div>
      <p><a href="/agents">← Back to agents</a></p>
    </main></body></html>
  `);
});

// --- DEBUG: /debug/agents — dumps agent/connection grant state ---
dashboardApp.get("/debug/agents", async (c) => {
  return c.json({ error: "debug endpoint disabled; use /api/scopes" }, 410);
});

// --- /audit ---
dashboardApp.get("/audit", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  // Scope the audit log to the active workspace too, so switching workspaces
  // changes the whole world consistently — you only see calls made by agents
  // that live in the workspace you're currently in.
  const wsId = await getActiveWorkspaceId(c);
  const logs = await prisma.auditLog.findMany({
    where: wsId
      ? { agent: { ownerId: user.id, workspaceId: wsId } }
      : { OR: [{ userId: user.id }, { agent: { ownerId: user.id } }] },
    take: 100,
    orderBy: { createdAt: "desc" },
    include: { agent: true },
  });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Audit — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("audit", user?.email)}
    <main>
      <h1>Audit log</h1>
      <p style="color:#687385;">Latest 100 events.</p>
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

// --- /oauth/:provider/start (GET) — initiate OAuth flow for any provider ---
// Generic. Reads the provider's authorizeUrl + scopes from the registry, then
// resolves client_id/secret from the current workspace's OAuth app credential
// when configured. Env fallback is only for providers that allow a Grantry-owned
// OAuth app.
// Stores the wizard data in OAuthState.payload keyed by the `state` param.
oauthApp.get("/:provider/start", async (c) => {
  const providerKey = c.req.param("provider");
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");

  const providerDef = getProvider(providerKey);
  if (!providerDef || providerDef.implemented === false || !providerDef.authTypes.includes("oauth")) {
    return c.html(`<h1>unknown or non-OAuth provider: ${escapeHtml(providerKey)}</h1>`, 400);
  }
  if (!providerDef.authorizeUrl || !providerDef.oauthTokenUrl) {
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth not configured</h1><p>Missing <code>authorizeUrl</code> in registry. <a href="/tenants/new">← Back</a></p>`, 500);
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
    agent: c.req.query("agent") || "",
    agent_desc: c.req.query("agent_desc") || "",
    oauth_queue: c.req.query("oauth_queue") || "",
    connection_id: c.req.query("connection_id") || "",
    oauth_app_credential_id: c.req.query("oauth_app_credential_id") || "",
    optional_scopes: c.req.query("optional_scopes") || "",
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
    return c.html(`<h1>invalid scope</h1><p>Scope must match <code>[a-z0-9_-]+</code>. <a href="/tenants/new">← Back</a></p>`, 400);
  }
  const workspaceId = await resolveOAuthWorkspaceId(c, user.id, providerKey, payload);
  const oauthCfg = await resolveOAuthClientConfig(providerKey, providerDef, workspaceId, String(payload.oauth_app_credential_id || ""));
  if (!oauthCfg.clientId) {
    const envPrefix = providerKey.toUpperCase();
    const setupLink = payload.tenant ? `/tenants/${encodeURIComponent(payload.tenant)}/edit` : "/tenants/new";
    const hint = providerRequiresWorkspaceOAuthApp(providerKey, providerDef)
      ? `Configure this workspace's ${escapeHtml(providerDef.label)} OAuth app first. Paste its <code>client_id</code> and <code>client_secret</code> on the scope edit page; do not use Grantry-wide environment variables.`
      : `Set <code>${envPrefix}_CLIENT_ID</code> env var.`;
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth not configured</h1><p>${hint} <a href="${setupLink}">← Back</a></p>`, 500);
  }
  if (oauthCfg.credentialId) payload.oauth_app_credential_id = oauthCfg.credentialId;

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
  console.log("[oauth-start]", {
    provider: providerKey,
    source: oauthCfg.source,
    credentialId: oauthCfg.credentialId || null,
    clientId: clientIdPreview(oauthCfg.clientId),
    redirectUri,
  });
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
  const scopeStr = (oauthCfg.oauthScopes || []).join(scopeSeparator);
  const optionalScopes = providerKey === "hubspot"
    ? parseScopeList(String(payload.optional_scopes || ""))
    : (oauthCfg.oauthOptionalScopes || []);
  const optionalScopeStr = optionalScopes.join(scopeSeparator);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: oauthCfg.clientId,
    redirect_uri: redirectUri,
    scope: scopeStr,
    state,
  });
  if (optionalScopeStr) {
    params.set("optional_scope", optionalScopeStr);
  }
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
    return c.html(`<h1>OAuth state expired or invalid</h1><p>Try <a href="/tenants/new">creating the scope</a> again.</p>`, 400);
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

  // Exchange code for token. Providers can use a customer/workspace-owned
  // OAuth app, so callback must use the same client that generated authorize.
  const workspaceIdForOAuth = await resolveOAuthWorkspaceId(c, user.id, providerKey, payload);
  const oauthCfg = await resolveOAuthClientConfig(providerKey, providerDef, workspaceIdForOAuth, String(payload.oauth_app_credential_id || ""));
  const clientId = oauthCfg.clientId;
  const clientSecret = oauthCfg.clientSecret;
  const publicUrl = process.env.BETTER_AUTH_URL || `${publicOrigin(c)}`;
  if (!clientId || !clientSecret) {
    const envPrefix = providerKey.toUpperCase();
    const setupLink = payload.tenant ? `/tenants/${encodeURIComponent(payload.tenant)}/edit` : "/tenants/new";
    const hint = providerRequiresWorkspaceOAuthApp(providerKey, providerDef)
      ? `Configure this workspace's ${escapeHtml(providerDef.label)} OAuth app first. Paste its <code>client_id</code> and <code>client_secret</code> on the scope edit page; do not use Grantry-wide environment variables.`
      : `Set <code>${envPrefix}_CLIENT_ID</code> and <code>${envPrefix}_CLIENT_SECRET</code> env vars.`;
    return c.html(`<h1>${escapeHtml(providerDef.label)} OAuth credentials missing</h1><p>${hint} <a href="${setupLink}">← Back</a></p>`, 500);
  }
  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/oauth/${providerKey}/callback`;

  // Some OAuth providers require HTTP Basic auth at the token endpoint rather
  // than client credentials in the body.
  const clientAuthMethodNormalized = String(oauthCfg.oauthClientAuthMethod || defaultOAuthClientAuthMethod(providerKey, providerDef)).toUpperCase();
  const usesBasicAuth = clientAuthMethodNormalized === "CLIENT_SECRET_BASIC";
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
    const errBody = await tokenResp.text().catch(() => "");
    console.error("[oauth] token exchange failed", {
      provider: providerKey,
      tokenUrl: providerDef.oauthTokenUrl,
      status: tokenResp.status,
      redirectUri,
      usedPkce: !!pkceVerifier,
      body: errBody.slice(0, 2000),
    });
    return c.html(
      `<h1>${escapeHtml(providerDef.label)} token exchange failed</h1>` +
        `<p>HTTP ${tokenResp.status} from <code>${escapeHtml(providerDef.oauthTokenUrl || "")}</code></p>` +
        `<pre>${escapeHtml(errBody.slice(0, 2000))}</pre>`,
      500,
    );
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
      const u: any = await (await fetch("https://api-accounting.moneyforward.com/api/v3/offices", { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } })).json();
      if (u?.name) userLogin = u.name;
      else userLogin = "moneyforward-accounting";
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
    } else if (providerKey === "zoom") {
      const u: any = await (await fetch("https://api.zoom.us/v2/users/me", { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } })).json();
      if (u?.email) userLogin = u.email;
    }
  } catch { /* non-fatal */ }

  // --- Complete the wizard using the saved payload ---
  const tenant = payload.tenant;
  const tenantSelect = payload.tenant_select || "";
  const effectiveTenant = tenant || tenantSelect;
  const agent = payload.agent;
  const agentDesc = payload.agent_desc || "";
  if (!/^[a-z0-9_-]+$/.test(effectiveTenant)) {
    return c.html(`<h1>invalid scope in saved payload</h1>`, 400);
  }
  // The wizard already created the Tenant row (with its display name); this
  // upsert only covers direct /oauth/:provider/start?tenant=… entry points.
  // The active-workspace cookie survives the provider round-trip (SameSite=Lax),
  // so a freshly-created tenant lands in the right workspace; an existing tenant
  // keeps its own, and downstream rows inherit that via tenantRow.workspaceId.
  const activeWsId = await getActiveWorkspaceId(c);
  const tenantRow = await ensureTenant(user.id, effectiveTenant, undefined, activeWsId);
  const wsId = tenantRow.workspaceId ?? activeWsId;

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
      return c.html(`<h1>connection not found for reconnect</h1><p>The requested connection does not belong to this scope/provider. <a href="/tenants/${effectiveTenant}/edit">Back</a></p>`, 404);
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
      await rotateSharedCredential({
        credentialId: conn.credentialId,
        connectionId: conn.id,
        data,
      });
    } else {
      // No existing connection for this tenant/provider — create one so the
      // reconnect still leaves a usable credential behind.
      const created = await prisma.connection.create({
        data: {
          provider: providerKey,
          authType: "oauth",
          label: `${providerKey}-${userLogin}-${effectiveTenant}-oauth`,
          scope: effectiveTenant,
          tenantId: tenantRow.id,
          ownerId: user.id,
          workspaceId: wsId,
          ...data,
        },
      });
      await ensureProviderCredentialForConnection(created, user.id);
      await grantConnectionToTenantAgents(user.id, effectiveTenant, created.id);
    }
    return c.redirect(`/tenants/${effectiveTenant}/edit?reauthed=${encodeURIComponent(providerKey)}`);
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
      workspaceId: wsId,
      encryptedCredential: encrypt(accessToken),
      accessTokenExpiresAt: tokenJson.expires_in ? new Date(Date.now() + tokenJson.expires_in * 1000) : null,
      refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
      ...(await credentialMetadataForStorage(providerKey, "oauth", accessToken)),
    },
  });
  // If the connection already existed, update the credential (token may have rotated)
  if (existingConn) {
    await rotateSharedCredential({
      credentialId: existingConn.credentialId,
      connectionId: existingConn.id,
      data: {
        encryptedCredential: encrypt(accessToken),
        accessTokenExpiresAt: tokenJson.expires_in ? new Date(Date.now() + tokenJson.expires_in * 1000) : null,
        ...(await credentialMetadataForStorage(providerKey, "oauth", accessToken)),
        ...(refreshToken ? { refreshToken: encrypt(refreshToken) } : {}),
      },
    });
  } else {
    await ensureProviderCredentialForConnection(conn, user.id);
  }
  await grantConnectionToTenantAgents(user.id, effectiveTenant, conn.id);

  // If more providers in the chain still need OAuth authorization, hand off
  // to the next one before minting the agent. Each callback attaches its own
  // connection; the final callback grants all tenant connections to the agent.
  const remainingQueue = String(payload.oauth_queue || "")
    .split(",").map((s: string) => s.trim()).filter(Boolean);
  if (remainingQueue.length > 0) {
    const [nextProvider, ...rest] = remainingQueue;
    const params = new URLSearchParams({
      tenant: payload.tenant || "",
      tenant_select: payload.tenant_select || "",
      oauth_queue: rest.join(","),
    });
    if (payload.agent) params.set("agent", payload.agent);
    if (payload.agent_desc) params.set("agent_desc", payload.agent_desc);
    return c.redirect(`/oauth/${nextProvider}/start?${params.toString()}`);
  }

  if (!agent) {
    return c.redirect(`/tenants/${effectiveTenant}/agents/setup?created=1&connected=${encodeURIComponent(providerKey)}`);
  }

  // 3) Create agent + grant tenant connections + mint token
  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Agent name taken — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>⚠️  Agent name <code>${escapeHtml(agent)}</code> already exists</h1>
        <div class="card" style="border-color:#df1b41;">
          <p>${escapeHtml(providerDef.label)} connection was created, but the agent name is taken. <a href="/agents/${existingAgent.id}">Reuse the existing agent</a> or pick a different name.</p>
        </div>
        <p><a href="/tenants">← Back to scopes</a></p>
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
      workspaceId: wsId,
    },
  });
  const granted = await grantTenantConnectionsToAgent(user.id, agentRow.id, effectiveTenant);

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
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ ${escapeHtml(providerDef.label)} connected · scope <code>${effectiveTenant}</code> created</h1>
      ${googleAdsConnectionNeedsDeveloperToken ? `
      <div class="card" style="border-color:#f0b429;background:rgba(240,180,41,0.08);">
        <h2>Google Ads API token still required</h2>
        <p>OAuth は完了しましたが、Google Ads API を呼ぶには Google Ads API Center の <b>Developer token</b> も必要です。</p>
        <p>次の画面で <code>google_ads</code> connection の <b>Developer token</b> 欄に貼って保存してください。</p>
        <p><a href="/tenants/${effectiveTenant}/edit">Open scope settings →</a> · <a href="https://ads.google.com/aw/apicenter" target="_blank" rel="noopener">Open Google Ads API Center →</a></p>
      </div>` : ""}
      <div class="card">
        <h2>Connections (${allConns.length})</h2>
        ${allConns.map((cn) => `<p><code>${escapeHtml(cn.label)}</code> · auth=<code>${escapeHtml(cn.authType)}</code> · scope=<code>${escapeHtml(cn.scope)}</code></p>`).join("")}
      </div>
      <div class="card">
        <h2>Agent</h2>
        <p><code>${agentRow.name}</code> · granted ${granted} connection(s)</p>
      </div>
      ${agentTokenCard(token, "")}
      ${mcpConfigCard(mcpOrigin(c), agentRow.name, token, true, effectiveTenant)}
      <p><a href="/tenants">← Back to scopes</a> · <a href="/agents">Manage agents</a></p>
    </main></body></html>
  `);
 } catch (err) {
    // Surface the real cause instead of an opaque "Internal Server Error".
    console.error(`[oauth callback] ${providerKeyForError} failed:`, err);
    const detail = err instanceof Error ? err.message : String(err);
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>OAuth failed — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("tenants")}
      <main>
        <h1>⚠️  OAuth connection failed</h1>
        <div class="card" style="border-color:#df1b41;">
          <p>Something went wrong while completing the <code>${escapeHtml(providerKeyForError)}</code> connection.</p>
          <pre style="background:#f6f9fc;border:1px solid #df1b41;white-space:pre-wrap;">${escapeHtml(detail)}</pre>
        </div>
        <p><a href="/tenants/new">← Try again</a></p>
      </main></body></html>
    `, 500);
 }
});

// --- /api/scopes (JSON dump of caller's wiring) ---
// Returns the user's distinct scopes, connections, and agents.
// Useful for agents that need to know what they can call before hitting /mcp.
dashboardApp.get("/api/scopes", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const [tenants, conns, agents] = await Promise.all([
    prisma.tenant.findMany({
      where: { ownerId: user.id },
      select: { id: true, slug: true, displayName: true, description: true, createdAt: true },
      orderBy: { slug: "asc" },
    }),
    prisma.connection.findMany({
      where: { ownerId: user.id },
      select: { id: true, provider: true, authType: true, scope: true, label: true, enabled: true, workspaceId: true, createdAt: true },
      orderBy: [{ scope: "asc" }, { provider: "asc" }, { authType: "asc" }],
    }),
    prisma.agent.findMany({
      where: { ownerId: user.id },
      select: {
        id: true, name: true, tokenPrefix: true, enabled: true, createdAt: true, lastUsedAt: true,
        connectionGrants: {
          select: {
            connection: {
              select: { id: true, provider: true, authType: true, scope: true, label: true, enabled: true, workspaceId: true },
            },
          },
        },
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
    agents: await Promise.all(agents.map(async (a) => ({
      id: a.id, name: a.name, tokenPrefix: a.tokenPrefix, enabled: a.enabled,
      createdAt: a.createdAt.toISOString(),
      lastUsedAt: a.lastUsedAt?.toISOString() ?? null,
      grantedConnections: a.connectionGrants.map((g) => ({
        id: g.connection.id,
        provider: g.connection.provider,
        authType: g.connection.authType,
        scope: g.connection.scope,
        label: g.connection.label,
        enabled: g.connection.enabled,
      })),
      accessibleTools: Array.from(new Set((await Promise.all(a.connectionGrants.map(async (g) =>
        g.connection.enabled ? await toolsForProviderForWorkspace(g.connection.provider, g.connection.workspaceId) : []
      ))).flat())),
      accessibleScopes: Array.from(new Set(
        a.connectionGrants
          .filter((g) => g.connection.enabled)
          .map((g) => g.connection.scope)
      )),
    }))),
  });
});

// --- /api/capabilities (inverse lookup: which agents can do X?) ---
// docs/agent-orchestration.md. Given a tool (+ optional scope), returns ranked
// agents that can call it, across every workspace the caller belongs to plus
// their own legacy workspace-less agents. Capability facts only — never tokens.
dashboardApp.get("/api/capabilities", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);

  const tool = normalizeToolName(c.req.query("tool"));
  if (!tool || !tool.includes("/")) {
    return c.json({ error: "pass ?tool=provider/tool, e.g. railway/graphql" }, 400);
  }
  const scope = c.req.query("scope") || undefined;

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: user.id },
    select: { workspaceId: true },
  });
  const workspaceIds = memberships.map((m) => m.workspaceId);

  // One pass per workspace, plus an owner-scoped pass for legacy agents whose
  // workspaceId is still null; dedup by agentId, keeping the highest confidence.
  const byAgent = new Map<string, Awaited<ReturnType<typeof findCapableAgents>>[number]>();
  const passes = [
    ...workspaceIds.map((workspaceId) => ({ tool, scope, workspaceId })),
    { tool, scope, ownerId: user.id },
  ];
  for (const pass of passes) {
    for (const m of await findCapableAgents(pass)) {
      const existing = byAgent.get(m.agentId);
      if (!existing || m.confidence > existing.confidence) byAgent.set(m.agentId, m);
    }
  }
  const candidates = Array.from(byAgent.values()).sort((a, b) => b.confidence - a.confidence);
  return c.json({ tool, scope: scope ?? null, candidates });
});

// --- /tenants/:scope/agents/setup (GET) — step 2 after scope creation ---
dashboardApp.get("/tenants/:scope/agents/setup", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect("/login");
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);

  const tenant = await prisma.tenant.findFirst({
    where: { slug: scope, ownerId: user.id },
    select: { displayName: true, slug: true, workspaceId: true },
  });
  if (!tenant) return c.html(`<h1>scope '${escapeHtml(scope)}' not found</h1>`, 404);

  const [connections, agents] = await Promise.all([
    prisma.connection.findMany({
      where: { scope, ownerId: user.id, enabled: true },
      select: { id: true, provider: true, authType: true, label: true },
      orderBy: [{ provider: "asc" }, { authType: "asc" }],
    }),
    prisma.agent.findMany({
      where: {
        ownerId: user.id,
        enabled: true,
        ...(tenant.workspaceId ? { OR: [{ workspaceId: tenant.workspaceId }, { workspaceId: null }] } : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        tokenPrefix: true,
        createdAt: true,
        connectionGrants: {
          where: { connection: { scope, ownerId: user.id } },
          select: { connectionId: true },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const assignableAgents = agents.filter((agent) => agent.connectionGrants.length === 0);
  const created = c.req.query("created") === "1";
  const connected = c.req.query("connected");
  const assigned = c.req.query("assigned");
  const showName = tenant.displayName && tenant.displayName !== tenant.slug;

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Set up agents — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>Set up agents for ${showName ? `${escapeHtml(tenant.displayName)} ` : ""}<code>${escapeHtml(scope)}</code></h1>
      <p style="color:#687385;margin-top:-16px;margin-bottom:24px;">
        Step 2: create an agent for this scope, or assign an existing agent to this scope's enabled connections.
      </p>
      ${created ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">✓ Scope <code>${escapeHtml(scope)}</code> is ready.${connected ? ` Connected <code>${escapeHtml(connected)}</code>.` : ""}</div>` : ""}
      ${assigned ? `<div class="card" style="border-color:#3fb950;background:rgba(63,185,80,0.08);">✓ Existing agent granted ${escapeHtml(assigned)} connection(s).</div>` : ""}

      <div class="card">
        <h2>Scope</h2>
        <p><span class="badge scoped">${escapeHtml(scope)}</span> · ${connections.length} enabled connection(s)</p>
        ${connections.length === 0 ? `<div class="empty">No enabled connections yet. <a href="/tenants/${scope}/edit">Add a service</a> before this scope can be used by an agent.</div>` : `
          <ul class="conn-list">
            ${connections.map((cn) => `
              <li class="conn-item">
                <span class="provider-cell">${providerIcon(cn.provider)}<code>${escapeHtml(cn.provider)}</code></span>
                <code class="conn-auth">${escapeHtml(cn.authType)}</code>
                <span class="conn-label">${escapeHtml(cn.label)}</span>
              </li>
            `).join("")}
          </ul>
        `}
      </div>

      <div class="card">
        <h2>Create new agent</h2>
        <form method="post" action="/tenants/${scope}/agents/new" id="addAgentForm">
          <div class="field">
            <label for="agent">Agent name</label>
            <input type="text" name="agent" id="agent" pattern="[a-zA-Z0-9_-]+" placeholder="e.g. ${escapeHtml(scope)}-agent" required>
            <div class="field-hint">Globally unique. This creates a new token and grants this scope's enabled connections.</div>
          </div>
          <div class="field">
            <label for="agent_desc">Description <span style="color:#687385;">(optional)</span></label>
            <input type="text" name="agent_desc" id="agent_desc" placeholder="What this agent is for">
          </div>
          <button type="submit">Create agent &amp; mint token</button>
        </form>
      </div>

      <div class="card">
        <h2>Assign existing agent</h2>
        ${assignableAgents.length === 0 ? `<div class="empty">No unassigned agents are available in this workspace. Create a new agent above.</div>` : `
        <form method="post" action="/tenants/${scope}/agents/assign-existing">
          <label for="agent_id">Agent</label>
          <select name="agent_id" id="agent_id" required>
            ${assignableAgents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}${agent.description ? ` — ${escapeHtml(agent.description)}` : ""}</option>`).join("")}
          </select>
          <p class="field-hint">The selected agent keeps its existing token. Grantry only adds connection grants for this scope.</p>
          <button type="submit" class="secondary">Grant this scope</button>
        </form>
        `}
      </div>

      <p><a href="/tenants/${scope}/edit">Edit scope</a> · <a href="/tenants">Back to scopes</a></p>
    </main></body></html>
  `);
});

// --- /tenants/:scope/agents/assign-existing (POST) ---
dashboardApp.post("/tenants/:scope/agents/assign-existing", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);
  const body = await c.req.parseBody();
  const agentId = String(body.agent_id ?? "").trim();
  if (!agentId) return c.html("<h1>agent required</h1>", 400);

  const tenant = await prisma.tenant.findFirst({
    where: { slug: scope, ownerId: user.id },
    select: { workspaceId: true },
  });
  if (!tenant) return c.html(`<h1>scope '${escapeHtml(scope)}' not found</h1>`, 404);

  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      ownerId: user.id,
      enabled: true,
      ...(tenant.workspaceId ? { OR: [{ workspaceId: tenant.workspaceId }, { workspaceId: null }] } : {}),
    },
  });
  if (!agent) return c.html("<h1>agent not found</h1>", 404);

  const granted = await grantTenantConnectionsToAgent(user.id, agent.id, scope);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Agent assigned — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Agent <code>${escapeHtml(agent.name)}</code> can use <code>${escapeHtml(scope)}</code></h1>
      <div class="card">
        <h2>Connection grants</h2>
        <p>Granted ${granted} enabled connection(s) for this scope.</p>
      </div>
      <div class="card">
        <h2>Token</h2>
        <p>This agent keeps its existing token. The plaintext token cannot be shown again; rotate it from the agent page if you need a fresh copy.</p>
        ${mcpConfigCard(mcpOrigin(c), agent.name, `${agent.tokenPrefix}...ROTATE_TO_VIEW_FULL_TOKEN`, false, scope)}
      </div>
      <p><a href="/tenants/${scope}/agents/setup?assigned=${granted}">Back to agent setup</a> · <a href="/agents/${agent.id}">Open agent</a></p>
    </main></body></html>
  `);
});

// --- /tenants/:scope/agents/new (POST) — add another agent to existing scope ---
dashboardApp.post("/tenants/:scope/agents/new", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const scope = c.req.param("scope");
  if (!/^[a-z0-9_-]+$/.test(scope)) return c.html("<h1>invalid scope</h1>", 400);
  const body = await c.req.parseBody();
  const agent = String(body.agent ?? "").trim();
  const agentDesc = String(body.agent_desc ?? "").trim();
  if (!agent) return c.html("<h1>agent name required</h1>", 400);
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {
    return c.html("<h1>invalid agent name (a-z, 0-9, hyphens, underscores)</h1>", 400);
  }

  const tenant = await prisma.tenant.findFirst({
    where: { slug: scope, ownerId: user.id },
    select: { workspaceId: true },
  });
  if (!tenant) return c.html(`<h1>scope '${escapeHtml(scope)}' not found</h1>`, 404);

  // Check for agent name conflict up front
  const existingAgent = await prisma.agent.findUnique({ where: { name: agent } });
  if (existingAgent) {
    return c.html(`
      <!doctype html><html><head><meta charset="utf-8"><title>Agent name taken — grantry</title>
      ${FAVICON}<style>${CSS}</style></head><body>
      ${NAV("tenants", user?.email)}
      <main>
        <h1>⚠️ Agent name <code>${escapeHtml(agent)}</code> already exists</h1>
        <div class="card" style="border-color:#df1b41;">
          <p>Pick a different agent name (e.g. <code>${escapeHtml(agent)}-v2</code>).</p>
          <p><a href="/tenants/${scope}/edit">← Back to ${scope}</a></p>
        </div>
      </main></body></html>
    `, 409);
  }

  // Mint token + create agent — same workspace as the tenant.
  const wsId = tenant.workspaceId ?? (await getActiveWorkspaceId(c));
  const token = `gn_agt_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await import("node:crypto").then(c => c.createHash("sha256").update(token).digest("hex"));
  const agentRow = await prisma.agent.create({
    data: {
      name: agent,
      description: agentDesc || null,
      hashedToken: tokenHash,
      tokenPrefix: token.slice(0, 16),
      ownerId: user.id,
      workspaceId: wsId,
    },
  });
  const granted = await grantTenantConnectionsToAgent(user.id, agentRow.id, scope);

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Agent created — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ New agent <code>${agentRow.name}</code> added to <code>${scope}</code></h1>
      <div class="card">
        <h2>Connection</h2>
        <p>Reused the existing <code>${scope}</code> connection(s) — no new PAT/OAuth needed.</p>
      </div>
      <div class="card">
        <h2>Connection grants</h2>
        <p>Granted ${granted} connection(s) for <code>${escapeHtml(scope)}</code>.</p>
      </div>
      ${agentTokenCard(token)}
      ${mcpConfigCard(mcpOrigin(c), agentRow.name, token, true, scope)}
      <div class="card">
        <h2>Test it</h2>
        <pre>curl -X POST ${mcpOrigin(c)}/mcp \\
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
    return c.html(`<h1>No scope or connections found for scope '${scope}' (yours)</h1>`, 404);
  }

  // 2) Find legacy role rows for this scope so deleting the tenant also cleans
  //    stale migration-era data. Runtime access is based on connection grants.
  const userIdShort = user.id.slice(0, 8);
  const roles = await prisma.role.findMany({
    where: { ownerId: user.id, OR: [{ name: `${scope}-dev-${userIdShort}` }, { name: `${scope}-dev` }, { name: scope }] },
    select: { id: true, name: true },
  });

  // 3) Delete connections (this user only)
  const connDelete = await prisma.connection.deleteMany({
    where: { scope, ownerId: user.id },
  });

  // 4) Delete legacy role rows, if present. Connection grants are removed by
  //    the connection delete cascade above.
  const roleDelete = await prisma.role.deleteMany({
    where: { id: { in: roles.map((r) => r.id) } },
  });

  // 5) Delete the tenant entity itself.
  await prisma.tenant.deleteMany({ where: { slug: scope, ownerId: user.id } });

  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Deleted — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Deleted scope <code>${scope}</code></h1>
      <div class="card">
        <p>Removed <b>${connDelete.count}</b> connection(s). Related connection grants were removed automatically.</p>
        ${roleDelete.count ? `<p class="field-hint">Also removed ${roleDelete.count} legacy role row(s).</p>` : ""}
      </div>
      <p><a href="/tenants">← Back to all scopes</a></p>
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

  let conns = 0, legacyRoles = 0;
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
    legacyRoles += roleDelete.count;
    detail.push(`<li><code>${escapeHtml(scope)}</code>: ${connDelete.count} connection(s)</li>`);
  }
  return c.html(`
    <!doctype html><html><head><meta charset="utf-8"><title>Bulk deleted — grantry</title>
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("tenants", user?.email)}
    <main>
      <h1>✓ Bulk deleted ${scopes.length} scope(s)</h1>
      <div class="card">
        <p>Total: <b>${conns}</b> connection(s) removed. Related connection grants were removed automatically.</p>
        ${legacyRoles ? `<p class="field-hint">Also removed ${legacyRoles} legacy role row(s).</p>` : ""}
        <ul>${detail.join("")}</ul>
      </div>
      <p><a href="/tenants">← Back to all scopes</a></p>
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

  // Cascade connection grants via onDelete: Cascade; the agent itself is then deleted.
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
    ${FAVICON}<style>${CSS}</style></head><body>
    ${NAV("agents", user?.email)}
    <main>
      <h1>✓ Bulk deleted ${result.count} agent(s)</h1>
      <p>${result.count < ids.length ? `(${ids.length - result.count} skipped — not yours or not found)` : ""}</p>
      <p><a href="/agents">← Back to all agents</a></p>
    </main></body></html>
  `);
});
