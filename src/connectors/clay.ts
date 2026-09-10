// Clay connector - Clay Public API (https://api.clay.com/public/v0), `clay-api-key` header.
//
// The old `/v1/tables/{id}/rows` and `/v1/people|companies/enrich` paths this
// connector used to call now return 404 `deprecated API endpoint`. Clay's public
// API (GA 2026-07-09) exposes: /me, search (query mode), routines (inline +
// batch), table queries (Enterprise, read-only) and workflow-run queries.
// There is no public write endpoint for table rows; the only supported ingest
// path is a per-table webhook source, which `clay/push_webhook` targets.
const CLAY_API = "https://api.clay.com";
const CLAY_PUBLIC_PREFIX = "/public/v0";
const CLAY_WEBHOOK_PREFIX = "/v3/sources/webhook/";
const CLAY_TIMEOUT_MS = 20_000;

type ClayArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

function headers(apiKey: string) {
  return {
    "clay-api-key": apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchClay(url: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAY_TIMEOUT_MS);
  const started = Date.now();
  const path = url.startsWith(CLAY_API) ? url.slice(CLAY_API.length) : url;
  try {
    console.log("[clay] request", { path, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[clay] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[clay] failed", {
      path,
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
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data as Record<string, unknown>;
  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) return args.body as Record<string, unknown>;
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

function optionalString(args: ClayArgs, key: string) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** Normalise a caller path to a Public API path under /public/v0. */
export function clayPublicPath(rawPath: unknown) {
  let path = String(rawPath ?? "").trim();
  if (!path) throw new Error("path is required");
  if (/^https?:\/\//i.test(path)) throw new Error("path must be a Clay API path, not a full URL");
  if (path.includes("..")) throw new Error("path must not contain ..");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/v0" || path.startsWith("/v0/")) path = `/public${path}`;
  if (path !== CLAY_PUBLIC_PREFIX && !path.startsWith(`${CLAY_PUBLIC_PREFIX}/`)) {
    if (path.startsWith("/v1/") || path.startsWith("/v3/")) {
      throw new Error(`Clay retired ${path.split("/").slice(0, 2).join("/")}/ ("deprecated API endpoint"); use the Public API under ${CLAY_PUBLIC_PREFIX}/ (e.g. /me, /search/query-mode, /tables/query, /routines/{id}/run)`);
    }
    path = `${CLAY_PUBLIC_PREFIX}${path}`;
  }
  return path;
}

function webhookUrl(args: ClayArgs) {
  const raw = String(args.webhook_url ?? args.webhookUrl ?? args.url ?? "").trim();
  if (!raw) throw new Error("webhook_url is required (copy it from the table's Webhook source in Clay)");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("webhook_url must be a full Clay webhook URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.clay.com" || !parsed.pathname.startsWith(CLAY_WEBHOOK_PREFIX)) {
    throw new Error(`webhook_url must be a Clay table webhook source URL (https://api.clay.com${CLAY_WEBHOOK_PREFIX}...)`);
  }
  return parsed.toString();
}

async function requestJson(apiKey: string, method: string, path: string, body: unknown, tool: string, query?: Record<string, string | number | undefined>) {
  const init: RequestInit = { method, headers: headers(apiKey) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && String(value) !== "") qs.set(key, String(value));
  }
  const url = `${CLAY_API}${path}${qs.size ? `?${qs.toString()}` : ""}`;
  const r = await fetchClay(url, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) {
    const message = typeof j?.message === "string" ? j.message : JSON.stringify(j).slice(0, 600);
    let hint = "";
    if (r.status === 401 || r.status === 403) hint = " (Clay Public API keys come from Settings > Account > API keys (beta); the legacy workspace API key is not accepted.)";
    else if (r.status === 402) hint = " (plan search/result budget exhausted; wait for the reset or ask Clay to raise the limit.)";
    else if (r.status === 429) hint = ` (rate limited; retry after ${r.headers.get("retry-after") ?? "a few"} seconds.)`;
    else if (r.status === 404 && path.startsWith(`${CLAY_PUBLIC_PREFIX}/tables/`)) hint = " (table queries are Enterprise-only and need a table id from the Clay URL.)";
    throw new Error(`Clay ${tool} failed: ${r.status} ${message}${hint}`);
  }
  return { status: r.status, body: j };
}

function itemsArg(args: ClayArgs) {
  const items = args.items;
  if (!Array.isArray(items) || !items.length) throw new Error("items must be a non-empty array of { id, inputs }");
  if (items.length > 100) throw new Error("items is limited to 100 per run; use the run-batch endpoints via clay/raw_request for larger inputs");
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`items[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? index + 1).trim();
    if (!id) throw new Error(`items[${index}].id is required`);
    const inputs = record.inputs && typeof record.inputs === "object" && !Array.isArray(record.inputs) ? record.inputs : null;
    if (!inputs) throw new Error(`items[${index}].inputs must be an object`);
    return { id: id.slice(0, 64), inputs };
  });
}

function splitMarkdownSections(markdown: string) {
  const sections: Array<{ heading: string; text: string }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      if (current) sections.push({ heading: current.heading, text: current.lines.join("\n") });
      current = { heading: line.replace(/^#+\s*/, "").trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, text: current.lines.join("\n") });
  return sections;
}

function spread(body: unknown, fallbackKey: string) {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : { [fallbackKey]: body };
}

export async function callClayTool(tool: string, args: ClayArgs, apiKey: string) {
  if (tool === "clay/raw_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("method must be GET, POST, PUT, PATCH, or DELETE");
    const body = method === "GET" || method === "DELETE" ? undefined : (args.data ?? args.body ?? {});
    const query = args.query && typeof args.query === "object" && !Array.isArray(args.query) ? (args.query as Record<string, string | number>) : undefined;
    const result = await requestJson(apiKey, method, clayPublicPath(args.path), body, tool, query);
    return { structuredContent: result.body };
  }

  if (tool === "clay/me") {
    const result = await requestJson(apiKey, "GET", `${CLAY_PUBLIC_PREFIX}/me`, undefined, tool);
    return { structuredContent: result.body };
  }

  if (tool === "clay/search_reference") {
    const result = await requestJson(apiKey, "GET", `${CLAY_PUBLIC_PREFIX}/search/query-mode/reference`, undefined, tool);
    const reference = typeof (result.body as any)?.reference === "string" ? String((result.body as any).reference) : "";
    // Clay returns the whole query grammar as one markdown blob (~173k chars on
    // 2026-09-10), which is far past what a tool result can carry. Return the
    // heading index by default and let callers pull one section at a time.
    if (!reference) return { structuredContent: result.body };
    const sections = splitMarkdownSections(reference);
    const wanted = optionalString(args, "section");
    const maxChars = boundedInteger(args.max_chars, 12_000, 500, 100_000);
    if (wanted) {
      const needle = wanted.toLowerCase();
      const hits = sections.filter((s) => s.heading.toLowerCase().includes(needle));
      if (!hits.length) {
        throw new Error(`no reference section matches ${JSON.stringify(wanted)}; call clay/search_reference without a section to list the ${sections.length} headings`);
      }
      const text = hits.map((s) => s.text).join("\n\n");
      return {
        structuredContent: {
          sections: hits.map((s) => s.heading),
          total_chars: reference.length,
          chars: Math.min(text.length, maxChars),
          truncated: text.length > maxChars,
          reference: text.slice(0, maxChars),
        },
      };
    }
    return {
      structuredContent: {
        sections: sections.map((s) => s.heading),
        total_chars: reference.length,
        chars: Math.min(reference.length, maxChars),
        truncated: reference.length > maxChars,
        note: `Full reference is ${reference.length} chars. Pass section="<heading substring>" (e.g. "People fields") to read one part, or raise max_chars.`,
        reference: reference.slice(0, maxChars),
      },
    };
  }

  if (tool === "clay/search") {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required (Clay search query; fetch clay/search_reference for the syntax)");
    const limit = boundedInteger(args.limit, 20, 1, 500);
    const created = await requestJson(apiKey, "POST", `${CLAY_PUBLIC_PREFIX}/search/query-mode`, { query }, tool);
    const searchId = String(created.body?.search_id ?? "").trim();
    if (!searchId) throw new Error(`Clay ${tool} failed: no search_id in response ${JSON.stringify(created.body).slice(0, 300)}`);
    const page = await requestJson(apiKey, "POST", `${CLAY_PUBLIC_PREFIX}/search/query-mode/${encodeURIComponent(searchId)}/run`, { limit }, tool);
    return { structuredContent: { search_id: searchId, source_type: created.body?.source_type, ...spread(page.body, "page") } };
  }

  if (tool === "clay/search_next") {
    const searchId = idArg(args, "search_id");
    const limit = boundedInteger(args.limit, 20, 1, 500);
    const page = await requestJson(apiKey, "POST", `${CLAY_PUBLIC_PREFIX}/search/query-mode/${encodeURIComponent(searchId)}/run`, { limit }, tool);
    return { structuredContent: { search_id: searchId, ...spread(page.body, "page") } };
  }

  if (tool === "clay/query_tables") {
    let query: unknown = args.query;
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      const tableId = optionalString(args, "table_id") ?? optionalString(args, "tableId");
      if (!tableId) throw new Error("query (structured table query) or table_id is required");
      const structured: Record<string, unknown> = { tables: [{ id: tableId }], field_mode: args.field_mode ?? "names" };
      if (Array.isArray(args.select)) structured.select = args.select;
      if (args.filter && typeof args.filter === "object") structured.filter = args.filter;
      if (Array.isArray(args.order_by)) structured.order_by = args.order_by;
      query = structured;
    }
    const body: Record<string, unknown> = { query, limit: boundedInteger(args.limit, 50, 1, 100) };
    const cursor = optionalString(args, "cursor");
    if (cursor) body.cursor = cursor;
    const result = await requestJson(apiKey, "POST", `${CLAY_PUBLIC_PREFIX}/tables/query`, body, tool);
    return { structuredContent: result.body };
  }

  if (tool === "clay/run_routine") {
    const routineId = idArg(args, "routine_id");
    const body: Record<string, unknown> = { items: itemsArg(args) };
    const webhookId = optionalString(args, "webhook_id");
    if (webhookId) body.webhook_id = webhookId;
    const result = await requestJson(apiKey, "POST", `${CLAY_PUBLIC_PREFIX}/routines/${encodeURIComponent(routineId)}/run`, body, tool);
    return { structuredContent: result.body };
  }

  if (tool === "clay/get_routine_run") {
    const runId = idArg(args, "routine_run_id", ["run_id"]);
    const batch = args.batch === true || args.batch === "true";
    const path = batch
      ? `${CLAY_PUBLIC_PREFIX}/routines/run-batch/${encodeURIComponent(runId)}/results`
      : `${CLAY_PUBLIC_PREFIX}/routines/run/${encodeURIComponent(runId)}/results`;
    const result = await requestJson(apiKey, "GET", path, undefined, tool, {
      cursor: optionalString(args, "cursor"),
      limit: args.limit === undefined ? undefined : boundedInteger(args.limit, 100, 1, 1000),
    });
    return { structuredContent: { http_status: result.status, in_progress: result.status === 202, ...spread(result.body, "body") } };
  }

  if (tool === "clay/query_workflow_runs") {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required (GET /workflows/runs/query/reference via clay/raw_request for the syntax)");
    const body: Record<string, unknown> = { query, limit: boundedInteger(args.limit, 50, 1, 100) };
    const cursor = optionalString(args, "cursor");
    if (cursor) body.cursor = cursor;
    const result = await requestJson(apiKey, "POST", `${CLAY_PUBLIC_PREFIX}/workflows/runs/query`, body, tool);
    return { structuredContent: result.body };
  }

  if (tool === "clay/push_webhook") {
    const url = webhookUrl(args);
    const rows = Array.isArray(args.rows) ? args.rows : [bodyFromArgs(args)];
    if (!rows.length) throw new Error("rows must contain at least one object");
    const results: Array<{ index: number; status: number; body: unknown }> = [];
    for (const [index, row] of rows.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`rows[${index}] must be an object`);
      const r = await fetchClay(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(row) }, { tool, index });
      const body = await readJsonResponse(r);
      if (!r.ok) throw new Error(`Clay ${tool} failed on rows[${index}]: ${r.status} ${JSON.stringify(body).slice(0, 600)}`);
      results.push({ index, status: r.status, body });
    }
    return { structuredContent: { sent: results.length, results } };
  }

  throw new Error(`Unknown Clay tool: ${tool}`);
}
