// Clay connector - API key authentication.
const CLAY_API = "https://api.clay.com";
const CLAY_TIMEOUT_MS = 12_000;

type ClayArgs = Record<string, unknown>;

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
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchClay(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[clay] request", { path: normalizedPath, ...logContext });
    const response = await fetch(`${CLAY_API}${normalizedPath}`, { ...init, signal: controller.signal });
    console.log("[clay] response", { path: normalizedPath, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[clay] failed", {
      path: normalizedPath,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CLAY_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Clay request timed out after ${CLAY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function bodyFromArgs(args: ClayArgs, fallbackKeys: string[] = []) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data;
  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) return args.body;
  const body: Record<string, unknown> = {};
  for (const key of fallbackKeys) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  if (!Object.keys(body).length) throw new Error(`data object or one of ${fallbackKeys.join(", ")} is required`);
  return body;
}

function idArg(args: ClayArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function rawPath(args: ClayArgs) {
  const path = String(args.path ?? "").trim();
  if (!path) throw new Error("path is required");
  if (/^https?:\/\//i.test(path)) throw new Error("path must be a Clay API path, not a full URL");
  if (path.includes("..")) throw new Error("path must not contain ..");
  return path.startsWith("/") ? path : `/${path}`;
}

async function requestJson(apiKey: string, method: string, path: string, body: unknown, tool: string) {
  const init: RequestInit = { method, headers: headers(apiKey) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchClay(path, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Clay ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callClayTool(tool: string, args: ClayArgs, apiKey: string) {
  if (tool === "clay/raw_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("method must be GET, POST, PUT, PATCH, or DELETE");
    const body = method === "GET" || method === "DELETE" ? undefined : (args.data ?? args.body ?? {});
    return { structuredContent: await requestJson(apiKey, method, rawPath(args), body, tool) };
  }

  if (tool === "clay/lookup_row") {
    const tableId = idArg(args, "table_id");
    const body = bodyFromArgs(args, ["column", "value", "limit"]);
    return { structuredContent: await requestJson(apiKey, "POST", `/v1/tables/${encodeURIComponent(tableId)}/rows/lookup`, body, tool) };
  }

  if (tool === "clay/create_row") {
    const tableId = idArg(args, "table_id");
    return { structuredContent: await requestJson(apiKey, "POST", `/v1/tables/${encodeURIComponent(tableId)}/rows`, bodyFromArgs(args), tool) };
  }

  if (tool === "clay/update_row") {
    const tableId = idArg(args, "table_id");
    const rowId = idArg(args, "row_id");
    return { structuredContent: await requestJson(apiKey, "PATCH", `/v1/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`, bodyFromArgs(args), tool) };
  }

  if (tool === "clay/enrich_person") {
    return { structuredContent: await requestJson(apiKey, "POST", "/v1/people/enrich", bodyFromArgs(args), tool) };
  }

  if (tool === "clay/enrich_company") {
    return { structuredContent: await requestJson(apiKey, "POST", "/v1/companies/enrich", bodyFromArgs(args), tool) };
  }

  throw new Error(`Unknown Clay tool: ${tool}`);
}
