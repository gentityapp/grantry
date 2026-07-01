// Smartlead connector - API key authentication via `api_key` query parameter.
const SMARTLEAD_API = "https://server.smartlead.ai/api/v1";
const SMARTLEAD_TIMEOUT_MS = 12_000;

type SmartleadArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/** Append the api_key query param (Smartlead auth) to a path that may already carry a query string. */
function withApiKey(path: string, apiKey: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}api_key=${encodeURIComponent(apiKey)}`;
}

async function fetchSmartlead(path: string, apiKey: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SMARTLEAD_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[smartlead] request", { path, ...logContext });
    const response = await fetch(`${SMARTLEAD_API}${withApiKey(path, apiKey)}`, { ...init, signal: controller.signal });
    console.log("[smartlead] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[smartlead] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${SMARTLEAD_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Smartlead request timed out after ${SMARTLEAD_TIMEOUT_MS}ms`);
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

function bodyFromArgs(args: SmartleadArgs, fallbackKeys: string[] = []) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data;
  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) return args.body;
  const body: Record<string, unknown> = {};
  for (const key of fallbackKeys) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  return body;
}

function rawBody(args: SmartleadArgs) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data as Record<string, unknown>;
  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) return args.body as Record<string, unknown>;
  return null;
}

function idArg(args: SmartleadArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function getJson(apiKey: string, path: string, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchSmartlead(path, apiKey, { headers: headers() }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Smartlead ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

async function postJson(apiKey: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchSmartlead(path, apiKey, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Smartlead ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callSmartleadTool(tool: string, args: SmartleadArgs, apiKey: string) {
  if (tool === "smartlead/check_connection") {
    return { structuredContent: await getJson(apiKey, "/campaigns?limit=1", tool) };
  }

  if (tool === "smartlead/list_campaigns") {
    return { structuredContent: await getJson(apiKey, "/campaigns", tool) };
  }

  if (tool === "smartlead/get_campaign") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    return { structuredContent: await getJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}`, tool, { campaignId }) };
  }

  if (tool === "smartlead/create_campaign") {
    const body = bodyFromArgs(args, ["name", "client_id"]);
    if (!Object.keys(body).length) throw new Error("name or data object is required");
    return { structuredContent: await postJson(apiKey, "/campaigns/create", body, tool) };
  }

  if (tool === "smartlead/update_campaign_status") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    const body = rawBody(args) ?? { status: args.status };
    return { structuredContent: await postJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}/status`, body, tool, { campaignId }) };
  }

  if (tool === "smartlead/save_sequence") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    const body = rawBody(args) ?? { sequences: args.sequences };
    return { structuredContent: await postJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}/sequences`, body, tool, { campaignId }) };
  }

  if (tool === "smartlead/add_leads_to_campaign") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    const body = rawBody(args) ?? {
      lead_list: args.lead_list ?? args.leadList,
      settings: args.settings,
    };
    return { structuredContent: await postJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}/leads`, body, tool, { campaignId }) };
  }

  if (tool === "smartlead/list_campaign_leads") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(args.limit, 100, 1, 100);
    return { structuredContent: await getJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}/leads?offset=${offset}&limit=${limit}`, tool, { campaignId }) };
  }

  if (tool === "smartlead/get_campaign_analytics") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    return { structuredContent: await getJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}/analytics`, tool, { campaignId }) };
  }

  if (tool === "smartlead/get_campaign_statistics") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    return { structuredContent: await getJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}/statistics`, tool, { campaignId }) };
  }

  if (tool === "smartlead/get_message_history") {
    const campaignId = idArg(args, "campaign_id", ["id"]);
    const leadId = idArg(args, "lead_id", ["leadId"]);
    return { structuredContent: await getJson(apiKey, `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/message-history`, tool, { campaignId, leadId }) };
  }

  if (tool === "smartlead/list_email_accounts") {
    return { structuredContent: await getJson(apiKey, "/email-accounts/", tool) };
  }

  throw new Error(`Unknown Smartlead tool: ${tool}`);
}
