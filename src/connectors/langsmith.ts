// LangSmith connector - API key via the X-Api-Key header.
// Targets the LangSmith REST API (/api/v1). US cloud is the default host; the EU
// region and self-hosted installations pass base_url in the credential.
// Docs: https://api.smith.langchain.com/redoc
const LANGSMITH_DEFAULT_BASE = "https://api.smith.langchain.com";
const LANGSMITH_TIMEOUT_MS = 20_000;

type LangsmithArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let apiKey = credential.trim();
  let baseUrl = LANGSMITH_DEFAULT_BASE;
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? parsed.api_token ?? "").trim();
      const url = String(parsed.base_url ?? parsed.baseUrl ?? "").trim();
      if (url) baseUrl = url.replace(/\/+$/, "");
    }
  } catch {
    // plain API key credential
  }
  if (!apiKey) throw new Error("LangSmith credential requires an api_key");
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

async function fetchLangsmith(baseUrl: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LANGSMITH_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[langsmith] request", { path, ...logContext });
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    console.log("[langsmith] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[langsmith] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${LANGSMITH_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`LangSmith request timed out after ${LANGSMITH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const { apiKey, baseUrl } = parseCredential(credential);
  const headers: Record<string, string> = {
    "X-Api-Key": apiKey,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchLangsmith(baseUrl, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`LangSmith ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: LangsmithArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: LangsmithArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

function queryString(args: LangsmithArgs, keys: Array<[string, string, string[]?]>) {
  const params = new URLSearchParams();
  for (const [argKey, paramKey, aliases] of keys) {
    const value = optionalArg(args, argKey, aliases ?? []);
    if (value) params.set(paramKey, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Copies the args the caller supplied into a POST body, skipping grantry's own routing key. */
function bodyFrom(args: LangsmithArgs, keys: string[]) {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = args[key] ?? args[camel];
    if (value !== undefined && value !== null && value !== "") body[key] = value;
  }
  return body;
}

export async function callLangsmithTool(tool: string, args: LangsmithArgs, credential: string) {
  if (tool === "langsmith/list_workspaces") {
    return { structuredContent: await request(credential, "GET", "/api/v1/workspaces", undefined, tool) };
  }

  if (tool === "langsmith/list_projects") {
    const qs = queryString(args, [
      ["name", "name"],
      ["name_contains", "name_contains"],
      ["limit", "limit"],
      ["offset", "offset"],
    ]);
    return { structuredContent: await request(credential, "GET", `/api/v1/sessions${qs}`, undefined, tool) };
  }

  if (tool === "langsmith/get_project") {
    const sessionId = requireArg(args, "project_id", ["projectId", "session_id", "sessionId"]);
    return { structuredContent: await request(credential, "GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`, undefined, tool, { sessionId }) };
  }

  if (tool === "langsmith/query_runs") {
    // POST body query API: filters use LangSmith's filter DSL, e.g. eq(run_type, "llm").
    const body = bodyFrom(args, [
      "session",
      "filter",
      "trace_filter",
      "tree_filter",
      "run_type",
      "is_root",
      "trace",
      "parent_run",
      "start_time",
      "end_time",
      "error",
      "select",
      "order",
      "limit",
      "cursor",
    ]);
    if (body.session !== undefined && !Array.isArray(body.session)) body.session = [body.session];
    if (body.limit === undefined) body.limit = 20;
    return { structuredContent: await request(credential, "POST", "/api/v1/runs/query", body, tool) };
  }

  if (tool === "langsmith/get_run") {
    const runId = requireArg(args, "run_id", ["runId", "id"]);
    return { structuredContent: await request(credential, "GET", `/api/v1/runs/${encodeURIComponent(runId)}`, undefined, tool, { runId }) };
  }

  if (tool === "langsmith/list_datasets") {
    const qs = queryString(args, [
      ["name", "name"],
      ["name_contains", "name_contains"],
      ["data_type", "data_type"],
      ["limit", "limit"],
      ["offset", "offset"],
    ]);
    return { structuredContent: await request(credential, "GET", `/api/v1/datasets${qs}`, undefined, tool) };
  }

  if (tool === "langsmith/get_dataset") {
    const datasetId = requireArg(args, "dataset_id", ["datasetId"]);
    return { structuredContent: await request(credential, "GET", `/api/v1/datasets/${encodeURIComponent(datasetId)}`, undefined, tool, { datasetId }) };
  }

  if (tool === "langsmith/list_examples") {
    const datasetId = requireArg(args, "dataset_id", ["datasetId", "dataset"]);
    const qs = queryString(args, [
      ["limit", "limit"],
      ["offset", "offset"],
      ["splits", "splits"],
      ["full_text_contains", "full_text_contains"],
      ["filter", "filter"],
    ]);
    const sep = qs ? "&" : "?";
    return { structuredContent: await request(credential, "GET", `/api/v1/examples${qs}${sep}dataset=${encodeURIComponent(datasetId)}`, undefined, tool, { datasetId }) };
  }

  if (tool === "langsmith/create_examples") {
    const datasetId = requireArg(args, "dataset_id", ["datasetId", "dataset"]);
    const rows = Array.isArray(args.examples)
      ? (args.examples as Array<Record<string, unknown>>)
      : args.inputs && typeof args.inputs === "object"
        ? [{ inputs: args.inputs, outputs: args.outputs, metadata: args.metadata }]
        : null;
    if (!rows) throw new Error("either examples (array) or inputs (object) is required");
    const body = rows.map((row) => ({ dataset_id: datasetId, ...row }));
    return { structuredContent: await request(credential, "POST", "/api/v1/examples/bulk", body, tool, { datasetId }) };
  }

  if (tool === "langsmith/list_feedback") {
    const qs = queryString(args, [
      ["run_id", "run", ["run", "runId"]],
      ["project_id", "session", ["session", "sessionId", "session_id"]],
      ["key", "key"],
      ["limit", "limit"],
      ["offset", "offset"],
    ]);
    return { structuredContent: await request(credential, "GET", `/api/v1/feedback${qs}`, undefined, tool) };
  }

  if (tool === "langsmith/create_feedback") {
    const runId = requireArg(args, "run_id", ["runId"]);
    const key = requireArg(args, "key");
    const body: Record<string, unknown> = { run_id: runId, key };
    if (args.score !== undefined) body.score = args.score;
    if (args.value !== undefined) body.value = args.value;
    const comment = optionalArg(args, "comment");
    if (comment) body.comment = comment;
    return { structuredContent: await request(credential, "POST", "/api/v1/feedback", body, tool, { runId, key }) };
  }

  if (tool === "langsmith/list_prompts") {
    const qs = queryString(args, [
      ["query", "query"],
      ["limit", "limit"],
      ["offset", "offset"],
      ["is_public", "is_public"],
    ]);
    return { structuredContent: await request(credential, "GET", `/api/v1/repos${qs}`, undefined, tool) };
  }

  if (tool === "langsmith/get_prompt") {
    const owner = requireArg(args, "owner");
    const repo = requireArg(args, "repo", ["prompt", "name"]);
    const qs = queryString(args, [["with_latest_manifest", "with_latest_manifest"]]);
    return { structuredContent: await request(credential, "GET", `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${qs}`, undefined, tool, { owner, repo }) };
  }

  throw new Error(`Unknown LangSmith tool: ${tool}`);
}
