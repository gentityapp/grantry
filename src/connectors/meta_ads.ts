// Meta (Facebook) Marketing API connector — OAuth access token.
// Talks to the Graph API: https://graph.facebook.com/<version>.
const META_ADS_API_VERSION = process.env.META_ADS_API_VERSION || "v21.0";
const META_ADS_API = `https://graph.facebook.com/${META_ADS_API_VERSION}`;
const META_ADS_TIMEOUT_MS = 10_000;

type MetaAdsArgs = Record<string, unknown>;

/** Normalize a Meta ad account id to the act_<digits> form the Graph API expects. */
function adAccountId(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("account_id is required");
  return raw.startsWith("act_") ? raw : `act_${raw.replace(/^act_/, "")}`;
}

function requireId(value: unknown, name: string) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${name} is required`);
  return raw;
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function clampLimit(value: unknown, fallback = 25) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 500);
}

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchMetaAds(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_ADS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[meta_ads] request", { path, apiVersion: META_ADS_API_VERSION, ...logContext });
    const response = await fetch(`${META_ADS_API}${path}`, { ...init, signal: controller.signal });
    console.log("[meta_ads] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[meta_ads] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${META_ADS_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Meta Ads request timed out after ${META_ADS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(token: string, path: string, query: Record<string, string | undefined>, logContext: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, v);
  }
  const qs = params.toString();
  const r = await fetchMetaAds(`${path}${qs ? `?${qs}` : ""}`, { headers: headers(token) }, logContext);
  const j: any = await readJsonResponse(r);
  if (!r.ok || j.error) {
    throw new Error(`Meta Ads ${logContext.tool ?? path} failed: ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 1200)}`);
  }
  return j;
}

async function postJson(token: string, path: string, body: Record<string, unknown>, logContext: Record<string, unknown>) {
  const r = await fetchMetaAds(path, { method: "POST", headers: headers(token), body: JSON.stringify(body ?? {}) }, logContext);
  const j: any = await readJsonResponse(r);
  if (!r.ok || j.error) {
    throw new Error(`Meta Ads ${logContext.tool ?? path} failed: ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 1200)}`);
  }
  return j;
}

function fieldsParam(value: unknown, fallback: string) {
  const v = String(value ?? "").trim();
  return v || fallback;
}

export async function callMetaAdsTool(tool: string, args: MetaAdsArgs, token: string) {
  if (tool === "meta_ads/list_ad_accounts") {
    const j = await getJson(token, "/me/adaccounts", {
      fields: fieldsParam(args.fields, "id,account_id,name,account_status,currency,timezone_name"),
      limit: String(clampLimit(args.limit)),
      after: args.after ? String(args.after) : undefined,
    }, { tool });
    return {
      structuredContent: {
        api_version: META_ADS_API_VERSION,
        results: j.data ?? [],
        paging: j.paging ?? null,
      },
    };
  }

  if (tool === "meta_ads/get_ad_account") {
    const id = adAccountId(args.account_id ?? args.accountId);
    const j = await getJson(token, `/${id}`, {
      fields: fieldsParam(args.fields, "id,account_id,name,account_status,currency,timezone_name,amount_spent,balance,business"),
    }, { tool, accountId: id });
    return { structuredContent: { api_version: META_ADS_API_VERSION, account: j } };
  }

  if (tool === "meta_ads/list_campaigns") {
    const id = adAccountId(args.account_id ?? args.accountId);
    const j = await getJson(token, `/${id}/campaigns`, {
      fields: fieldsParam(args.fields, "id,name,status,objective,effective_status,daily_budget,lifetime_budget,created_time,start_time,stop_time"),
      limit: String(clampLimit(args.limit)),
      after: args.after ? String(args.after) : undefined,
      effective_status: args.effective_status ? String(args.effective_status) : undefined,
    }, { tool, accountId: id });
    return {
      structuredContent: {
        api_version: META_ADS_API_VERSION,
        results: j.data ?? [],
        paging: j.paging ?? null,
      },
    };
  }

  if (tool === "meta_ads/get_campaign") {
    const campaignId = requireId(args.campaign_id ?? args.campaignId, "campaign_id");
    const j = await getJson(token, `/${campaignId}`, {
      fields: fieldsParam(args.fields, "id,name,status,objective,effective_status,daily_budget,lifetime_budget,created_time,start_time,stop_time,special_ad_categories"),
    }, { tool, campaignId });
    return { structuredContent: { api_version: META_ADS_API_VERSION, campaign: j } };
  }

  if (tool === "meta_ads/list_ad_sets") {
    // Accept either an ad account (account_id) or a campaign (campaign_id) as the parent.
    const campaignId = String(args.campaign_id ?? args.campaignId ?? "").trim();
    const parent = campaignId ? campaignId : adAccountId(args.account_id ?? args.accountId);
    const j = await getJson(token, `/${parent}/adsets`, {
      fields: fieldsParam(args.fields, "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,created_time"),
      limit: String(clampLimit(args.limit)),
      after: args.after ? String(args.after) : undefined,
    }, { tool, parent });
    return {
      structuredContent: {
        api_version: META_ADS_API_VERSION,
        results: j.data ?? [],
        paging: j.paging ?? null,
      },
    };
  }

  if (tool === "meta_ads/list_ads") {
    // Accept an ad account, campaign, or ad set as the parent.
    const adsetId = String(args.adset_id ?? args.adsetId ?? "").trim();
    const campaignId = String(args.campaign_id ?? args.campaignId ?? "").trim();
    const parent = adsetId || campaignId || adAccountId(args.account_id ?? args.accountId);
    const j = await getJson(token, `/${parent}/ads`, {
      fields: fieldsParam(args.fields, "id,name,status,effective_status,adset_id,campaign_id,creative,created_time"),
      limit: String(clampLimit(args.limit)),
      after: args.after ? String(args.after) : undefined,
    }, { tool, parent });
    return {
      structuredContent: {
        api_version: META_ADS_API_VERSION,
        results: j.data ?? [],
        paging: j.paging ?? null,
      },
    };
  }

  if (tool === "meta_ads/get_insights") {
    // object_id may be an ad account (act_…), campaign, ad set, or ad id.
    const objectId = String(args.object_id ?? args.objectId ?? "").trim()
      || adAccountId(args.account_id ?? args.accountId);
    const timeRange = args.time_range && typeof args.time_range === "object"
      ? JSON.stringify(args.time_range)
      : undefined;
    const j = await getJson(token, `/${objectId}/insights`, {
      fields: fieldsParam(args.fields, "impressions,clicks,spend,cpc,cpm,ctr,reach,actions"),
      level: args.level ? String(args.level) : undefined,
      date_preset: args.date_preset ? String(args.date_preset) : (timeRange ? undefined : "last_30d"),
      time_range: timeRange,
      breakdowns: args.breakdowns ? String(args.breakdowns) : undefined,
      limit: String(clampLimit(args.limit)),
      after: args.after ? String(args.after) : undefined,
    }, { tool, objectId });
    return {
      structuredContent: {
        api_version: META_ADS_API_VERSION,
        results: j.data ?? [],
        paging: j.paging ?? null,
      },
    };
  }

  if (tool === "meta_ads/create_campaign") {
    const id = adAccountId(args.account_id ?? args.accountId);
    const campaign = args.campaign && typeof args.campaign === "object" && !Array.isArray(args.campaign)
      ? (args.campaign as Record<string, unknown>)
      : null;
    if (!campaign) throw new Error("campaign object is required (e.g. { name, objective, status, special_ad_categories })");
    const j = await postJson(token, `/${id}/campaigns`, campaign, { tool, accountId: id });
    return { structuredContent: { api_version: META_ADS_API_VERSION, result: j } };
  }

  if (tool === "meta_ads/update_campaign") {
    const campaignId = requireId(args.campaign_id ?? args.campaignId, "campaign_id");
    const updates = args.updates && typeof args.updates === "object" && !Array.isArray(args.updates)
      ? (args.updates as Record<string, unknown>)
      : null;
    if (!updates) throw new Error("updates object is required (e.g. { name, status, daily_budget })");
    const j = await postJson(token, `/${campaignId}`, updates, { tool, campaignId });
    return { structuredContent: { api_version: META_ADS_API_VERSION, result: j } };
  }

  throw new Error(`Unknown Meta Ads tool: ${tool}`);
}
