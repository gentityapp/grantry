// Money Forward Cloud API connector.
// API keys are customer/workspace credentials. Grantry exchanges them for a
// short-lived JWT via /auth/exchange and calls the service APIs enabled on that
// key; it never stores a company-wide Money Forward credential in code.
import { Buffer } from "node:buffer";

const MF_AUTH_EXCHANGE = "https://api.biz.moneyforward.com/auth/exchange";
const MF_ACCOUNTING_API = "https://api-accounting.moneyforward.com/api/v3";
const MF_TIMEOUT_MS = 12_000;

type MoneyForwardArgs = Record<string, unknown>;

export type MoneyForwardJwtClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  services?: string[];
  scopes?: string[];
  scope?: string;
  [key: string]: unknown;
};

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

export function decodeMoneyForwardJwt(token: string): MoneyForwardJwtClaims {
  const payload = String(token ?? "").split(".")[1];
  if (!payload) return {};
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function moneyForwardServicesFromClaims(claims: MoneyForwardJwtClaims) {
  return Array.isArray(claims.services) ? claims.services.map(String).filter(Boolean) : [];
}

export function moneyForwardScopesFromClaims(claims: MoneyForwardJwtClaims) {
  if (Array.isArray(claims.scopes)) return claims.scopes.map(String).filter(Boolean);
  if (typeof claims.scope === "string") return claims.scope.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

async function fetchMoneyForwardAuthExchange(apiKey: string) {
  return fetchWithTimeout(
    MF_AUTH_EXCHANGE,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    { operation: "api_key_exchange" },
  );
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
  if (tool === "moneyforward/list_services") {
    const claims = decodeMoneyForwardJwt(token);
    return {
      structuredContent: {
        issuer: claims.iss,
        subject: claims.sub,
        expires_at: claims.exp ? new Date(Number(claims.exp) * 1000).toISOString() : undefined,
        services: moneyForwardServicesFromClaims(claims),
        scopes: moneyForwardScopesFromClaims(claims),
      },
    };
  }

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
