import type { ProviderDef } from "./registry.js";

const GENERIC_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 120_000;
const MAX_FULL_JSON_PARSE_CHARS = 2_000_000;
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const BLOCKED_EXTRA_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
]);

type GenericRequestArgs = Record<string, unknown>;
type GenericManifest = NonNullable<ProviderDef["genericRequest"]>;

function parseJsonMaybe(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizePath(pathValue: unknown) {
  const path = String(pathValue ?? "").trim();
  if (!path) throw new Error("path is required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error("provider_path_not_allowed: path must be relative, not a full URL");
  if (path.includes("..")) throw new Error("provider_path_not_allowed: path must not contain ..");
  return path.startsWith("/") ? path : `/${path}`;
}

function queryFromRecord(query: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function queryFromArgs(args: GenericRequestArgs) {
  const query = args.query && typeof args.query === "object" && !Array.isArray(args.query) ? args.query as Record<string, unknown> : {};
  return queryFromRecord(query);
}

function headersFromArgs(headersValue: unknown) {
  if (!headersValue || typeof headersValue !== "object" || Array.isArray(headersValue)) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersValue as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (BLOCKED_EXTRA_HEADERS.has(name.toLowerCase())) {
      throw new Error(`provider_header_not_allowed: ${name} cannot be overridden`);
    }
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) || typeof value === "object") {
      throw new Error(`provider_header_not_allowed: ${name} must be a scalar value`);
    }
    headers[name] = String(value);
  }
  return headers;
}

function requestBodyFromArgs(args: GenericRequestArgs) {
  if (Object.prototype.hasOwnProperty.call(args, "body")) return args.body;
  if (Object.prototype.hasOwnProperty.call(args, "data")) return args.data;
  if (Object.prototype.hasOwnProperty.call(args, "json")) return args.json;
  return undefined;
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function resolveBaseUrl(provider: string, manifest: GenericManifest, credential: string, baseUrlKeyValue?: unknown) {
  const baseUrlKey = String(baseUrlKeyValue ?? "").trim();
  if (baseUrlKey) {
    const baseUrl = manifest.baseUrls?.[baseUrlKey];
    if (!baseUrl) {
      const allowed = Object.keys(manifest.baseUrls ?? {});
      throw new Error(`provider_base_url_not_allowed: ${provider}/request base_url_key must be one of ${allowed.join(", ") || "(none)"}`);
    }
    return normalizeBaseUrl(baseUrl);
  }
  if (manifest.baseUrl === "credential.instance_url") {
    const parsed = parseJsonMaybe(credential);
    const instanceUrl = normalizeBaseUrl(String(parsed?.instance_url ?? parsed?.instanceUrl ?? ""));
    if (!instanceUrl) throw new Error(`${provider}/request requires a JSON credential with instance_url`);
    return instanceUrl;
  }
  if (provider === "mailchimp") {
    const dc = credential.match(/-([a-z]{2,}\d+)$/i)?.[1];
    if (dc) return `https://${dc}.api.mailchimp.com/3.0`;
  }
  return normalizeBaseUrl(manifest.baseUrl);
}

function credentialToken(provider: string, credential: string) {
  const parsed = parseJsonMaybe(credential);
  if (provider === "salesforce" && parsed) return String(parsed.token ?? parsed.access_token ?? credential);
  if (provider === "customerio" && parsed) return String(parsed.token ?? credential);
  if (provider === "microsoft_ads" && parsed) return String(parsed.access_token ?? credential);
  return credential;
}

function assertAllowed(provider: string, manifest: GenericManifest, method: string, path: string) {
  const allowedMethods = new Set((manifest.defaultMethods || ["GET"]).map((m) => m.toUpperCase()));
  if (!allowedMethods.has(method)) {
    throw new Error(`provider_path_not_allowed: ${provider}/request currently allows ${Array.from(allowedMethods).join(", ")} only`);
  }
  const allowedPrefixes = manifest.allowedPathPrefixes.length ? manifest.allowedPathPrefixes : ["/"];
  if (!allowedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) || prefix === "/")) {
    throw new Error(`provider_path_not_allowed: path ${path} is outside allowed prefixes (${allowedPrefixes.join(", ")})`);
  }
  if ((manifest.blockedPathPrefixes || []).some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
    throw new Error(`provider_path_not_allowed: path ${path} is blocked`);
  }
}

