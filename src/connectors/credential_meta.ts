import { callGenericCheckConnection, callGenericListCapabilities } from "./generic_request.js";
import { getProvider } from "./registry.js";

const META_TIMEOUT_MS = 8_000;

export type CredentialMetadata = {
  provider: string;
  authType: string;
  status: "ok" | "error" | "unknown";
  scopes?: string[];
  subject?: Record<string, unknown>;
  resources?: Array<Record<string, unknown>>;
  notes?: string[];
  checkedAt: string;
  error?: string;
  capabilities?: {
    status: "ok" | "error" | "unknown";
    smokeTests?: Array<Record<string, unknown>>;
    operations?: Array<Record<string, unknown>>;
    missingScopes?: string[];
    checkedAt: string;
    error?: string;
  };
};

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function splitScopes(value: string | null | undefined) {
  if (!value) return [];
  return value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function readJson(resp: Response) {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export async function inspectCredential(provider: string, authType: string, token: string): Promise<CredentialMetadata> {
  const checkedAt = new Date().toISOString();
  try {
    if (provider === "github") {
      const resp = await fetchWithTimeout("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "grantry",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `GitHub token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      const scopes = splitScopes(resp.headers.get("x-oauth-scopes"));
      const notes: string[] = [];
      if (authType === "pat" && scopes.length === 0) {
        notes.push("GitHub fine-grained PAT permissions are repository/permission based and may not appear as OAuth scopes.");
      }
      const expiration = resp.headers.get("github-authentication-token-expiration");
      if (expiration) notes.push(`Token expiration: ${expiration}`);
      return {
        provider,
        authType,
        status: "ok",
        scopes,
        subject: { login: body.login, id: body.id, type: body.type },
        notes,
        checkedAt,
      };
    }

    if (provider === "cloudflare") {
      const resp = await fetchWithTimeout("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok || body.success === false) {
        return { provider, authType, status: "error", checkedAt, error: `Cloudflare token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: {
          id: body.result?.id,
          status: body.result?.status,
        },
        notes: ["Cloudflare token permissions are scoped in the Cloudflare dashboard and are not fully enumerated by token verification."],
        checkedAt,
      };
    }

    if (provider === "clarity") {
      return {
        provider,
        authType,
        status: "ok",
        notes: [
          "Microsoft Clarity Data Export API tokens are generated per project from Settings > Data Export.",
          "Clarity does not expose a reliable non-consuming token introspection endpoint here; the token is validated on first get_live_insights call.",
        ],
        checkedAt,
      };
    }

    if (provider === "google_maps") {
      if (!token.trim()) {
        return { provider, authType, status: "error", checkedAt, error: "Google Maps API key is required" };
      }
      // Validate with a cheap Geocoding call; the status field reports key problems.
      const resp = await fetchWithTimeout(
        `https://maps.googleapis.com/maps/api/geocode/json?address=Tokyo&key=${encodeURIComponent(token.trim())}`,
        { headers: { Accept: "application/json" } },
      );
      const body: any = await readJson(resp);
      const status = body?.status;
      if (!resp.ok || status === "REQUEST_DENIED" || status === "INVALID_REQUEST") {
        return { provider, authType, status: "error", checkedAt, error: `Google Maps API key check failed: ${resp.status} ${status ?? ""} ${body?.error_message ?? ""}`.trim() };
      }
      return {
        provider,
        authType,
        status: "ok",
        notes: [
          "Google Maps Platform API keys are sent as the `key` query parameter.",
          "Enable the Geocoding, Places, Directions, and Distance Matrix APIs and apply key restrictions in Google Cloud Console.",
          status === "OVER_QUERY_LIMIT" ? "Key validated but currently OVER_QUERY_LIMIT — check billing/quota." : `Geocoding probe returned ${status ?? "no status"}.`,
        ],
        checkedAt,
      };
    }

    if (provider.startsWith("google_") || provider === "gmail" || provider === "youtube" || provider === "bigquery") {
      const tokenInfo = await fetchWithTimeout(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
      const info: any = await readJson(tokenInfo);
      if (!tokenInfo.ok) {
        return { provider, authType, status: "error", checkedAt, error: `Google tokeninfo failed: ${tokenInfo.status} ${JSON.stringify(info).slice(0, 300)}` };
      }
      const meta: CredentialMetadata = {
        provider,
        authType,
        status: "ok",
        scopes: splitScopes(info.scope),
        subject: { email: info.email, sub: info.sub, audience: info.aud },
        checkedAt,
      };
      if (provider === "google_gsc") {
        const sitesResp = await fetchWithTimeout("https://www.googleapis.com/webmasters/v3/sites", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        const sites: any = await readJson(sitesResp);
        if (sitesResp.ok) {
          meta.resources = (sites.siteEntry ?? []).slice(0, 50).map((site: any) => ({
            siteUrl: site.siteUrl,
            permissionLevel: site.permissionLevel,
          }));
        } else {
          meta.notes = [`GSC sites check failed: ${sitesResp.status}`];
        }
      }
      if (provider === "google_drive") {
        const aboutResp = await fetchWithTimeout("https://www.googleapis.com/drive/v3/about?fields=user,storageQuota", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        const about: any = await readJson(aboutResp);
        if (aboutResp.ok) {
          meta.subject = {
            ...meta.subject,
            drive_user: about.user,
          };
          meta.resources = about.storageQuota ? [{ storageQuota: about.storageQuota }] : undefined;
        } else {
          meta.notes = [`Drive about check failed: ${aboutResp.status}`];
        }
      }
      return meta;
    }

    if (provider === "yahoo_ads") {
      return {
        provider,
        authType,
        status: "ok",
        scopes: ["yahooads"],
        notes: [
          "LINE Yahoo Ads access tokens expire after one hour; grantry refreshes them with the stored refresh token.",
          "Use yahoo_ads/list_base_accounts to verify which base accounts this Business ID can access.",
        ],
        checkedAt,
      };
    }

    if (provider === "meta_ads") {
      const apiVersion = process.env.META_ADS_API_VERSION || "v21.0";
      const resp = await fetchWithTimeout(`https://graph.facebook.com/${apiVersion}/me?fields=id,name`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const body: any = await readJson(resp);
      if (!resp.ok || body.error) {
        return { provider, authType, status: "error", checkedAt, error: `Meta token check failed: ${resp.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}` };
      }
      const meta: CredentialMetadata = {
        provider,
        authType,
        status: "ok",
        subject: { id: body.id, name: body.name },
        notes: [
          "Meta access tokens are long-lived (~60 days); reconnect when expired since Meta does not issue refresh tokens.",
          "Use meta_ads/list_ad_accounts to verify which ad accounts this user can access.",
        ],
        checkedAt,
      };
      // Best-effort scope/granular-permission introspection via debug_token.
      try {
        const appToken = process.env.META_ADS_CLIENT_ID && process.env.META_ADS_CLIENT_SECRET
          ? `${process.env.META_ADS_CLIENT_ID}|${process.env.META_ADS_CLIENT_SECRET}`
          : null;
        if (appToken) {
          const dbg = await fetchWithTimeout(
            `https://graph.facebook.com/${apiVersion}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`
          );
          const dbgBody: any = await readJson(dbg);
          if (dbg.ok && dbgBody.data) {
            if (Array.isArray(dbgBody.data.scopes)) meta.scopes = dbgBody.data.scopes;
            if (dbgBody.data.expires_at) {
              meta.subject = { ...meta.subject, token_expires_at: new Date(dbgBody.data.expires_at * 1000).toISOString() };
            }
          }
        }
      } catch { /* debug_token is best-effort */ }
      return meta;
    }

    if (provider === "facebook_messenger") {
      const apiVersion = process.env.MESSENGER_API_VERSION || process.env.META_ADS_API_VERSION || "v21.0";
      const resp = await fetchWithTimeout(`https://graph.facebook.com/${apiVersion}/me?fields=id,name,category`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const body: any = await readJson(resp);
      if (!resp.ok || body.error) {
        return { provider, authType, status: "error", checkedAt, error: `Messenger token check failed: ${resp.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: { id: body.id, name: body.name, category: body.category },
        notes: [
          "Page Access Token for the Messenger Platform. Use a long-lived token; short-lived ones expire in ~1 hour.",
          "Sending is bound by Messenger's 24-hour messaging window — outside it, pass a message tag with messaging_type=MESSAGE_TAG.",
        ],
        checkedAt,
      };
    }

    if (provider === "notion") {
      const resp = await fetchWithTimeout("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `Notion token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: { id: body.id, type: body.type, name: body.name, workspace_name: body.bot?.workspace_name },
        notes: ["Notion does not expose a complete page/database permission list through token introspection."],
        checkedAt,
      };
    }

    if (provider === "hubspot") {
      if (authType === "pat") {
        const resp = await fetchWithTimeout("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
        const body: any = await readJson(resp);
        if (!resp.ok) {
          return { provider, authType, status: "error", checkedAt, error: `HubSpot private app token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
        }
        return {
          provider,
          authType,
          status: "ok",
          resources: [{ contacts_probe: { total: body.total ?? null, returned: Array.isArray(body.results) ? body.results.length : null } }],
          notes: ["HubSpot private app token permissions are managed in HubSpot and are not fully enumerated here."],
          checkedAt,
        };
      }
      const resp = await fetchWithTimeout(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(token)}`);
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `HubSpot token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        scopes: Array.isArray(body.scopes) ? body.scopes : splitScopes(body.scope),
        subject: { user: body.user, hub_id: body.hub_id, app_id: body.app_id },
        checkedAt,
      };
    }

    if (provider === "attio") {
      const resp = await fetchWithTimeout("https://app.attio.com/oauth/introspect", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok || body.active === false) {
        return { provider, authType, status: "error", checkedAt, error: `Attio token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        scopes: splitScopes(body.scope),
        subject: {
          workspace_id: body.workspace_id,
          workspace_name: body.workspace_name,
          workspace_slug: body.workspace_slug,
          authorized_by_workspace_member_id: body.authorized_by_workspace_member_id,
        },
        checkedAt,
      };
    }

    if (provider === "clay") {
      if (/^https?:\/\//i.test(token.trim())) {
        return {
          provider,
          authType,
          status: "error",
          checkedAt,
          error: "Clay expects the API key from Settings > Account > API key, not a webhook URL.",
        };
      }
      return {
        provider,
        authType,
        status: "ok",
        notes: [
          "Clay API keys are stored server-side and sent as a Bearer token to the Clay API.",
          "No non-consuming Clay token introspection endpoint is called during save; validate with clay/raw_request or a read-only lookup.",
        ],
        checkedAt,
      };
    }

    if (provider === "heyreach") {
      const resp = await fetchWithTimeout("https://api.heyreach.io/api/public/auth/CheckApiKey", {
        headers: {
          "X-API-KEY": token,
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `HeyReach API key check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: typeof body === "object" && body ? body : undefined,
        notes: ["HeyReach API key is sent as X-API-KEY."],
        checkedAt,
      };
    }

    if (provider === "chatwork") {
      const resp = await fetchWithTimeout("https://api.chatwork.com/v2/me", {
        headers: {
          "x-chatworktoken": token,
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `Chatwork API token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: {
          account_id: body.account_id,
          name: body.name,
          chatwork_id: body.chatwork_id,
          organization_id: body.organization_id,
          organization_name: body.organization_name,
        },
        notes: ["Chatwork API tokens are sent as the x-chatworktoken header and can access the token owner's Chatwork data."],
        checkedAt,
      };
    }

    if (provider === "resend") {
      if (!token.trim()) {
        return { provider, authType, status: "error", checkedAt, error: "Resend API key is required" };
      }
      const notes = [
        "Resend API keys are sent as Authorization: Bearer.",
        "Keys restricted to sending_access may not be able to call read endpoints like list_domains or list_api_keys.",
      ];
      if (!token.trim().startsWith("re_")) {
        notes.push("Resend API keys commonly start with re_; this key will be validated on first API call.");
      }
      return {
        provider,
        authType,
        status: "ok",
        notes,
        checkedAt,
      };
    }

    if (provider === "railway" || provider === "railway_api") {
      let rawToken = token.trim();
      let tokenType = provider === "railway_api" ? "workspace" : "project";
      if (rawToken.startsWith("{")) {
        const parsed = JSON.parse(rawToken);
        rawToken = String(parsed.token ?? parsed.api_token ?? parsed.apiToken ?? "").trim();
        tokenType = String(parsed.token_type ?? parsed.tokenType ?? "project").trim().toLowerCase();
      }
      if (!rawToken) {
        return { provider, authType, status: "error", checkedAt, error: "Railway token is required" };
      }
      if (provider === "railway" && tokenType !== "project") {
        return { provider, authType, status: "error", checkedAt, error: "Railway Project Token provider only accepts project tokens. Use Railway API Token for account/workspace tokens." };
      }
      if (provider === "railway_api" && tokenType === "project") {
        tokenType = "workspace";
      }
      if (!["project", "account", "workspace", "oauth"].includes(tokenType)) {
        return { provider, authType, status: "error", checkedAt, error: "Railway token_type must be project, account, workspace, or oauth" };
      }
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (tokenType === "project") headers["Project-Access-Token"] = rawToken;
      else headers.Authorization = `Bearer ${rawToken}`;
      const query = tokenType === "project"
        ? "query ProjectTokenInfo { projectToken { projectId environmentId } }"
        : "query RailwaySchemaProbe { __schema { queryType { name } mutationType { name } } }";
      const resp = await fetchWithTimeout("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      });
      const body: any = await readJson(resp);
      if (!resp.ok || (Array.isArray(body.errors) && body.errors.length)) {
        return { provider, authType, status: "error", checkedAt, error: `Railway token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 500)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: tokenType === "project" ? body.data?.projectToken : { token_type: tokenType },
        notes: [
          tokenType === "project"
            ? "Railway project tokens use the Project-Access-Token header and are scoped to one project environment."
            : "Railway account/workspace/OAuth tokens use the Authorization: Bearer header.",
        ],
        checkedAt,
      };
    }

    if (provider === "slack") {
      const resp = await fetchWithTimeout("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok || body.ok === false) {
        return { provider, authType, status: "error", checkedAt, error: `Slack token check failed: ${resp.status} ${body.error ?? JSON.stringify(body).slice(0, 300)}` };
      }
      const scopes = splitScopes(resp.headers.get("x-oauth-scopes"));
      return {
        provider,
        authType,
        status: "ok",
        scopes,
        subject: {
          team: body.team,
          team_id: body.team_id,
          user: body.user,
          user_id: body.user_id,
          bot_id: body.bot_id,
          url: body.url,
        },
        notes: ["Slack token scopes are configured in the app's OAuth & Permissions page; the granted scopes are reported in the x-oauth-scopes response header."],
        checkedAt,
      };
    }

    if (provider === "freee") {
      const resp = await fetchWithTimeout("https://api.freee.co.jp/api/1/users/me?companies=true", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `freee token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      const user = body.user ?? body;
      return {
        provider,
        authType,
        status: "ok",
        scopes: ["read", "write"],
        subject: { id: user.id, email: user.email, display_name: user.display_name },
        resources: Array.isArray(user.companies)
          ? user.companies.slice(0, 50).map((co: any) => ({ id: co.id, name: co.name ?? co.display_name, role: co.role }))
          : undefined,
        notes: ["freee access tokens expire after a few hours; grantry refreshes them with the stored refresh token."],
        checkedAt,
      };
    }

    if (provider === "moneyforward") {
      if (authType !== "oauth") {
        return {
          provider,
          authType,
          status: "error",
          checkedAt,
          error: "Money Forward Cloud Accounting is configured for OAuth only. API key authentication is intentionally disabled.",
        };
      }

      const resp = await fetchWithTimeout("https://api-accounting.moneyforward.com/api/v3/offices", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `Money Forward Cloud Accounting token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: { code: body.code, name: body.name, type: body.type },
        scopes: [
          "mfc/accounting/offices.read",
          "mfc/accounting/accounts.read",
          "mfc/accounting/departments.read",
          "mfc/accounting/taxes.read",
          "mfc/accounting/journal.read",
          "mfc/accounting/report.read",
          "mfc/accounting/trade_partners.read",
          "mfc/accounting/connected_account.read",
        ],
        resources: Array.isArray(body.accounting_periods)
          ? body.accounting_periods.map((period: any) => ({ type: "accounting_period", ...period }))
          : undefined,
        notes: [
          "Money Forward Cloud Accounting API uses OAuth 2.0; API key authentication is not supported for this provider.",
          "Grantry uses the workspace's OAuth app credential instead of a global Money Forward app.",
        ],
        checkedAt,
      };
    }

    if (provider === "reddit") {
      const resp = await fetchWithTimeout("https://oauth.reddit.com/api/v1/me", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "grantry/1.0 (MCP connector)",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `Reddit token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: { name: body.name, id: body.id, total_karma: body.total_karma },
        notes: ["Reddit access tokens expire after one hour; grantry refreshes them with the stored refresh token."],
        checkedAt,
      };
    }

    if (provider === "x") {
      const resp = await fetchWithTimeout("https://api.x.com/2/users/me", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `X token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: { id: body?.data?.id, username: body?.data?.username, name: body?.data?.name },
        notes: ["X access tokens are short-lived; grantry refreshes them with the stored refresh token (requires the offline.access scope)."],
        checkedAt,
      };
    }

    if (provider === "discord") {
      const resp = await fetchWithTimeout("https://discord.com/api/v10/users/@me", {
        headers: {
          Authorization: `Bot ${token}`,
          Accept: "application/json",
          "User-Agent": "grantry (https://grantry.ai, 1.0)",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `Discord bot token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: {
          id: body.id,
          username: body.username,
          global_name: body.global_name,
          bot: body.bot,
        },
        notes: [
          "Discord bot tokens are sent as Authorization: Bot and can access the guilds the bot has been invited to.",
          "Per-action permissions are governed by the bot's role/permissions in each guild; list_members also needs the Server Members privileged intent.",
        ],
        checkedAt,
      };
    }

    if (provider === "line") {
      const resp = await fetchWithTimeout("https://api.line.me/v2/bot/info", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `LINE channel access token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: {
          userId: body.userId,
          basicId: body.basicId,
          premiumId: body.premiumId,
          displayName: body.displayName,
          chatMode: body.chatMode,
          markAsReadMode: body.markAsReadMode,
        },
        notes: [
          "LINE channel access tokens are sent as Authorization: Bearer and are scoped to one Messaging API channel (official account).",
          "Push/multicast volume is limited by the channel's monthly message quota; check line/get_quota.",
        ],
        checkedAt,
      };
    }

    if (provider === "airtable") {
      const resp = await fetchWithTimeout("https://api.airtable.com/v0/meta/whoami", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Airtable token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { id: body.id }, scopes: Array.isArray(body.scopes) ? body.scopes : [], notes: ["Airtable PATs are sent as Authorization: Bearer and scoped to the permissions chosen at token creation."], checkedAt };
    }

    if (provider === "linear") {
      const resp = await fetchWithTimeout("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: token, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ query: "query { viewer { id name email } }" }) });
      const body: any = await readJson(resp);
      if (!resp.ok || (Array.isArray(body.errors) && body.errors.length)) return { provider, authType, status: "error", checkedAt, error: `Linear token check failed: ${resp.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}` };
      const viewer = body.data?.viewer ?? {};
      return { provider, authType, status: "ok", subject: { id: viewer.id, name: viewer.name, email: viewer.email }, notes: ["Linear personal API keys are sent as the Authorization header value (no Bearer prefix)."], checkedAt };
    }

    if (provider === "sendgrid") {
      const resp = await fetchWithTimeout("https://api.sendgrid.com/v3/scopes", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `SendGrid API key check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", scopes: Array.isArray(body.scopes) ? body.scopes : [], notes: ["SendGrid API keys are sent as Authorization: Bearer. Restrict to mail.send for send-only use."], checkedAt };
    }

    if (provider === "vercel") {
      const resp = await fetchWithTimeout("https://api.vercel.com/v2/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Vercel token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      const user = body.user ?? body;
      return { provider, authType, status: "ok", subject: { uid: user.uid, username: user.username, email: user.email }, notes: ["Vercel tokens are sent as Authorization: Bearer. Team-scoped tokens only access that team."], checkedAt };
    }

    if (provider === "stripe") {
      const resp = await fetchWithTimeout("https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Stripe key check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", notes: ["Stripe secret keys are sent as Authorization: Bearer. Use a restricted key to limit access."], checkedAt };
    }

    if (provider === "webflow") {
      const resp = await fetchWithTimeout("https://api.webflow.com/v2/sites", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Webflow token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      const sites = Array.isArray(body.sites) ? body.sites : [];
      return { provider, authType, status: "ok", resources: sites.slice(0, 50).map((s: any) => ({ id: s.id, displayName: s.displayName })), notes: ["Webflow tokens are sent as Authorization: Bearer to the Data API v2."], checkedAt };
    }

    if (provider === "intercom") {
      const resp = await fetchWithTimeout("https://api.intercom.io/me", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Intercom-Version": "2.11" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Intercom token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { type: body.type, email: body.email, name: body.name, app: body.app?.name }, notes: ["Intercom access tokens are sent as Authorization: Bearer."], checkedAt };
    }

    if (provider === "customerio") {
      const t = token.trim();
      let tok = t; let region = "us";
      if (t.startsWith("{")) { const o = JSON.parse(t); tok = String(o.token ?? o.api_key ?? o.apiKey ?? "").trim(); region = String(o.region ?? "us").trim().toLowerCase(); }
      if (!tok) return { provider, authType, status: "error", checkedAt, error: "Customer.io token is empty" };
      const base = region === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";
      const resp = await fetchWithTimeout(`${base}/v1/campaigns`, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Customer.io key check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { region }, notes: ["Customer.io App API key is sent as Authorization: Bearer."], checkedAt };
    }

    if (provider === "mailchimp") {
      const key = token.trim();
      const dash = key.lastIndexOf("-");
      if (dash === -1 || dash === key.length - 1) return { provider, authType, status: "error", checkedAt, error: "Mailchimp API key must end with a datacenter suffix like -us21" };
      const dc = key.slice(dash + 1);
      const resp = await fetchWithTimeout(`https://${dc}.api.mailchimp.com/3.0/`, { headers: { Authorization: "Basic " + Buffer.from("anystring:" + key).toString("base64"), Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Mailchimp key check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { account_name: body.account_name, email: body.email, datacenter: dc }, notes: ["Mailchimp API keys carry their datacenter as the suffix after the last '-' and use HTTP Basic auth."], checkedAt };
    }

    if (provider === "zendesk") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'Zendesk credential must be JSON {"subdomain","email","token"}' }; }
      if (!p.subdomain || !p.email || !p.token) return { provider, authType, status: "error", checkedAt, error: "Zendesk JSON must include subdomain, email, and token" };
      const resp = await fetchWithTimeout(`https://${p.subdomain}.zendesk.com/api/v2/users/me.json`, { headers: { Authorization: "Basic " + Buffer.from(`${p.email}/token:${p.token}`).toString("base64"), Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Zendesk check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { name: body.user?.name, role: body.user?.role, subdomain: p.subdomain }, notes: ["Zendesk API tokens use HTTP Basic auth as email/token:token."], checkedAt };
    }

    if (provider === "wordpress") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'WordPress credential must be JSON {"site","username","app_password"}' }; }
      if (!p.site || !p.username || !p.app_password) return { provider, authType, status: "error", checkedAt, error: "WordPress JSON must include site, username, and app_password" };
      const base = String(p.site).replace(/\/+$/, "");
      const resp = await fetchWithTimeout(`${base}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: "Basic " + Buffer.from(`${p.username}:${p.app_password}`).toString("base64"), Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `WordPress check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { id: body.id, name: body.name, site: base }, notes: ["WordPress Application Passwords use HTTP Basic auth over the REST API."], checkedAt };
    }

    if (provider === "shopify") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'Shopify credential must be JSON {"shop","token"}' }; }
      if (!p.shop || !p.token) return { provider, authType, status: "error", checkedAt, error: "Shopify JSON must include shop and token" };
      const resp = await fetchWithTimeout(`https://${p.shop}/admin/api/2024-10/shop.json`, { headers: { "X-Shopify-Access-Token": p.token, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Shopify check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { name: body.shop?.name, domain: body.shop?.domain, plan: body.shop?.plan_name }, notes: ["Shopify Admin API tokens are sent via the X-Shopify-Access-Token header."], checkedAt };
    }

    if (provider === "jira") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'Jira credential must be JSON {"site","email","token"}' }; }
      const site = String(p.site ?? "").trim().replace(/\/+$/, "");
      if (!site || !p.email || !p.token) return { provider, authType, status: "error", checkedAt, error: "Jira JSON must include site, email, and token" };
      const resp = await fetchWithTimeout(`${site}/rest/api/3/myself`, { headers: { Authorization: "Basic " + Buffer.from(`${p.email}:${p.token}`).toString("base64"), Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Jira check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { accountId: body.accountId, displayName: body.displayName, emailAddress: body.emailAddress }, notes: ["Jira API tokens use HTTP Basic auth as email:token. Permissions follow Jira project roles."], checkedAt };
    }

    if (provider === "salesforce") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'Salesforce credential must be JSON {"instance_url","token"}' }; }
      const instanceUrl = String(p.instance_url ?? p.instanceUrl ?? "").trim().replace(/\/+$/, "");
      const sfToken = String(p.token ?? p.access_token ?? "").trim();
      if (!instanceUrl || !sfToken) return { provider, authType, status: "error", checkedAt, error: "Salesforce JSON must include instance_url and token" };
      const resp = await fetchWithTimeout(`${instanceUrl}/services/oauth2/userinfo`, { headers: { Authorization: `Bearer ${sfToken}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `Salesforce check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { user_id: body.user_id, name: body.name, email: body.email, organization_id: body.organization_id }, notes: ["Salesforce access tokens expire (default ~2h); re-paste when expired."], checkedAt };
    }

    if (provider === "linkedin_ads") {
      const resp = await fetchWithTimeout("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `LinkedIn Ads token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return { provider, authType, status: "ok", subject: { sub: body.sub, name: body.name, email: body.email }, notes: ["LinkedIn access tokens expire (~60 days) and are not auto-refreshed here. Requires r_ads/rw_ads scopes."], checkedAt };
    }

    if (provider === "tiktok_ads") {
      const resp = await fetchWithTimeout("https://business-api.tiktok.com/open_api/v1.3/user/info/", { headers: { "Access-Token": token, "Content-Type": "application/json", Accept: "application/json" } });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `TikTok Ads token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      if (body.code !== 0) return { provider, authType, status: "error", checkedAt, error: `TikTok Ads token check failed: code=${body.code} ${body.message}` };
      const data = body.data ?? {};
      return { provider, authType, status: "ok", subject: { display_name: data.display_name, email: data.email }, notes: ["TikTok for Business API uses the Access-Token header (not Bearer); responses use code=0 for success."], checkedAt };
    }

    if (provider === "microsoft_ads") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'Microsoft Ads credential must be JSON {"developer_token","access_token",...}' }; }
      if (!p.developer_token || !p.access_token) return { provider, authType, status: "error", checkedAt, error: "Microsoft Ads JSON must include developer_token and access_token" };
      return { provider, authType, status: "ok", notes: ["Microsoft Ads is SOAP-based; the credential is validated on the first call.", "The access_token is short-lived and must be refreshed externally via the Microsoft identity platform."], checkedAt };
    }

    if (provider === "aws") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'AWS credential must be JSON {"accessKeyId","secretAccessKey","region"}' }; }
      if (!p.accessKeyId || !p.secretAccessKey) return { provider, authType, status: "error", checkedAt, error: "AWS JSON must include accessKeyId and secretAccessKey" };
      try {
        const { callAwsTool } = await import("./aws.js");
        const res: any = await callAwsTool("aws/get_caller_identity", {}, token);
        const sc = res?.structuredContent ?? {};
        return { provider, authType, status: "ok", subject: { Account: sc.Account, Arn: sc.Arn, region: p.region ?? "us-east-1" }, notes: ["AWS requests are signed with SigV4. Permissions follow the IAM identity's policies."], checkedAt };
      } catch (e: any) {
        return { provider, authType, status: "error", checkedAt, error: `AWS GetCallerIdentity failed: ${String(e?.message ?? e).slice(0, 300)}` };
      }
    }

    if (provider === "snowflake") {
      let p: any; try { p = JSON.parse(token.trim()); } catch { return { provider, authType, status: "error", checkedAt, error: 'Snowflake credential must be JSON {"account","token",...}' }; }
      if (!p.account || !p.token) return { provider, authType, status: "error", checkedAt, error: "Snowflake JSON must include account and token" };
      return { provider, authType, status: "ok", subject: { account: p.account }, notes: ["Snowflake tokens are validated on the first execute_statement call.", "Uses the SQL API v2 with Authorization: Bearer and X-Snowflake-Authorization-Token-Type."], checkedAt };
    }

    if (provider === "zoom") {
      const resp = await fetchWithTimeout("https://api.zoom.us/v2/users/me", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) {
        return { provider, authType, status: "error", checkedAt, error: `Zoom token check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      }
      return {
        provider,
        authType,
        status: "ok",
        subject: { email: body.email, account_id: body.account_id, type: body.type },
        notes: ["Zoom OAuth access token. Granted scopes follow the connected Zoom OAuth app's configuration."],
        checkedAt,
      };
    }

    if (provider === "godaddy") {
      const cred = token.trim();
      if (!cred.includes(":")) return { provider, authType, status: "error", checkedAt, error: "GoDaddy credential must be in KEY:SECRET format" };
      const resp = await fetchWithTimeout("https://api.godaddy.com/v1/domains/available?domain=grantry-availability-check.com", {
        headers: { Authorization: `sso-key ${cred}`, Accept: "application/json" },
      });
      const body: any = await readJson(resp);
      if (!resp.ok) return { provider, authType, status: "error", checkedAt, error: `GoDaddy API key check failed: ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
      return {
        provider,
        authType,
        status: "ok",
        notes: [
          "GoDaddy API keys are sent as Authorization: sso-key KEY:SECRET against the Production API (api.godaddy.com).",
          "GoDaddy restricts the production Domains API by account eligibility (historically 10+ domains or reseller); some endpoints may return 403 for small accounts even with a valid key.",
        ],
        checkedAt,
      };
    }

    return {
      provider,
      authType,
      status: "unknown",
      notes: ["Credential introspection is not implemented for this provider."],
      checkedAt,
    };
  } catch (e: any) {
    return {
      provider,
      authType,
      status: "error",
      checkedAt,
      error: e?.name === "AbortError" ? `Credential check timed out after ${META_TIMEOUT_MS}ms` : String(e?.message ?? e),
    };
  }
}

export async function credentialMetadataForStorage(provider: string, authType: string, token: string) {
  const metadata = await inspectCredential(provider, authType, token);
  const providerDef = getProvider(provider);
  if (providerDef?.genericRequest) {
    const checkedAt = new Date().toISOString();
    try {
      const [check, capabilities] = await Promise.all([
        callGenericCheckConnection({ provider: providerDef, credential: token }),
        callGenericListCapabilities({ provider: providerDef }),
      ]);
      const checkContent = check.structuredContent ?? {};
      const capabilityContent = capabilities.structuredContent ?? {};
      const smokeTests = Array.isArray(checkContent.tests) ? checkContent.tests : [];
      const operations = Array.isArray(capabilityContent.operations) ? capabilityContent.operations : [];
      const missingScopes = Array.from(new Set(
        smokeTests.flatMap((test: any) => Array.isArray(test.missingScopes) ? test.missingScopes.map(String) : []),
      ));
      metadata.capabilities = {
        status: checkContent.status === "ok" ? "ok" : checkContent.status === "error" ? "error" : "unknown",
        smokeTests,
        operations,
        missingScopes,
        checkedAt,
      };
    } catch (e: any) {
      metadata.capabilities = {
        status: "unknown",
        checkedAt,
        error: String(e?.message ?? e).slice(0, 500),
      };
    }
  }
  return {
    credentialMetadata: JSON.stringify(metadata).slice(0, 16000),
    credentialValidatedAt: new Date(),
  };
}
