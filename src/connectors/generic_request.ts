import type { ProviderDef } from "./registry.js";

const GENERIC_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 120_000;

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

function resolveBaseUrl(provider: string, manifest: GenericManifest, credential: string) {
  if (manifest.baseUrl === "credential.instance_url") {
    const parsed = parseJsonMaybe(credential);
    const instanceUrl = String(parsed?.instance_url ?? parsed?.instanceUrl ?? "").replace(/\/+$/, "");
    if (!instanceUrl) throw new Error(`${provider}/request requires a JSON credential with instance_url`);
    return instanceUrl;
  }
  if (provider === "mailchimp") {
    const dc = credential.match(/-([a-z]{2,}\d+)$/i)?.[1];
    if (dc) return `https://${dc}.api.mailchimp.com/3.0`;
  }
  return manifest.baseUrl.replace(/\/+$/, "");
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

function classifyProviderError(provider: string, status: number, body: unknown) {
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

async function readResponse(response: Response) {
  const text = await response.text();
  const truncated = text.length > MAX_RESPONSE_CHARS;
  const bodyText = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;
  if (!bodyText) return { body: {}, truncated };
  try {
    return { body: JSON.parse(bodyText), truncated };
  } catch {
    return { body: { raw: bodyText }, truncated };
  }
}

async function executeGenericRequest(args: {
  provider: ProviderDef;
  credential: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  logTool: string;
}) {
  const manifest = args.provider.genericRequest;
  if (!manifest) throw new Error(`tool_not_implemented: ${args.provider.key}/request is not enabled`);
  const method = args.method.trim().toUpperCase();
  const path = normalizePath(args.path);
  assertAllowed(args.provider.key, manifest, method, path);

  const baseUrl = resolveBaseUrl(args.provider.key, manifest, args.credential);
  const qs = queryFromRecord(args.query ?? {});
  const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
  const token = credentialToken(args.provider.key, args.credential);
  const headers: Record<string, string> = { Accept: "application/json" };
  if ((manifest.authScheme ?? "bearer") === "api_key") {
    headers[manifest.apiKeyHeader ?? "Authorization"] = manifest.apiKeyHeader ? token : `Bearer ${token}`;
  } else {
    headers.Authorization = `Bearer ${token}`;
  }
  if (args.provider.key === "github") headers["User-Agent"] = "grantry";
  if (args.provider.key === "reddit") headers["User-Agent"] = "grantry/1.0 (MCP connector)";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERIC_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[provider-request] request", { provider: args.provider.key, method, path });
    const response = await fetch(url, { method, headers, signal: controller.signal });
    const { body, truncated } = await readResponse(response);
    console.log("[provider-request] response", {
      provider: args.provider.key,
      method,
      path,
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
        status: response.status,
        truncated,
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
  if (!tests.length) {
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
        logTool: `${args.provider.key}/check_connection`,
      });
      results.push({
        id: test.id,
        status: "ok",
        method: test.method,
        path: test.path,
        requiredScopes: test.requiredScopes ?? [],
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
        missingScopes,
        error: message.slice(0, 1200),
      });
    }
  }

  const failed = results.filter((r) => r.status !== "ok");
  return {
    structuredContent: {
      provider: args.provider.key,
      status: failed.length ? "error" : "ok",
      tests: results,
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
        allowedPathPrefixes: manifest.allowedPathPrefixes,
        blockedPathPrefixes: manifest.blockedPathPrefixes ?? [],
      },
      smokeTests: manifest.smokeTests ?? [],
      operations: (manifest.operations ?? []).map((op) => ({
        ...op,
        capabilityStatus: "manifest_known",
      })),
    },
  };
}
