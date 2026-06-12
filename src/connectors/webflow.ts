// Webflow connector - Bearer token authentication (Webflow API v2).
const WEBFLOW_API = "https://api.webflow.com/v2";
const WEBFLOW_TIMEOUT_MS = 12_000;

type WebflowArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(token: string, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchWebflow(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBFLOW_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[webflow] request", { path, ...logContext });
    const response = await fetch(`${WEBFLOW_API}${path}`, { ...init, signal: controller.signal });
    console.log("[webflow] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[webflow] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${WEBFLOW_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Webflow request timed out after ${WEBFLOW_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: WebflowArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: WebflowArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(token: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(token, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchWebflow(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Webflow ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callWebflowTool(tool: string, args: WebflowArgs, credential: string) {
  if (tool === "webflow/list_sites") {
    return { structuredContent: await request(credential, "GET", "/sites", undefined, tool) };
  }

  if (tool === "webflow/get_site") {
    const siteId = idArg(args, "site_id");
    return { structuredContent: await request(credential, "GET", `/sites/${encodeURIComponent(siteId)}`, undefined, tool, { siteId }) };
  }

  if (tool === "webflow/list_collections") {
    const siteId = idArg(args, "site_id");
    return { structuredContent: await request(credential, "GET", `/sites/${encodeURIComponent(siteId)}/collections`, undefined, tool, { siteId }) };
  }

  if (tool === "webflow/list_items") {
    const collectionId = idArg(args, "collection_id");
    const qs = queryString(args, ["limit", "offset"]);
    return { structuredContent: await request(credential, "GET", `/collections/${encodeURIComponent(collectionId)}/items${qs}`, undefined, tool, { collectionId }) };
  }

  if (tool === "webflow/create_item") {
    const collectionId = idArg(args, "collection_id");
    // Accept field_data or fieldData
    const fieldData = args.field_data ?? args.fieldData;
    if (!fieldData || typeof fieldData !== "object" || Array.isArray(fieldData)) {
      throw new Error("field_data is required and must be an object");
    }
    const body = { fieldData };
    return { structuredContent: await request(credential, "POST", `/collections/${encodeURIComponent(collectionId)}/items`, body, tool, { collectionId }) };
  }

  if (tool === "webflow/publish_site") {
    const siteId = idArg(args, "site_id");
    const body = { publishToWebflowSubdomain: true };
    return { structuredContent: await request(credential, "POST", `/sites/${encodeURIComponent(siteId)}/publish`, body, tool, { siteId }) };
  }

  throw new Error(`Unknown Webflow tool: ${tool}`);
}
