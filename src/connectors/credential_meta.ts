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

    if (provider.startsWith("google_") || provider === "gmail" || provider === "youtube") {
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

    if (provider === "railway") {
      let rawToken = token.trim();
      let tokenType = "project";
      if (rawToken.startsWith("{")) {
        const parsed = JSON.parse(rawToken);
        rawToken = String(parsed.token ?? parsed.api_token ?? parsed.apiToken ?? "").trim();
        tokenType = String(parsed.token_type ?? parsed.tokenType ?? "project").trim().toLowerCase();
      }
      if (!rawToken) {
        return { provider, authType, status: "error", checkedAt, error: "Railway token is required" };
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
  return {
    credentialMetadata: JSON.stringify(metadata).slice(0, 8000),
    credentialValidatedAt: new Date(),
  };
}
