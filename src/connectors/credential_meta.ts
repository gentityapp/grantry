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
          "User-Agent": "agent-oauth",
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

    if (provider.startsWith("google_") || provider === "gmail") {
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
          "LINE Yahoo Ads access tokens expire after one hour; gentity-auth refreshes them with the stored refresh token.",
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
