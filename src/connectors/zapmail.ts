// Zapmail connector - workspace API key sent as the x-auth-zapmail header.
// Public API v2 (https://api.zapmail.ai/api), documented at https://docs.zapmail.ai.
// The key is created in the Zapmail dashboard under Settings > Integrations > API.
//   GET  /v2/users                          - authenticated user, plan, mailbox usage, wallet balance
//   GET  /v2/workspaces                     - workspaces on the account
//   GET  /v2/mailboxes/list                 - mailboxes (page/limit/contains)
//   GET  /v2/mailboxes?id=                  - one mailbox
//   GET  /v2/domains                        - domains (page/limit/contains)
//   GET  /v2/domains/assignable             - domains that can take new mailboxes
//   GET  /v2/domains/health-score           - nameserver reputation score
//   GET  /v2/dns/?id=                       - DNS records of one domain
//   GET  /v2/subscriptions                  - subscriptions with plan and billing detail
//   GET  /v2/wallet/balance                 - wallet balance
//   GET  /v2/global/mailbox-domain-search   - unified mailbox/domain lookup
//   GET  /v2/exports/accounts/third-party   - third-party accounts registered for an app
//   GET  /v2/exports/status?exportId=       - status of an export
//   POST /v2/exports/mailboxes              - export mailboxes to a cold-email app or CSV
//   POST /v2/domains/available              - availability + similar names for one domain
//   POST /v2/domains/available-bulk         - availability of up to 20 exact names
//   POST /v2/domains/ai-finder              - AI-suggested available names (async, poll)
//   POST /v2/domains/name-servers           - nameservers to point an owned domain at Zapmail
//   POST /v2/domains/name-servers/verify    - check that the nameserver change propagated
//   POST /v2/domains/connect-domain         - finish connecting an owned domain
//   GET  /v2/domains/connection-requests    - domains still pending connection
// The domain searches above only price and reserve nothing. Endpoints that actually spend
// money (POST /v2/domains/buy, /v2/quick-setup, mailbox and subscription purchase, wallet
// recharge) are deliberately not exposed as tools, and the generic zapmail/request is
// GET-only, so no agent can commit spend through this connector.
// Mailbox payloads carry live mailbox passwords, Google app passwords and TOTP secrets.
// Those are redacted unless the caller explicitly asks for them, so routine listings do
// not spray account credentials through agent transcripts and logs.
const ZAPMAIL_API = "https://api.zapmail.ai/api";
const ZAPMAIL_TIMEOUT_MS = 20_000;

type ZapmailArgs = Record<string, unknown>;

type ZapmailCredential = {
  apiKey: string;
  workspaceKey: string;
  serviceProvider: string;
};

function parseCredential(credential: string): ZapmailCredential {
  let apiKey = credential.trim();
  let workspaceKey = "";
  let serviceProvider = "";
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
      workspaceKey = String(parsed.workspace_key ?? parsed.workspaceKey ?? "").trim();
      serviceProvider = String(parsed.service_provider ?? parsed.serviceProvider ?? "").trim().toUpperCase();
    }
  } catch {
    // plain API key credential
  }
  if (!apiKey) throw new Error("Zapmail credential requires an api_key");
  return { apiKey, workspaceKey, serviceProvider };
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

