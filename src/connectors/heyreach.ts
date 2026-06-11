// HeyReach connector - Public API key authentication.
const HEYREACH_API = "https://api.heyreach.io/api/public";
const HEYREACH_TIMEOUT_MS = 12_000;

type HeyReachArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(apiKey: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-KEY": apiKey,
  };
}

async function fetchHeyReach(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEYREACH_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[heyreach] request", { path, ...logContext });
    const response = await fetch(`${HEYREACH_API}${path}`, { ...init, signal: controller.signal });
    console.log("[heyreach] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[heyreach] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${HEYREACH_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`HeyReach request timed out after ${HEYREACH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function bodyFromArgs(args: HeyReachArgs, fallbackKeys: string[] = []) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data;
  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) return args.body;
  const body: Record<string, unknown> = {};
  for (const key of fallbackKeys) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  return body;
}

function rawBody(args: HeyReachArgs) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data as Record<string, unknown>;
  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) return args.body as Record<string, unknown>;
  return null;
}

function idArg(args: HeyReachArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function postJson(apiKey: string, path: string, body: unknown, tool: string) {
  const r = await fetchHeyReach(path, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  }, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`HeyReach ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callHeyReachTool(tool: string, args: HeyReachArgs, apiKey: string) {
  if (tool === "heyreach/check_api_key") {
    const r = await fetchHeyReach("/auth/CheckApiKey", { headers: headers(apiKey) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HeyReach check_api_key failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "heyreach/list_campaigns") {
    const body = {
      offset: boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: boundedInteger(args.limit, 100, 1, 100),
      ...bodyFromArgs(args),
    };
    return { structuredContent: await postJson(apiKey, "/campaign/GetAll", body, tool) };
  }

  if (tool === "heyreach/get_campaign") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    const r = await fetchHeyReach(`/campaign/GetById?campaignId=${encodeURIComponent(campaignId)}`, {
      headers: headers(apiKey),
    }, { tool, campaignId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HeyReach get_campaign failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "heyreach/pause_campaign" || tool === "heyreach/resume_campaign") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    const action = tool === "heyreach/pause_campaign" ? "Pause" : "Resume";
    const r = await fetchHeyReach(`/campaign/${action}?campaignId=${encodeURIComponent(campaignId)}`, {
      method: "POST",
      headers: headers(apiKey),
    }, { tool, campaignId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HeyReach ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "heyreach/add_leads_to_campaign") {
    const body = rawBody(args) ?? {
      campaignId: args.campaignId ?? args.campaign_id,
      leads: args.leads,
      linkedInAccountIds: args.linkedInAccountIds ?? args.linkedin_account_ids,
    };
    return { structuredContent: await postJson(apiKey, "/campaign/AddLeadsToCampaignV2", body, tool) };
  }

  if (tool === "heyreach/list_leads") {
    const body = {
      offset: boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: boundedInteger(args.limit, 100, 1, 100),
      ...(rawBody(args) ?? {
        campaignId: args.campaignId ?? args.campaign_id,
        leadListId: args.leadListId ?? args.lead_list_id,
        statuses: args.statuses,
      }),
    };
    return { structuredContent: await postJson(apiKey, "/lead/GetAll", body, tool) };
  }

  if (tool === "heyreach/list_conversations") {
    const body = {
      offset: boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: boundedInteger(args.limit, 100, 1, 100),
      ...bodyFromArgs(args),
    };
    return { structuredContent: await postJson(apiKey, "/inbox/GetConversationsV2", body, tool) };
  }

  if (tool === "heyreach/list_lead_lists") {
    const body = {
      offset: boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: boundedInteger(args.limit, 100, 1, 100),
      ...bodyFromArgs(args),
    };
    return { structuredContent: await postJson(apiKey, "/list/GetAll", body, tool) };
  }

  if (tool === "heyreach/create_empty_list") {
    const body = bodyFromArgs(args, ["name"]);
    if (!Object.keys(body).length) throw new Error("name or data object is required");
    return { structuredContent: await postJson(apiKey, "/list/CreateEmptyList", body, tool) };
  }

  if (tool === "heyreach/get_overall_stats") {
    return { structuredContent: await postJson(apiKey, "/stats/GetOverallStats", bodyFromArgs(args), tool) };
  }

  throw new Error(`Unknown HeyReach tool: ${tool}`);
}
