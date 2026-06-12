// LinkedIn Ads connector - LinkedIn Marketing API (REST).
// Credential: plain LinkedIn OAuth access token (Bearer).
// NOTE: LinkedIn access tokens expire after ~60 days and are NOT auto-refreshed here.
const LINKEDIN_ADS_BASE = "https://api.linkedin.com/rest";
const LINKEDIN_TIMEOUT_MS = 12_000;

type LinkedinAdsArgs = Record<string, unknown>;

async function readJson(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function liHeaders(token: string, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "LinkedIn-Version": "202410",
    "X-Restli-Protocol-Version": "2.0.0",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchLinkedin(
  url: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINKEDIN_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[linkedin_ads] request", { url, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[linkedin_ads] response", {
      url,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[linkedin_ads] failed", {
      url,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${LINKEDIN_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`LinkedIn Ads request timed out after ${LINKEDIN_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  token: string,
  method: string,
  url: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const hasBody = body !== undefined;
  const init: RequestInit = { method, headers: liHeaders(token, hasBody) };
  if (hasBody) init.body = JSON.stringify(body);
  const r = await fetchLinkedin(url, init, { tool, ...logContext });
  const j: any = await readJson(r);
  if (!r.ok) throw new Error(`LinkedIn Ads ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function idArg(args: LinkedinAdsArgs, snake: string) {
  const value = String(args[snake] ?? args[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

function queryString(args: LinkedinAdsArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function callLinkedinAdsTool(tool: string, args: LinkedinAdsArgs, credential: string) {
  const token = credential.trim();
  if (!token) throw new Error("LinkedIn Ads access token is empty");

  if (tool === "linkedin_ads/list_ad_accounts") {
    const qs = queryString(args, ["start", "count"]);
    const url = `${LINKEDIN_ADS_BASE}/adAccounts?q=search${qs ? `&${qs.slice(1)}` : ""}`;
    return { structuredContent: await request(token, "GET", url, undefined, tool) };
  }

  if (tool === "linkedin_ads/get_ad_account") {
    const accountId = idArg(args, "account_id");
    return {
      structuredContent: await request(
        token,
        "GET",
        `${LINKEDIN_ADS_BASE}/adAccounts/${encodeURIComponent(accountId)}`,
        undefined,
        tool,
        { accountId },
      ),
    };
  }

  if (tool === "linkedin_ads/list_campaigns") {
    const accountId = idArg(args, "account_id");
    return {
      structuredContent: await request(
        token,
        "GET",
        `${LINKEDIN_ADS_BASE}/adAccounts/${encodeURIComponent(accountId)}/adCampaigns?q=search`,
        undefined,
        tool,
        { accountId },
      ),
    };
  }

  if (tool === "linkedin_ads/get_campaign") {
    const campaignId = idArg(args, "campaign_id");
    return {
      structuredContent: await request(
        token,
        "GET",
        `${LINKEDIN_ADS_BASE}/adCampaigns/${encodeURIComponent(campaignId)}`,
        undefined,
        tool,
        { campaignId },
      ),
    };
  }

  if (tool === "linkedin_ads/get_analytics") {
    const params = args.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("params must be an object");
    }
    const urlParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (v === undefined || v === null || v === "") continue;
      urlParams.set(k, String(v));
    }
    const qs = urlParams.toString();
    const url = `${LINKEDIN_ADS_BASE}/adAnalytics${qs ? `?${qs}` : ""}`;
    return { structuredContent: await request(token, "GET", url, undefined, tool) };
  }

  throw new Error(`Unknown LinkedIn Ads tool: ${tool}`);
}
