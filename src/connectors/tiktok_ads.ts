// TikTok Ads connector - TikTok for Business API v1.3.
// Credential: plain TikTok for Business access token (NOT Bearer).
// Auth via "Access-Token" header.
// NOTE: TikTok returns HTTP 200 with body {code, message, data}; code!==0 is treated as an error.
const TIKTOK_ADS_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const TIKTOK_TIMEOUT_MS = 12_000;

type TiktokAdsArgs = Record<string, unknown>;

async function readJson(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function ttHeaders(token: string) {
  return {
    "Access-Token": token,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function fetchTiktok(
  url: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIKTOK_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[tiktok_ads] request", { url, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[tiktok_ads] response", {
      url,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[tiktok_ads] failed", {
      url,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${TIKTOK_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`TikTok Ads request timed out after ${TIKTOK_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestGet(
  token: string,
  path: string,
  queryParams: Record<string, unknown>,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const urlParams = new URLSearchParams();
  for (const [k, v] of Object.entries(queryParams)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") {
      urlParams.set(k, JSON.stringify(v));
    } else {
      urlParams.set(k, String(v));
    }
  }
  const qs = urlParams.toString();
  const url = `${TIKTOK_ADS_BASE}${path}${qs ? `?${qs}` : ""}`;
  const init: RequestInit = { method: "GET", headers: ttHeaders(token) };
  const r = await fetchTiktok(url, init, { tool, ...logContext });
  const j: any = await readJson(r);
  if (!r.ok) throw new Error(`TikTok Ads ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  if (j.code !== 0) throw new Error(`TikTok Ads ${tool} failed: code=${j.code} message=${j.message}`);
  return j;
}

function idArg(args: TiktokAdsArgs, snake: string) {
  const value = String(args[snake] ?? args[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

export async function callTiktokAdsTool(tool: string, args: TiktokAdsArgs, credential: string) {
  const token = credential.trim();
  if (!token) throw new Error("TikTok Ads access token is empty");

  if (tool === "tiktok_ads/get_user_info") {
    const j = await requestGet(token, "/user/info/", {}, tool);
    return { structuredContent: j.data ?? j };
  }

  if (tool === "tiktok_ads/get_advertiser_info") {
    let advertiserIds = args.advertiser_ids ?? args.advertiserIds;
    if (!advertiserIds) throw new Error("advertiser_ids is required");
    // Accept array or comma-separated string
    if (typeof advertiserIds === "string") {
      advertiserIds = advertiserIds.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(advertiserIds)) advertiserIds = [advertiserIds];
    const j = await requestGet(token, "/advertiser/info/", { advertiser_ids: advertiserIds }, tool);
    return { structuredContent: j.data ?? j };
  }

  if (tool === "tiktok_ads/list_campaigns") {
    const advertiserId = idArg(args, "advertiser_id");
    const query: Record<string, unknown> = { advertiser_id: advertiserId };
    if (args.page !== undefined && args.page !== null && args.page !== "") query.page = args.page;
    if (args.page_size !== undefined && args.page_size !== null && args.page_size !== "") query.page_size = args.page_size;
    const j = await requestGet(token, "/campaign/get/", query, tool, { advertiserId });
    return { structuredContent: j.data ?? j };
  }

  if (tool === "tiktok_ads/list_adgroups") {
    const advertiserId = idArg(args, "advertiser_id");
    const query: Record<string, unknown> = { advertiser_id: advertiserId };
    if (args.page !== undefined && args.page !== null && args.page !== "") query.page = args.page;
    if (args.page_size !== undefined && args.page_size !== null && args.page_size !== "") query.page_size = args.page_size;
    const j = await requestGet(token, "/adgroup/get/", query, tool, { advertiserId });
    return { structuredContent: j.data ?? j };
  }

  if (tool === "tiktok_ads/list_ads") {
    const advertiserId = idArg(args, "advertiser_id");
    const query: Record<string, unknown> = { advertiser_id: advertiserId };
    if (args.page !== undefined && args.page !== null && args.page !== "") query.page = args.page;
    if (args.page_size !== undefined && args.page_size !== null && args.page_size !== "") query.page_size = args.page_size;
    const j = await requestGet(token, "/ad/get/", query, tool, { advertiserId });
    return { structuredContent: j.data ?? j };
  }

  if (tool === "tiktok_ads/get_report") {
    const advertiserId = idArg(args, "advertiser_id");
    const params = args.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("params must be an object");
    }
    const query: Record<string, unknown> = {
      advertiser_id: advertiserId,
      ...(params as Record<string, unknown>),
    };
    const j = await requestGet(token, "/report/integrated/get/", query, tool, { advertiserId });
    return { structuredContent: j.data ?? j };
  }

  throw new Error(`Unknown TikTok Ads tool: ${tool}`);
}
