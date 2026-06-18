import type { ProviderDef } from "./registry.js";

const GENERIC_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 120_000;

type GenericRequestArgs = Record<string, unknown>;

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

function queryFromArgs(args: GenericRequestArgs) {
  const params = new URLSearchParams();
  const query = args.query && typeof args.query === "object" && !Array.isArray(args.query) ? args.query as Record<string, unknown> : {};
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

function resolveBaseUrl(provider: string, manifest: NonNullable<ProviderDef["genericRequest"]>, credential: string) {
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

function assertAllowed(provider: string, manifest: NonNullable<ProviderDef["genericRequest"]>, method: string, path: string) {
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

export async function callGenericProviderRequest(args: {
  provider: ProviderDef;
  toolName: string;
  requestArgs: GenericRequestArgs;
  credential: string;
}) {
  const manifest = args.provider.genericRequest;
  if (!manifest) throw new Error(`tool_not_implemented: ${args.provider.key}/request is not enabled`);
  const method = String(args.requestArgs.method ?? "GET").trim().toUpperCase();
  const path = normalizePath(args.requestArgs.path);
  assertAllowed(args.provider.key, manifest, method, path);

  const baseUrl = resolveBaseUrl(args.provider.key, manifest, args.credential);
  const qs = queryFromArgs(args.requestArgs);
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
      throw new Error(`provider_request_failed: ${args.provider.key} ${method} ${path} returned ${response.status} ${JSON.stringify(body).slice(0, 1200)}`);
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