async function fetchZapmail(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZAPMAIL_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[zapmail] request", { path, ...logContext });
    const response = await fetch(`${ZAPMAIL_API}${path}`, { ...init, signal: controller.signal });
    console.log("[zapmail] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[zapmail] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${ZAPMAIL_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Zapmail request timed out after ${ZAPMAIL_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// The workspace and service provider can be pinned on the connection credential and
// overridden per call, so one connection can reach every workspace on the account.
function buildHeaders(credential: ZapmailCredential, args: ZapmailArgs) {
  const headers: Record<string, string> = {
    "x-auth-zapmail": credential.apiKey,
    Accept: "application/json",
  };
  const workspaceKey = optionalArg(args, "workspace_key", ["workspaceKey", "workspace_id", "workspaceId"]) || credential.workspaceKey;
  if (workspaceKey) headers["x-workspace-key"] = workspaceKey;
  const serviceProvider = (optionalArg(args, "service_provider", ["serviceProvider"]) || credential.serviceProvider).toUpperCase();
  if (serviceProvider) headers["x-service-provider"] = serviceProvider;
  return headers;
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, args: ZapmailArgs, logContext: Record<string, unknown> = {}) {
  const headers = buildHeaders(parseCredential(credential), args);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchZapmail(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Zapmail ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: ZapmailArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: ZapmailArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const raw = args[key];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "boolean" ? String(raw) : String(raw).trim();
    if (value) return value;
  }
  return "";
}

function queryString(args: ZapmailArgs, mapping: Array<[string, string, string[]]>) {
  const params = new URLSearchParams();
  for (const [param, snake, aliases] of mapping) {
    const value = optionalArg(args, snake, aliases);
    if (value) params.set(param, value);
  }
  return params.toString() ? `?${params.toString()}` : "";
}

function stringList(args: ZapmailArgs, key: string, aliases: string[] = []) {
  for (const candidate of [key, ...aliases]) {
    const raw = args[candidate];
    if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
    if (typeof raw === "string" && raw.trim()) return raw.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

const MAILBOX_SECRET_KEYS = new Set(["password", "appPassword", "app_password", "secret", "totpSecret", "twoFactorSecret"]);

// Zapmail returns mailbox credentials inline. Walk the payload and mask them unless the
// caller opted in, so a plain listing never leaks a password an agent did not ask for.
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = MAILBOX_SECRET_KEYS.has(key) && v ? "[redacted]" : redactSecrets(v);
    }
    return out;
  }
  return value;
}

function wantsSecrets(args: ZapmailArgs) {
  const raw = args.include_secrets ?? args.includeSecrets;
  return raw === true || String(raw ?? "").trim().toLowerCase() === "true";
}

export async function callZapmailTool(tool: string, args: ZapmailArgs, credential: string) {
  if (tool === "zapmail/get_user") {
    return { structuredContent: await request(credential, "GET", "/v2/users", undefined, tool, args) };
  }

  if (tool === "zapmail/list_workspaces") {
    const qs = queryString(args, [
      ["page", "page", []],
      ["limit", "limit", ["page_size", "pageSize"]],
      ["search", "search", ["query", "contains"]],
    ]);
    return { structuredContent: await request(credential, "GET", `/v2/workspaces${qs}`, undefined, tool, args) };
  }

  if (tool === "zapmail/list_mailboxes") {
    const qs = queryString(args, [
      ["page", "page", []],
      ["limit", "limit", ["page_size", "pageSize"]],
      ["contains", "contains", ["search", "query"]],
    ]);
    const body = await request(credential, "GET", `/v2/mailboxes/list${qs}`, undefined, tool, args);
    return { structuredContent: wantsSecrets(args) ? body : redactSecrets(body) };
  }

  if (tool === "zapmail/get_mailbox") {
    const id = requireArg(args, "mailbox_id", ["mailboxId", "id"]);
    const body = await request(credential, "GET", `/v2/mailboxes?id=${encodeURIComponent(id)}`, undefined, tool, args, { mailboxId: id });
    return { structuredContent: wantsSecrets(args) ? body : redactSecrets(body) };
  }

  if (tool === "zapmail/list_domains") {
    const qs = queryString(args, [
      ["page", "page", []],
      ["limit", "limit", ["page_size", "pageSize"]],
      ["contains", "contains", ["search", "query"]],
    ]);
    return { structuredContent: await request(credential, "GET", `/v2/domains${qs}`, undefined, tool, args) };
  }

  if (tool === "zapmail/list_assignable_domains") {
    const qs = queryString(args, [
      ["page", "page", []],
      ["limit", "limit", ["page_size", "pageSize"]],
      ["contains", "contains", ["search", "query"]],
    ]);
    return { structuredContent: await request(credential, "GET", `/v2/domains/assignable${qs}`, undefined, tool, args) };
  }

  if (tool === "zapmail/search_domains") {
    // Prices and checks availability only - nothing is registered or reserved by this call.
    const domainName = requireArg(args, "domain_name", ["domainName", "domain", "keyword"]);
    const body: Record<string, unknown> = { domainName };
    const tlds = stringList(args, "tlds", ["tld"]).map((v) => v.replace(/^\./, ""));
    if (tlds.length) body.tlds = tlds;
    const years = optionalArg(args, "years");
    if (years) body.years = Number(years);
    return { structuredContent: await request(credential, "POST", "/v2/domains/available", body, tool, args, { domainName }) };
  }

  if (tool === "zapmail/check_domains") {
    const domainNames = stringList(args, "domain_names", ["domainNames", "domains"]);
    if (!domainNames.length) throw new Error("domain_names is required");
    if (domainNames.length > 20) throw new Error("Zapmail checks at most 20 domain names per call");
    return { structuredContent: await request(credential, "POST", "/v2/domains/available-bulk", { domainNames }, tool, args, { count: domainNames.length }) };
  }

  if (tool === "zapmail/ai_find_domains") {
    // Generation is async: the first call starts it, later calls with the same input poll it.
    const keywords = stringList(args, "keywords", ["keyword"]);
    if (!keywords.length) throw new Error("keywords is required");
    const tlds = stringList(args, "tlds", ["tld"]).map((v) => v.replace(/^\./, ""));
    const desiredCount = Number(optionalArg(args, "desired_count", ["desiredCount", "count"]) || 10);
    const body = { keywords, tlds: tlds.length ? tlds : ["com"], desiredCount };
    return { structuredContent: await request(credential, "POST", "/v2/domains/ai-finder", body, tool, args, { keywords: keywords.join(",") }) };
  }

  if (tool === "zapmail/get_name_servers") {
    // Works for a domain bought anywhere - Zapmail hands back the nameservers to point at it.
    const domainName = requireArg(args, "domain_name", ["domainName", "domain"]);
    // Zapmail rejects the call outright when maskForwarding is absent, so it is always sent.
    const maskForwarding = optionalArg(args, "mask_forwarding", ["maskForwarding"]) === "true";
    const body: Record<string, unknown> = { domainName, maskForwarding };
    return { structuredContent: await request(credential, "POST", "/v2/domains/name-servers", body, tool, args, { domainName }) };
  }

  if (tool === "zapmail/verify_name_servers") {
    const domainName = requireArg(args, "domain_name", ["domainName", "domain"]);
    return { structuredContent: await request(credential, "POST", "/v2/domains/name-servers/verify", { domainName }, tool, args, { domainName }) };
  }

  if (tool === "zapmail/connect_domain") {
    const domainNames = stringList(args, "domain_names", ["domainNames", "domain_name", "domainName", "domains", "domain"]);
    if (!domainNames.length) throw new Error("domain_names is required");
    return { structuredContent: await request(credential, "POST", "/v2/domains/connect-domain", { domainNames }, tool, args, { count: domainNames.length }) };
  }

  if (tool === "zapmail/list_connection_requests") {
    const qs = queryString(args, [
      ["page", "page", []],
      ["limit", "limit", ["page_size", "pageSize"]],
    ]);
    return { structuredContent: await request(credential, "GET", `/v2/domains/connection-requests${qs}`, undefined, tool, args) };
  }

  if (tool === "zapmail/get_domain_health") {
    // domainId is optional: without it Zapmail scores every domain in the workspace.
    const qs = queryString(args, [["domainId", "domain_id", ["domainId", "id"]]]);
    return { structuredContent: await request(credential, "GET", `/v2/domains/health-score${qs}`, undefined, tool, args) };
  }

  if (tool === "zapmail/get_dns_records") {
    const id = requireArg(args, "domain_id", ["domainId", "id"]);
    return { structuredContent: await request(credential, "GET", `/v2/dns/?id=${encodeURIComponent(id)}`, undefined, tool, args, { domainId: id }) };
  }

  if (tool === "zapmail/list_subscriptions") {
    const qs = queryString(args, [
      ["page", "page", []],
      ["limit", "limit", ["page_size", "pageSize"]],
    ]);
    return { structuredContent: await request(credential, "GET", `/v2/subscriptions${qs}`, undefined, tool, args) };
  }

  if (tool === "zapmail/get_wallet_balance") {
    return { structuredContent: await request(credential, "GET", "/v2/wallet/balance", undefined, tool, args) };
  }

  if (tool === "zapmail/search") {
    // page and limit are required by the endpoint, so they get defaults here.
    const params = new URLSearchParams({
      page: optionalArg(args, "page") || "1",
      limit: optionalArg(args, "limit", ["page_size", "pageSize"]) || "10",
    });
    const contains = optionalArg(args, "contains", ["search", "query", "domain", "email"]);
    if (contains) params.set("contains", contains);
    const body = await request(credential, "GET", `/v2/global/mailbox-domain-search?${params.toString()}`, undefined, tool, args);
    return { structuredContent: wantsSecrets(args) ? body : redactSecrets(body) };
  }

  if (tool === "zapmail/list_third_party_accounts") {
    const app = requireArg(args, "app").toUpperCase();
    return { structuredContent: await request(credential, "GET", `/v2/exports/accounts/third-party?app=${encodeURIComponent(app)}`, undefined, tool, args, { app }) };
  }

  if (tool === "zapmail/get_export_status") {
    const exportId = requireArg(args, "export_id", ["exportId", "id"]);
    return { structuredContent: await request(credential, "GET", `/v2/exports/status?exportId=${encodeURIComponent(exportId)}`, undefined, tool, args, { exportId }) };
  }

  if (tool === "zapmail/export_mailboxes") {
    // Zapmail requires every selector key in the body, so the unset ones are sent empty.
    const apps = stringList(args, "apps", ["app"]).map((v) => v.toUpperCase());
    if (!apps.length) throw new Error("apps is required");
    const body: Record<string, unknown> = {
      apps,
      ids: stringList(args, "ids", ["mailbox_ids", "mailboxIds"]),
      excludeIds: stringList(args, "exclude_ids", ["excludeIds"]),
      tagIds: stringList(args, "tag_ids", ["tagIds"]),
      status: optionalArg(args, "status").toUpperCase(),
      contains: optionalArg(args, "contains", ["search", "query"]),
    };
    const thirdPartyAccountId = optionalArg(args, "third_party_account_id", ["thirdPartyAccountId"]);
    if (thirdPartyAccountId) body.thirdPartyAccountId = thirdPartyAccountId;
    return { structuredContent: await request(credential, "POST", "/v2/exports/mailboxes", body, tool, args, { apps: apps.join(",") }) };
  }

  throw new Error(`Unknown Zapmail tool: ${tool}`);
}
