// LangGraph Platform connector - API key via the x-api-key header.
// Targets a LangGraph Server deployment (LangGraph Platform or self-hosted), whose
// URL is per-deployment and therefore always supplied in the credential's base_url.
// Docs: https://docs.langchain.com/langgraph-platform (each server also serves /openapi.json)
const LANGGRAPH_TIMEOUT_MS = 30_000;

type LanggraphArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let apiKey = "";
  let baseUrl = "";
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
      baseUrl = String(parsed.base_url ?? parsed.baseUrl ?? parsed.deployment_url ?? "").trim().replace(/\/+$/, "");
    }
  } catch {
    // A bare key is accepted, but a deployment URL is still required.
  }
  if (!apiKey) throw new Error("LangGraph credential requires an api_key");
  if (!baseUrl) throw new Error("LangGraph credential requires a base_url (the deployment URL)");
  return { apiKey, baseUrl };
}

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function fetchLanggraph(baseUrl: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LANGGRAPH_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[langgraph] request", { path, ...logContext });
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    console.log("[langgraph] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[langgraph] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${LANGGRAPH_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`LangGraph request timed out after ${LANGGRAPH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const { apiKey, baseUrl } = parseCredential(credential);
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchLanggraph(baseUrl, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`LangGraph ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: LanggraphArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: LanggraphArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

/** Copies the supplied args into a JSON body, dropping the ones the caller omitted. */
function bodyFrom(args: LanggraphArgs, keys: string[]) {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = args[key] ?? args[camel];
    if (value !== undefined && value !== null && value !== "") body[key] = value;
  }
  return body;
}

function searchBody(args: LanggraphArgs, extraKeys: string[] = []) {
  const body = bodyFrom(args, ["metadata", "limit", "offset", ...extraKeys]);
  if (body.limit === undefined) body.limit = 20;
  return body;
}

export async function callLanggraphTool(tool: string, args: LanggraphArgs, credential: string) {
  if (tool === "langgraph/get_info") {
    return { structuredContent: await request(credential, "GET", "/info", undefined, tool) };
  }

  if (tool === "langgraph/search_assistants") {
    return { structuredContent: await request(credential, "POST", "/assistants/search", searchBody(args, ["graph_id", "name"]), tool) };
  }

  if (tool === "langgraph/get_assistant") {
    const assistantId = requireArg(args, "assistant_id", ["assistantId"]);
    return { structuredContent: await request(credential, "GET", `/assistants/${encodeURIComponent(assistantId)}`, undefined, tool, { assistantId }) };
  }

  if (tool === "langgraph/get_assistant_schemas") {
    const assistantId = requireArg(args, "assistant_id", ["assistantId"]);
    return { structuredContent: await request(credential, "GET", `/assistants/${encodeURIComponent(assistantId)}/schemas`, undefined, tool, { assistantId }) };
  }

  if (tool === "langgraph/search_threads") {
    return { structuredContent: await request(credential, "POST", "/threads/search", searchBody(args, ["status", "values"]), tool) };
  }

  if (tool === "langgraph/create_thread") {
    return { structuredContent: await request(credential, "POST", "/threads", bodyFrom(args, ["thread_id", "metadata", "if_exists"]), tool) };
  }

  if (tool === "langgraph/get_thread") {
    const threadId = requireArg(args, "thread_id", ["threadId"]);
    return { structuredContent: await request(credential, "GET", `/threads/${encodeURIComponent(threadId)}`, undefined, tool, { threadId }) };
  }

  if (tool === "langgraph/get_thread_state") {
    const threadId = requireArg(args, "thread_id", ["threadId"]);
    const checkpointId = optionalArg(args, "checkpoint_id", ["checkpointId"]);
    const path = checkpointId
      ? `/threads/${encodeURIComponent(threadId)}/state/${encodeURIComponent(checkpointId)}`
      : `/threads/${encodeURIComponent(threadId)}/state`;
    return { structuredContent: await request(credential, "GET", path, undefined, tool, { threadId, checkpointId }) };
  }

  if (tool === "langgraph/get_thread_history") {
    const threadId = requireArg(args, "thread_id", ["threadId"]);
    const body = bodyFrom(args, ["limit", "before", "metadata"]);
    if (body.limit === undefined) body.limit = 10;
    return { structuredContent: await request(credential, "POST", `/threads/${encodeURIComponent(threadId)}/history`, body, tool, { threadId }) };
  }

  if (tool === "langgraph/list_runs") {
    const threadId = requireArg(args, "thread_id", ["threadId"]);
    const params = new URLSearchParams();
    const limit = optionalArg(args, "limit");
    const offset = optionalArg(args, "offset");
    if (limit) params.set("limit", limit);
    if (offset) params.set("offset", offset);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/threads/${encodeURIComponent(threadId)}/runs${qs}`, undefined, tool, { threadId }) };
  }

  if (tool === "langgraph/get_run") {
    const threadId = requireArg(args, "thread_id", ["threadId"]);
    const runId = requireArg(args, "run_id", ["runId"]);
    return { structuredContent: await request(credential, "GET", `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`, undefined, tool, { threadId, runId }) };
  }

  if (tool === "langgraph/create_run" || tool === "langgraph/run_wait") {
    const assistantId = requireArg(args, "assistant_id", ["assistantId", "graph_id", "graphId"]);
    const body: Record<string, unknown> = {
      assistant_id: assistantId,
      ...bodyFrom(args, ["input", "config", "metadata", "webhook", "interrupt_before", "interrupt_after", "multitask_strategy"]),
    };
    const threadId = optionalArg(args, "thread_id", ["threadId"]);
    // A run without a thread is a stateless run: /runs/wait keeps no checkpoint.
    const wait = tool === "langgraph/run_wait";
    const path = threadId
      ? `/threads/${encodeURIComponent(threadId)}/runs${wait ? "/wait" : ""}`
      : `/runs${wait ? "/wait" : ""}`;
    return { structuredContent: await request(credential, "POST", path, body, tool, { assistantId, threadId }) };
  }

  if (tool === "langgraph/cancel_run") {
    const threadId = requireArg(args, "thread_id", ["threadId"]);
    const runId = requireArg(args, "run_id", ["runId"]);
    const params = new URLSearchParams();
    if (args.wait !== undefined) params.set("wait", String(args.wait));
    const action = optionalArg(args, "action");
    if (action) params.set("action", action);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "POST", `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel${qs}`, undefined, tool, { threadId, runId }) };
  }

  if (tool === "langgraph/search_crons") {
    return { structuredContent: await request(credential, "POST", "/runs/crons/search", searchBody(args, ["assistant_id", "thread_id"]), tool) };
  }

  if (tool === "langgraph/delete_cron") {
    const cronId = requireArg(args, "cron_id", ["cronId"]);
    return { structuredContent: await request(credential, "DELETE", `/runs/crons/${encodeURIComponent(cronId)}`, undefined, tool, { cronId }) };
  }

  if (tool === "langgraph/search_store_items") {
    const body = bodyFrom(args, ["namespace_prefix", "filter", "query", "limit", "offset"]);
    if (body.limit === undefined) body.limit = 20;
    return { structuredContent: await request(credential, "POST", "/store/items/search", body, tool) };
  }

  throw new Error(`Unknown LangGraph tool: ${tool}`);
}
