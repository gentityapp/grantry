// Money Forward Cloud Accounting connector.
// Cloud Accounting API uses OAuth 2.0 access tokens; Money Forward API keys are
// intentionally not supported by this connector.
const MF_ACCOUNTING_API = "https://api-accounting.moneyforward.com/api/v3";
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

async function fetchWithTimeout(url: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MF_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[moneyforward] request", { url, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[moneyforward] response", { url, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[moneyforward] failed", {
      url,
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

async function requestJson(token: string, method: string, url: string, body: unknown, tool: string) {
  const init: RequestInit = { method, headers: headers(token) };
  if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
  const r = await fetchWithTimeout(url, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Money Forward ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function stringArg(args: MoneyForwardArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function objArg(args: MoneyForwardArgs, key: string) {
  const value = args[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function queryString(query: unknown) {
  if (!query || typeof query !== "object" || Array.isArray(query)) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function accountingUrl(path: string, query?: unknown) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (cleanPath.includes("://") || cleanPath.includes("..")) throw new Error("path must be a relative API path");
  return `${MF_ACCOUNTING_API}${cleanPath}${queryString(query)}`;
}

async function requestAccounting(token: string, tool: string, method: string, path: string, args: MoneyForwardArgs = {}) {
  const body = objArg(args, "body");
  return requestJson(token, method, accountingUrl(path, args.query), body, tool);
}

export async function callMoneyForwardTool(tool: string, args: MoneyForwardArgs, token: string) {
  if (tool === "moneyforward/accounting_request") {
    const path = stringArg(args, "path");
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported method");
    return { structuredContent: await requestAccounting(token, tool, method, path, args) };
  }

  if (tool === "moneyforward/accounting_get_office") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/offices", args) };
  }

  if (tool === "moneyforward/accounting_list_accounts") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/accounts", args) };
  }

  if (tool === "moneyforward/accounting_list_departments") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/departments", args) };
  }

  if (tool === "moneyforward/accounting_list_taxes") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/taxes", args) };
  }

  if (tool === "moneyforward/accounting_list_sub_accounts") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/sub_accounts", args) };
  }

  if (tool === "moneyforward/accounting_list_journals") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/journals", args) };
  }

  if (tool === "moneyforward/accounting_get_journal") {
    const journalId = stringArg(args, "journal_id", ["id"]);
    return { structuredContent: await requestAccounting(token, tool, "GET", `/journals/${encodeURIComponent(journalId)}`, args) };
  }

  if (tool === "moneyforward/accounting_list_trade_partners") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/trade_partners", args) };
  }

  if (tool === "moneyforward/accounting_trial_balance_bs") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/reports/trial_balance_bs", args) };
  }

  if (tool === "moneyforward/accounting_trial_balance_pl") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/reports/trial_balance_pl", args) };
  }

  if (tool === "moneyforward/accounting_transition_bs") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/reports/transition_bs", args) };
  }

  if (tool === "moneyforward/accounting_transition_pl") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/reports/transition_pl", args) };
  }

  if (tool === "moneyforward/accounting_list_term_settings") {
    return { structuredContent: await requestAccounting(token, tool, "GET", "/term_settings", args) };
  }

  throw new Error(`Unknown Money Forward tool: ${tool}`);
}
