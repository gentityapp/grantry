// Monid connector - API key via Authorization: Bearer (monid_live_...).
// Monid is a pay-per-use data access gateway: discover -> inspect -> run
// against hundreds of third-party data endpoints. Targets https://api.monid.ai/v1/*.
// Cloud only; base_url is optional and defaults to the cloud host.
const MONID_DEFAULT_BASE = "https://api.monid.ai";
const MONID_TIMEOUT_MS = 30_000;

type MonidArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let apiKey = credential.trim();
  let baseUrl = MONID_DEFAULT_BASE;
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
      const url = String(parsed.base_url ?? parsed.baseUrl ?? "").trim();
      if (url) baseUrl = url.replace(/\/+$/, "");
    }
  } catch {
    // plain API key credential
  }
  if (!apiKey) throw new Error("Monid credential requires an api_key");
  return { apiKey, baseUrl };
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

async function fetchMonid(baseUrl: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MONID_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[monid] request", { path, ...logContext });
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    console.log("[monid] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[monid] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${MONID_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Monid request timed out after ${MONID_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  credential: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  args: MonidArgs = {},
  logContext: Record<string, unknown> = {},
) {
  const { apiKey, baseUrl } = parseCredential(credential);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  // x-workspace-id is only needed for OAuth/JWT tokens without workspace context,
  // but pass it through when supplied so a key scoped to multiple workspaces works.
  const workspaceId = String(args.workspace_id ?? args.workspaceId ?? "").trim();
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchMonid(baseUrl, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Monid ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: MonidArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

export async function callMonidTool(tool: string, args: MonidArgs, credential: string) {
  if (tool === "monid/whoami") {
    return { structuredContent: await request(credential, "GET", "/v1/auth/whoami", undefined, tool, args) };
  }

  if (tool === "monid/list_workspaces") {
    return { structuredContent: await request(credential, "GET", "/v1/auth/workspaces", undefined, tool, args) };
  }

  if (tool === "monid/discover") {
    const query = requireArg(args, "query", ["q"]);
    const body: Record<string, unknown> = { query };
    const limit = Number(args.limit ?? 0);
    if (limit > 0) body.limit = limit;
    return { structuredContent: await request(credential, "POST", "/v1/discover", body, tool, args) };
  }

  if (tool === "monid/inspect") {
    const provider = requireArg(args, "provider");
    const endpoint = requireArg(args, "endpoint");
    return { structuredContent: await request(credential, "POST", "/v1/inspect", { provider, endpoint }, tool, args, { provider, endpoint }) };
  }

  if (tool === "monid/run") {
    const provider = requireArg(args, "provider");
    const endpoint = requireArg(args, "endpoint");
    const input = args.input;
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
      throw new Error("input must be an object of endpoint parameters");
    }
    const body: Record<string, unknown> = { provider, endpoint };
    if (input !== undefined) body.input = input;
    return { structuredContent: await request(credential, "POST", "/v1/run", body, tool, args, { provider, endpoint }) };
  }

  if (tool === "monid/list_runs") {
    const params = new URLSearchParams();
    const limit = Number(args.limit ?? 0);
    if (limit > 0) params.set("limit", String(limit));
    const status = String(args.status ?? "").trim();
    if (status) params.set("status", status);
    const cursor = String(args.cursor ?? args.starting_after ?? "").trim();
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/v1/runs${qs}`, undefined, tool, args) };
  }

  if (tool === "monid/get_run") {
    const runId = requireArg(args, "run_id", ["runId", "id"]);
    return { structuredContent: await request(credential, "GET", `/v1/runs/${encodeURIComponent(runId)}`, undefined, tool, args, { runId }) };
  }

  if (tool === "monid/stop_run") {
    const runId = requireArg(args, "run_id", ["runId", "id"]);
    return { structuredContent: await request(credential, "POST", `/v1/runs/${encodeURIComponent(runId)}/stop`, {}, tool, args, { runId }) };
  }

  if (tool === "monid/get_balance") {
    return { structuredContent: await request(credential, "GET", "/v1/wallet/balance", undefined, tool, args) };
  }

  if (tool === "monid/list_activities") {
    const params = new URLSearchParams();
    const limit = Number(args.limit ?? 0);
    if (limit > 0) params.set("limit", String(limit));
    const cursor = String(args.cursor ?? args.starting_after ?? "").trim();
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/v1/wallet/activities${qs}`, undefined, tool, args) };
  }

  throw new Error(`Unknown Monid tool: ${tool}`);
}
