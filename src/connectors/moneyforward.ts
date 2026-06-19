// Money Forward (マネーフォワード クラウド請求書) connector — OAuth 2.0 access
// token via Authorization: Bearer. Implements the Cloud Invoice API v3.
// Access tokens expire; grantry stores the refresh token and refreshes
// automatically. The token is scoped to a single office (取得先事業者).
const MF_API = "https://invoice.moneyforward.com/api/v3";
const MF_AUTH_EXCHANGE = "https://api.biz.moneyforward.com/auth/exchange";
const MF_TIMEOUT_MS = 12_000;

type MoneyForwardArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchMoneyForward(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MF_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[moneyforward] request", { path, ...logContext });
    const response = await fetch(`${MF_API}${path}`, { ...init, signal: controller.signal });
    console.log("[moneyforward] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[moneyforward] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${MF_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Money Forward request timed out after ${MF_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(token: string, method: string, path: string, body: unknown, tool: string) {
  const init: RequestInit = { method, headers: headers(token) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchMoneyForward(path, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Money Forward ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function exchangeMoneyForwardApiKey(apiKey: string) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("Money Forward API key is required");
  const response = await fetchMoneyForwardAuthExchange(key);
  const json: any = await readJsonResponse(response);
  if (!response.ok || !json.access_token) {
    throw new Error(`Money Forward API key exchange failed: ${response.status} ${JSON.stringify(json).slice(0, 500)}`);
  }
  return {
    access_token: String(json.access_token),
    token_type: String(json.token_type ?? "Bearer"),
    expires_in: Number(json.expires_in) || 3600,
  };
}

async function fetchMoneyForwardAuthExchange(apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MF_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[moneyforward] api_key_exchange request");
    const response = await fetch(MF_AUTH_EXCHANGE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    console.log("[moneyforward] api_key_exchange response", { status: response.status, durationMs: Date.now() - started });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[moneyforward] api_key_exchange failed", {
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${MF_TIMEOUT_MS}ms` : String(e?.message ?? e),
    });
    if (aborted) throw new Error(`Money Forward API key exchange timed out after ${MF_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function stringArg(args: MoneyForwardArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: MoneyForwardArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function objArg(args: MoneyForwardArgs, key: string) {
  const value = args[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export async function callMoneyForwardTool(tool: string, args: MoneyForwardArgs, token: string) {
  if (tool === "moneyforward/get_office") {
    return { structuredContent: await requestJson(token, "GET", "/office", undefined, tool) };
  }

  if (tool === "moneyforward/list_partners") {
    const qs = queryString(args, ["page", "per_page", "q"]);
    return { structuredContent: await requestJson(token, "GET", `/partners${qs}`, undefined, tool) };
  }

  if (tool === "moneyforward/get_partner") {
    const partnerId = stringArg(args, "partner_id", ["id"]);
    return { structuredContent: await requestJson(token, "GET", `/partners/${encodeURIComponent(partnerId)}`, undefined, tool) };
  }

  if (tool === "moneyforward/create_partner") {
    const body = objArg(args, "partner") ?? { name: stringArg(args, "name") };
    return { structuredContent: await requestJson(token, "POST", "/partners", body, tool) };
  }

  if (tool === "moneyforward/list_billings") {
    const qs = queryString(args, ["page", "per_page", "range_key", "from", "to", "q"]);
    return { structuredContent: await requestJson(token, "GET", `/billings${qs}`, undefined, tool) };
  }

  if (tool === "moneyforward/get_billing") {
    const billingId = stringArg(args, "billing_id", ["id"]);
    return { structuredContent: await requestJson(token, "GET", `/billings/${encodeURIComponent(billingId)}`, undefined, tool) };
  }

  if (tool === "moneyforward/list_quotes") {
    const qs = queryString(args, ["page", "per_page", "range_key", "from", "to", "q"]);
    return { structuredContent: await requestJson(token, "GET", `/quotes${qs}`, undefined, tool) };
  }

  if (tool === "moneyforward/list_items") {
    const qs = queryString(args, ["page", "per_page", "q"]);
    return { structuredContent: await requestJson(token, "GET", `/items${qs}`, undefined, tool) };
  }

  throw new Error(`Unknown Money Forward tool: ${tool}`);
}
