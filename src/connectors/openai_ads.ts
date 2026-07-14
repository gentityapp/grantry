// OpenAI Ads connector — API key authentication via Authorization: Bearer <key>.
// Targets the OpenAI Ads REST API v1 (https://api.ads.openai.com/v1).
// Read tools cover ad account, campaigns, ad groups, ads and insights.
// Writes (create/update/activate/pause/archive, uploads) go through
// openai_ads/request (generic POST passthrough).
//
// Credential: paste an OpenAI Ads API key from https://ads.openai.com.
// It is sent as Authorization: Bearer <key>.
const OPENAI_ADS_API = "https://api.ads.openai.com/v1";
const OPENAI_ADS_TIMEOUT_MS = 30_000;

type OpenAIAdsArgs = Record<string, unknown>;

function parseCredential(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: any = JSON.parse(trimmed);
      const apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
      if (!apiKey) throw new Error("OpenAI Ads credential JSON must include api_key");
      return apiKey;
    } catch (e: any) {
      if (e?.message?.includes("must include")) throw e;
      throw new Error('OpenAI Ads credential JSON is invalid; expected {"api_key":"..."}');
    }
  }
  if (!trimmed) throw new Error("OpenAI Ads API key is required");
  return trimmed;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
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

// Build a URLSearchParams from a plain object; array values are repeated so that
// insights params like fields[] / time_ranges[] serialize the way the API wants.
function toQuery(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
      }
    } else if (typeof value === "object") {
      params.append(key, JSON.stringify(value));
    } else {
      params.append(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function request(apiKey: string, method: string, path: string, body: unknown, tool: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_ADS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[openai_ads] request", { path, tool, method });
    const init: RequestInit = { method, headers: headers(apiKey), signal: controller.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${OPENAI_ADS_API}${path}`, init);
    console.log("[openai_ads] response", { path, tool, status: r.status, durationMs: Date.now() - started });
    const j: any = await readJsonResponse(r);
    if (!r.ok) {
      const message = j?.error?.message ?? j?.error ?? JSON.stringify(j).slice(0, 1000);
      throw new Error(`OpenAI Ads ${tool} failed: ${r.status} ${typeof message === "string" ? message : JSON.stringify(message)}`);
    }
    return j;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`OpenAI Ads request timed out after ${OPENAI_ADS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function requireId(args: OpenAIAdsArgs, ...keys: string[]): string {
  for (const key of keys) {
    const v = String(args[key] ?? "").trim();
    if (v) return v;
  }
  throw new Error(`${keys[0]} is required`);
}

const INSIGHTS_LEVELS: Record<string, (id: string) => string> = {
  ad_account: () => "/ad_account/insights",
  campaign: (id) => `/campaigns/${encodeURIComponent(id)}/insights`,
  ad_group: (id) => `/ad_groups/${encodeURIComponent(id)}/insights`,
  ad: (id) => `/ads/${encodeURIComponent(id)}/insights`,
};

export async function callOpenAIAdsTool(tool: string, args: OpenAIAdsArgs, rawCredential: string) {
  const apiKey = parseCredential(rawCredential);

  if (tool === "openai_ads/get_ad_account") {
    const json = await request(apiKey, "GET", "/ad_account", undefined, tool);
    return { structuredContent: json };
  }

  if (tool === "openai_ads/list_campaigns") {
    const json = await request(apiKey, "GET", `/campaigns${toQuery(args.query)}`, undefined, tool);
    return { structuredContent: json };
  }

  if (tool === "openai_ads/get_campaign") {
    const id = requireId(args, "campaign_id");
    const json = await request(apiKey, "GET", `/campaigns/${encodeURIComponent(id)}`, undefined, tool);
    return { structuredContent: json };
  }

  if (tool === "openai_ads/list_ad_groups") {
    const json = await request(apiKey, "GET", `/ad_groups${toQuery(args.query)}`, undefined, tool);
    return { structuredContent: json };
  }

  if (tool === "openai_ads/get_ad_group") {
    const id = requireId(args, "ad_group_id");
    const json = await request(apiKey, "GET", `/ad_groups/${encodeURIComponent(id)}`, undefined, tool);
    return { structuredContent: json };
  }

  if (tool === "openai_ads/list_ads") {
    const json = await request(apiKey, "GET", `/ads${toQuery(args.query)}`, undefined, tool);
    return { structuredContent: json };
  }

  if (tool === "openai_ads/get_ad") {
    const id = requireId(args, "ad_id");
    const json = await request(apiKey, "GET", `/ads/${encodeURIComponent(id)}`, undefined, tool);
    return { structuredContent: json };
  }

  if (tool === "openai_ads/get_insights") {
    const level = String(args.level ?? "ad_account").trim();
    const builder = INSIGHTS_LEVELS[level];
    if (!builder) throw new Error(`level must be one of: ${Object.keys(INSIGHTS_LEVELS).join(", ")}`);
    const id = level === "ad_account" ? "" : requireId(args, "id");
    const json = await request(apiKey, "GET", `${builder(id)}${toQuery(args.query)}`, undefined, tool);
    return { structuredContent: json };
  }

  throw new Error(`Unknown OpenAI Ads tool: ${tool}`);
}
