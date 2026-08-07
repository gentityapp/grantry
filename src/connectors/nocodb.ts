// NocoDB connector - API token via the xc-token header.
// Targets the NocoDB v2 API (meta + data endpoints). Cloud default is
// https://app.nocodb.com; self-hosted instances pass base_url in the credential.
// Docs: https://docs.nocodb.com/automation/webhook/actions-on-webhook (API reference under /api/v2)
const NOCODB_DEFAULT_BASE = "https://app.nocodb.com";
const NOCODB_TIMEOUT_MS = 15_000;

type NocodbArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let apiToken = credential.trim();
  let baseUrl = NOCODB_DEFAULT_BASE;
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      apiToken = String(
        parsed.api_token ?? parsed.apiToken ?? parsed.token ?? parsed.api_key ?? parsed.apiKey ?? "",
      ).trim();
      const url = String(parsed.base_url ?? parsed.baseUrl ?? "").trim();
      if (url) baseUrl = url.replace(/\/+$/, "");
    }
  } catch {
    // plain API token credential
  }
  if (!apiToken) throw new Error("NocoDB credential requires an api_token");
  return { apiToken, baseUrl };
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

async function fetchNocodb(baseUrl: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOCODB_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[nocodb] request", { path, ...logContext });
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    console.log("[nocodb] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[nocodb] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${NOCODB_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`NocoDB request timed out after ${NOCODB_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const { apiToken, baseUrl } = parseCredential(credential);
  const headers: Record<string, string> = {
    "xc-token": apiToken,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchNocodb(baseUrl, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`NocoDB ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: NocodbArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: NocodbArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

function queryString(args: NocodbArgs, keys: Array<[string, string, string[]?]>) {
  const params = new URLSearchParams();
  for (const [argKey, paramKey, aliases] of keys) {
    const value = optionalArg(args, argKey, aliases ?? []);
    if (value) params.set(paramKey, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

const RECORD_QUERY_KEYS: Array<[string, string, string[]?]> = [
  ["view_id", "viewId", ["viewId"]],
  ["fields", "fields"],
  ["sort", "sort"],
  ["where", "where"],
  ["limit", "limit"],
  ["offset", "offset"],
];

export async function callNocodbTool(tool: string, args: NocodbArgs, credential: string) {
  if (tool === "nocodb/get_me") {
    return { structuredContent: await request(credential, "GET", "/api/v1/auth/user/me", undefined, tool) };
  }

  if (tool === "nocodb/list_bases") {
    const workspaceId = optionalArg(args, "workspace_id", ["workspaceId"]);
    const path = workspaceId
      ? `/api/v2/meta/workspaces/${encodeURIComponent(workspaceId)}/bases`
      : "/api/v2/meta/bases/";
    return { structuredContent: await request(credential, "GET", path, undefined, tool, { workspaceId }) };
  }

  if (tool === "nocodb/list_tables") {
    const baseId = requireArg(args, "base_id", ["baseId", "projectId", "project_id"]);
    return { structuredContent: await request(credential, "GET", `/api/v2/meta/bases/${encodeURIComponent(baseId)}/tables`, undefined, tool, { baseId }) };
  }

  if (tool === "nocodb/get_table") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    return { structuredContent: await request(credential, "GET", `/api/v2/meta/tables/${encodeURIComponent(tableId)}`, undefined, tool, { tableId }) };
  }

  if (tool === "nocodb/list_views") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    return { structuredContent: await request(credential, "GET", `/api/v2/meta/tables/${encodeURIComponent(tableId)}/views`, undefined, tool, { tableId }) };
  }

  if (tool === "nocodb/list_records") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    const qs = queryString(args, RECORD_QUERY_KEYS);
    return { structuredContent: await request(credential, "GET", `/api/v2/tables/${encodeURIComponent(tableId)}/records${qs}`, undefined, tool, { tableId }) };
  }

  if (tool === "nocodb/count_records") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    const qs = queryString(args, [
      ["view_id", "viewId", ["viewId"]],
      ["where", "where"],
    ]);
    return { structuredContent: await request(credential, "GET", `/api/v2/tables/${encodeURIComponent(tableId)}/records/count${qs}`, undefined, tool, { tableId }) };
  }

  if (tool === "nocodb/get_record") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    const recordId = requireArg(args, "record_id", ["recordId", "id", "Id"]);
    const qs = queryString(args, [["fields", "fields"]]);
    return { structuredContent: await request(credential, "GET", `/api/v2/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}${qs}`, undefined, tool, { tableId, recordId }) };
  }

  if (tool === "nocodb/create_records") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    let body: unknown;
    if (Array.isArray(args.records)) {
      body = args.records;
    } else if (args.fields && typeof args.fields === "object") {
      body = [args.fields];
    } else {
      throw new Error("either records (array of field objects) or fields (object) is required");
    }
    return { structuredContent: await request(credential, "POST", `/api/v2/tables/${encodeURIComponent(tableId)}/records`, body, tool, { tableId }) };
  }

  if (tool === "nocodb/update_records") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    let body: unknown;
    if (Array.isArray(args.records)) {
      // Each record must carry its primary key (Id) alongside the fields to change.
      body = args.records;
    } else if (args.fields && typeof args.fields === "object") {
      const recordId = requireArg(args, "record_id", ["recordId", "id", "Id"]);
      body = [{ Id: recordId, ...(args.fields as Record<string, unknown>) }];
    } else {
      throw new Error("either records (array including Id per row) or record_id + fields is required");
    }
    return { structuredContent: await request(credential, "PATCH", `/api/v2/tables/${encodeURIComponent(tableId)}/records`, body, tool, { tableId }) };
  }

  if (tool === "nocodb/delete_records") {
    const tableId = requireArg(args, "table_id", ["tableId"]);
    let body: unknown;
    if (Array.isArray(args.records)) {
      body = args.records;
    } else {
      const recordId = requireArg(args, "record_id", ["recordId", "id", "Id"]);
      body = [{ Id: recordId }];
    }
    return { structuredContent: await request(credential, "DELETE", `/api/v2/tables/${encodeURIComponent(tableId)}/records`, body, tool, { tableId }) };
  }

  throw new Error(`Unknown NocoDB tool: ${tool}`);
}