export function classifyProviderError(provider: string, status: number, body: unknown) {
  const text = JSON.stringify(body).slice(0, 4000);
  const missingScopes = new Set<string>();
  for (const match of text.matchAll(/\b(?:missing|Missing|MISSING)[^"']*(?:scope|scopes|auth)[^"']*[: ]+([a-zA-Z0-9_.:-]+)/g)) {
    if (match[1]) missingScopes.add(match[1]);
  }
  for (const match of text.matchAll(/\b(?:content|oauth|crm\.objects\.[a-z.]+|[a-z_]+:[a-z_]+)\b/g)) {
    if (text.toLowerCase().includes("missing") || text.toLowerCase().includes("scope")) missingScopes.add(match[0]);
  }
  const lower = text.toLowerCase();
  let code = "provider_request_failed";
  if (status === 401) code = "provider_auth_invalid";
  else if (status === 403 && missingScopes.size) code = "provider_scope_missing";
  else if (status === 403 && (lower.includes("not available") || lower.includes("plan") || lower.includes("subscription"))) {
    code = "provider_plan_or_api_unavailable";
  }
  return { code, missingScopes: Array.from(missingScopes), provider };
}

function getPathValue(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function parseCompleteJsonForMetadata(text: string) {
  if (!text || text.length > MAX_FULL_JSON_PARSE_CHARS) return null;
  return parseJsonMaybe(text);
}

function extractLastDataId(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") return null;
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    const id = stringValue((data[i] as Record<string, unknown> | null)?.id);
    if (id) return id;
  }
  return null;
}

function extractCursorFromParsed(parsed: unknown) {
  const paths = [
    ["next_cursor"],
    ["nextCursor"],
    ["next_page_token"],
    ["nextPageToken"],
    ["paging", "next", "after"],
    ["paging", "cursors", "after"],
    ["paging", "cursor", "after"],
    ["pagination", "next_cursor"],
    ["pagination", "nextCursor"],
    ["meta", "next_cursor"],
    ["meta", "nextCursor"],
    ["links", "next"],
  ];
  for (const path of paths) {
    const cursor = stringValue(getPathValue(parsed, path));
    if (cursor) return { cursor, source: path.join(".") };
  }
  const lastDataId = extractLastDataId(parsed);
  if (lastDataId) return { cursor: lastDataId, source: "data.last.id" };
  return null;
}

function extractHasMoreFromParsed(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") return null;
  const direct = (parsed as Record<string, unknown>).has_more;
  if (typeof direct === "boolean") return direct;
  const hasMore = getPathValue(parsed, ["paging", "has_more"]) ?? getPathValue(parsed, ["pagination", "has_more"]);
  return typeof hasMore === "boolean" ? hasMore : null;
}

function extractHasMoreFromText(text: string) {
  const match = text.match(/"has_more"\s*:\s*(true|false)/);
  return match ? match[1] === "true" : null;
}

function extractObjectCount(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") return null;
  const data = (parsed as Record<string, unknown>).data;
  if (Array.isArray(data)) return data.length;
  const results = (parsed as Record<string, unknown>).results;
  if (Array.isArray(results)) return results.length;
  const items = (parsed as Record<string, unknown>).items;
  if (Array.isArray(items)) return items.length;
  return null;
}

function paginationMetadata(text: string, parsedBody: unknown, truncated: boolean) {
  const completeParsed = parseCompleteJsonForMetadata(text);
  const metadataSource = completeParsed ?? parsedBody;
  const cursor = extractCursorFromParsed(metadataSource);
  const hasMore = extractHasMoreFromParsed(metadataSource) ?? extractHasMoreFromText(text);
  const objectCount = extractObjectCount(metadataSource);
  if (!truncated && !cursor && hasMore === null && objectCount === null) return undefined;
  return {
    truncated,
    has_more: hasMore,
    next_cursor: hasMore === false ? null : (cursor?.cursor ?? null),
    cursor_source: cursor?.source ?? null,
    object_count: objectCount,
    body_preview_chars: truncated ? Math.min(text.length, MAX_RESPONSE_CHARS) : text.length,
    full_body_chars: text.length,
  };
}

async function readResponse(response: Response) {
  const text = await response.text();
  const truncated = text.length > MAX_RESPONSE_CHARS;
  const bodyText = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;
  if (!bodyText) {
    const body = {};
    return { body, truncated, pagination: paginationMetadata(text, body, truncated) };
  }
  try {
    const body = JSON.parse(bodyText);
    return { body, truncated, pagination: paginationMetadata(text, body, truncated) };
  } catch {
    const body = { raw: bodyText };
    return { body, truncated, pagination: paginationMetadata(text, body, truncated) };
  }
}

async function executeGenericRequest(args: {
  provider: ProviderDef;
  credential: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  baseUrlKey?: unknown;
  logTool: string;
}) {
  const manifest = args.provider.genericRequest;
  if (!manifest) throw new Error(`tool_not_implemented: ${args.provider.key}/request is not enabled`);
  const method = args.method.trim().toUpperCase();
  const path = normalizePath(args.path);
  assertAllowed(args.provider.key, manifest, method, path);

  const baseUrl = resolveBaseUrl(args.provider.key, manifest, args.credential, args.baseUrlKey);
  const qs = queryFromRecord(args.query ?? {});
  const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
  const token = credentialToken(args.provider.key, args.credential);
  const headers: Record<string, string> = { Accept: "application/json" };
  if ((manifest.authScheme ?? "bearer") === "api_key") {
    headers[manifest.apiKeyHeader ?? "Authorization"] = manifest.apiKeyHeader ? token : `Bearer ${token}`;
  } else {
    headers.Authorization = `Bearer ${token}`;
  }
  if (args.provider.key === "godaddy") headers.Authorization = `sso-key ${token}`;
  if (args.provider.key === "github") headers["User-Agent"] = "grantry";
  if (args.provider.key === "reddit") headers["User-Agent"] = "grantry/1.0 (MCP connector)";
  if (args.provider.key === "stripe") headers["Stripe-Version"] = "2024-06-20";
  Object.assign(headers, args.headers ?? {});

  const init: RequestInit = { method, headers, signal: undefined };
  if (args.body !== undefined) {
    if (BODYLESS_METHODS.has(method)) throw new Error(`provider_body_not_allowed: ${method} requests cannot include a body`);
    if (typeof args.body === "string") {
      init.body = args.body;
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = "text/plain";
    } else {
      init.body = JSON.stringify(args.body ?? {});
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    }
  }

  const controller = new AbortController();
  init.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), GENERIC_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[provider-request] request", { provider: args.provider.key, method, path, baseUrlKey: args.baseUrlKey });
    const response = await fetch(url, init);
    const { body, truncated, pagination } = await readResponse(response);
    console.log("[provider-request] response", {
      provider: args.provider.key,
      method,
      path,
      baseUrlKey: args.baseUrlKey,
      status: response.status,
      durationMs: Date.now() - started,
      truncated,
    });
    if (!response.ok) {
      const classified = classifyProviderError(args.provider.key, response.status, body);
      throw new Error(`${classified.code}: ${args.provider.key} ${method} ${path} returned ${response.status} ${JSON.stringify({ ...classified, body }).slice(0, 1200)}`);
    }
    return {
      structuredContent: {
        provider: args.provider.key,
        method,
        path,
        base_url_key: args.baseUrlKey ?? null,
        status: response.status,
        truncated,
        ...(pagination ? { pagination } : {}),
        body,
      },
    };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`provider_request_timeout: ${args.provider.key} ${method} ${path} timed out after ${GENERIC_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callGenericProviderRequest(args: {
  provider: ProviderDef;
  toolName: string;
  requestArgs: GenericRequestArgs;
  credential: string;
}) {
  return executeGenericRequest({
    provider: args.provider,
    credential: args.credential,
    method: String(args.requestArgs.method ?? "GET"),
    path: String(args.requestArgs.path ?? ""),
    query: args.requestArgs.query && typeof args.requestArgs.query === "object" && !Array.isArray(args.requestArgs.query)
      ? args.requestArgs.query as Record<string, unknown>
      : {},
    body: requestBodyFromArgs(args.requestArgs),
    headers: headersFromArgs(args.requestArgs.headers),
    baseUrlKey: args.requestArgs.base_url_key ?? args.requestArgs.baseUrlKey,
    logTool: args.toolName,
  });
}

export async function callGenericCheckConnection(args: {
  provider: ProviderDef;
  credential: string;
}) {
  const manifest = args.provider.genericRequest;
  if (!manifest) throw new Error(`tool_not_implemented: ${args.provider.key}/check_connection is not enabled`);
  const tests = manifest.smokeTests ?? [];
  const operations = manifest.operations ?? [];
  if (!tests.length && !operations.length) {
    return {
      structuredContent: {
        provider: args.provider.key,
        status: "unknown",
        message: "No smoke tests are defined for this provider yet.",
        tests: [],
      },
    };
  }

  const results = [];
  for (const test of tests) {
    try {
      const result = await executeGenericRequest({
        provider: args.provider,
        credential: args.credential,
        method: test.method,
        path: test.path,
        query: test.query ?? {},
        baseUrlKey: (test as Record<string, unknown>).base_url_key ?? (test as Record<string, unknown>).baseUrlKey,
        logTool: `${args.provider.key}/check_connection`,
      });
      results.push({
        id: test.id,
        status: "ok",
        method: test.method,
        path: test.path,
        requiredScopes: test.requiredScopes ?? [],
        baseUrlKey: (test as Record<string, unknown>).base_url_key ?? (test as Record<string, unknown>).baseUrlKey ?? null,
        responseStatus: result.structuredContent.status,
      });
    } catch (e: any) {
      const message = String(e?.message ?? e);
      const missingScopes = Array.from(message.matchAll(/"missingScopes":\[(.*?)\]/g))
        .flatMap((m) => m[1].split(",").map((s) => s.replace(/["\s]/g, "")).filter(Boolean));
      results.push({
        id: test.id,
        status: "error",
        method: test.method,
        path: test.path,
        requiredScopes: test.requiredScopes ?? [],
        baseUrlKey: (test as Record<string, unknown>).base_url_key ?? (test as Record<string, unknown>).baseUrlKey ?? null,
        missingScopes,
        error: message.slice(0, 1200),
      });
    }
  }
  for (const op of operations) {
    const method = String(op.method ?? "").toUpperCase();
    const path = String(op.path ?? "");
    if (method !== "GET" || path.includes("{")) continue;
    // Default to a cheap `limit: 1` probe, but let operations override it —
    // some APIs (e.g. the Search Console Webmasters API) 400 on an unknown `limit`.
    const probeQuery = (op as Record<string, unknown>).probeQuery as
      | Record<string, string | number | boolean>
      | undefined;
    try {
      const result = await executeGenericRequest({
        provider: args.provider,
        credential: args.credential,
        method,
        path,
        query: probeQuery ?? { limit: 1 },
        baseUrlKey: (op as Record<string, unknown>).base_url_key ?? (op as Record<string, unknown>).baseUrlKey,
        logTool: `${args.provider.key}/check_connection`,
      });
      results.push({
        id: `operation:${op.id}`,
        operationId: op.id,
        status: "ok",
        method,
        path,
        requiredScopes: op.requiredScopes ?? [],
        responseStatus: result.structuredContent.status,
      });
    } catch (e: any) {
      const message = String(e?.message ?? e);
      const missingScopes = Array.from(message.matchAll(/"missingScopes":\[(.*?)\]/g))
        .flatMap((m) => m[1].split(",").map((s) => s.replace(/["\s]/g, "")).filter(Boolean));
      results.push({
        id: `operation:${op.id}`,
        operationId: op.id,
        status: "error",
        method,
        path,
        requiredScopes: op.requiredScopes ?? [],
        missingScopes,
        error: message.slice(0, 1200),
      });
    }
  }

  // A 403 for an ungranted scope is *coverage*, not a broken connection.
  // Scope sets vary per customer, so a missing (often optional) scope must not
  // flip the whole connection to "error" — only genuine connectivity/auth
  // failures do. Scope gaps are surfaced separately as informational coverage.
  const isScopeGap = (r: any) => {
    if (!r || r.status === "ok") return false;
    if (Array.isArray(r.missingScopes) && r.missingScopes.length) return true;
    return /provider_scope_missing|provider_plan_or_api_unavailable/.test(String(r.error ?? ""));
  };
  const hardFailures = results.filter((r) => r.status !== "ok" && !isScopeGap(r));
  const scopeGaps = results.filter((r) => r.status !== "ok" && isScopeGap(r));
  return {
    structuredContent: {
      provider: args.provider.key,
      status: hardFailures.length ? "error" : "ok",
      tests: results,
      scopeGaps: scopeGaps.map((r: any) => ({
        id: r.id,
        operationId: r.operationId ?? null,
        requiredScopes: r.requiredScopes ?? [],
        missingScopes: r.missingScopes ?? [],
      })),
    },
  };
}

export async function callGenericListCapabilities(args: {
  provider: ProviderDef;
}) {
  const manifest = args.provider.genericRequest;
  if (!manifest) throw new Error(`tool_not_implemented: ${args.provider.key}/list_capabilities is not enabled`);
  return {
    structuredContent: {
      provider: args.provider.key,
      genericRequest: {
        enabled: true,
        defaultMethods: manifest.defaultMethods,
        baseUrlKeys: Object.keys(manifest.baseUrls ?? {}),
        allowedPathPrefixes: manifest.allowedPathPrefixes,
        blockedPathPrefixes: manifest.blockedPathPrefixes ?? [],
      },
      smokeTests: manifest.smokeTests ?? [],
      operations: (manifest.operations ?? []).map((op) => ({
        ...op,
        requestTemplate: {
          tool: `${args.provider.key}/request`,
          method: op.method,
          base_url_key: op.baseUrlKey ?? op.base_url_key ?? null,
          path: op.path,
        },
        capabilityStatus: "manifest_known",
      })),
    },
  };
}
