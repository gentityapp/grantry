// Firecrawl connector - API key via Authorization: Bearer (fc-...).
// REST API v2 (https://api.firecrawl.dev/v2). API keys are issued in the
// Firecrawl dashboard (https://www.firecrawl.dev/app/api-keys).
// Covers scrape, crawl (start/status/cancel), map, search, extract
// (start/status), and team credit usage.
// Docs: https://docs.firecrawl.dev/api-reference/introduction
const FIRECRAWL_API = "https://api.firecrawl.dev";
const FIRECRAWL_TIMEOUT_MS = 60_000;

type FirecrawlArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let apiKey = credential.trim();
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
    }
  } catch {
    // plain API key credential
  }
  if (!apiKey) throw new Error("Firecrawl credential requires an api_key");
  return apiKey;
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

async function fetchFirecrawl(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[firecrawl] request", { path, ...logContext });
    const response = await fetch(`${FIRECRAWL_API}${path}`, { ...init, signal: controller.signal });
    console.log("[firecrawl] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[firecrawl] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${FIRECRAWL_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Firecrawl request timed out after ${FIRECRAWL_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${parseCredential(credential)}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchFirecrawl(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Firecrawl ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: FirecrawlArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: FirecrawlArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

// Merge a caller-supplied `options` object into the request body. Explicit
// top-level args (url, query, ...) win over the same key inside options.
function withOptions(args: FirecrawlArgs, base: Record<string, unknown>) {
  const options = args.options;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    return { ...options, ...base };
  }
  return base;
}

export async function callFirecrawlTool(tool: string, args: FirecrawlArgs, credential: string) {
  if (tool === "firecrawl/scrape") {
    const url = requireArg(args, "url");
    const body: Record<string, unknown> = { url };
    if (Array.isArray(args.formats)) body.formats = args.formats;
    return { structuredContent: await request(credential, "POST", "/v2/scrape", withOptions(args, body), tool) };
  }

  if (tool === "firecrawl/crawl") {
    const url = requireArg(args, "url");
    const body: Record<string, unknown> = { url };
    const limit = Number(args.limit ?? 0);
    if (limit > 0) body.limit = limit;
    return { structuredContent: await request(credential, "POST", "/v2/crawl", withOptions(args, body), tool) };
  }

  if (tool === "firecrawl/get_crawl_status") {
    const crawlId = requireArg(args, "crawl_id", ["crawlId", "id"]);
    return { structuredContent: await request(credential, "GET", `/v2/crawl/${encodeURIComponent(crawlId)}`, undefined, tool, { crawlId }) };
  }

  if (tool === "firecrawl/cancel_crawl") {
    const crawlId = requireArg(args, "crawl_id", ["crawlId", "id"]);
    return { structuredContent: await request(credential, "DELETE", `/v2/crawl/${encodeURIComponent(crawlId)}`, undefined, tool, { crawlId }) };
  }

  if (tool === "firecrawl/map") {
    const url = requireArg(args, "url");
    return { structuredContent: await request(credential, "POST", "/v2/map", withOptions(args, { url }), tool) };
  }

  if (tool === "firecrawl/search") {
    const query = requireArg(args, "query", ["q"]);
    const body: Record<string, unknown> = { query };
    const limit = Number(args.limit ?? 0);
    if (limit > 0) body.limit = limit;
    return { structuredContent: await request(credential, "POST", "/v2/search", withOptions(args, body), tool) };
  }

  if (tool === "firecrawl/extract") {
    const body: Record<string, unknown> = {};
    if (Array.isArray(args.urls)) body.urls = args.urls;
    const prompt = optionalArg(args, "prompt");
    if (prompt) body.prompt = prompt;
    if (args.schema && typeof args.schema === "object") body.schema = args.schema;
    const merged = withOptions(args, body);
    if (!Array.isArray((merged as any).urls) && !(merged as any).prompt) {
      throw new Error("extract requires urls (array) and/or prompt");
    }
    return { structuredContent: await request(credential, "POST", "/v2/extract", merged, tool) };
  }

  if (tool === "firecrawl/get_extract_status") {
    const extractId = requireArg(args, "extract_id", ["extractId", "id"]);
    return { structuredContent: await request(credential, "GET", `/v2/extract/${encodeURIComponent(extractId)}`, undefined, tool, { extractId }) };
  }

  if (tool === "firecrawl/get_credit_usage") {
    return { structuredContent: await request(credential, "GET", "/v2/team/credit-usage", undefined, tool) };
  }

  throw new Error(`Unknown Firecrawl tool: ${tool}`);
}
