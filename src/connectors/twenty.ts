// Twenty CRM connector - API key via Authorization: Bearer.
// Targets the Twenty Core REST API (/rest/*). Cloud default is
// https://api.twenty.com; self-hosted instances pass base_url in the credential.
const TWENTY_DEFAULT_BASE = "https://api.twenty.com";
const TWENTY_TIMEOUT_MS = 12_000;

type TwentyArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let apiKey = credential.trim();
  let baseUrl = TWENTY_DEFAULT_BASE;
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
  if (!apiKey) throw new Error("Twenty credential requires an api_key");
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

async function fetchTwenty(baseUrl: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWENTY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[twenty] request", { path, ...logContext });
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    console.log("[twenty] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[twenty] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${TWENTY_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Twenty request timed out after ${TWENTY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const { apiKey, baseUrl } = parseCredential(credential);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchTwenty(baseUrl, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Twenty ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

// Object names are workspace-defined (plural camelCase like "people",
// "companies", "opportunities", or custom objects), so validate shape only.
function objectArg(args: TwentyArgs) {
  const value = String(args.object ?? args.object_name ?? args.objectName ?? "").trim();
  if (!value) throw new Error("object is required (plural object name, e.g. people, companies, opportunities)");
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error("object must be a plain object name (letters, digits, underscore)");
  return value;
}

function idArg(args: TwentyArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

export async function callTwentyTool(tool: string, args: TwentyArgs, credential: string) {
  if (tool === "twenty/list_objects") {
    return { structuredContent: await request(credential, "GET", "/rest/metadata/objects", undefined, tool) };
  }

  if (tool === "twenty/list_records") {
    const object = objectArg(args);
    const params = new URLSearchParams();
    const filter = String(args.filter ?? "").trim();
    if (filter) params.set("filter", filter);
    const orderBy = String(args.order_by ?? args.orderBy ?? "").trim();
    if (orderBy) params.set("order_by", orderBy);
    const limit = Number(args.limit ?? 0);
    if (limit > 0) params.set("limit", String(Math.min(limit, 60)));
    const startingAfter = String(args.starting_after ?? args.startingAfter ?? "").trim();
    if (startingAfter) params.set("starting_after", startingAfter);
    const depth = args.depth;
    if (depth !== undefined && depth !== null && String(depth).trim() !== "") params.set("depth", String(depth));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/rest/${object}${qs}`, undefined, tool, { object }) };
  }

  if (tool === "twenty/get_record") {
    const object = objectArg(args);
    const recordId = idArg(args, "record_id", ["recordId", "id"]);
    return { structuredContent: await request(credential, "GET", `/rest/${object}/${encodeURIComponent(recordId)}`, undefined, tool, { object, recordId }) };
  }

  if (tool === "twenty/create_record") {
    const object = objectArg(args);
    const data = args.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data (object of field values) is required");
    return { structuredContent: await request(credential, "POST", `/rest/${object}`, data, tool, { object }) };
  }

  if (tool === "twenty/update_record") {
    const object = objectArg(args);
    const recordId = idArg(args, "record_id", ["recordId", "id"]);
    const data = args.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data (object of field values) is required");
    return { structuredContent: await request(credential, "PATCH", `/rest/${object}/${encodeURIComponent(recordId)}`, data, tool, { object, recordId }) };
  }

  throw new Error(`Unknown Twenty tool: ${tool}`);
}
