// freee (会計freee) connector — OAuth 2.0 access token via Authorization: Bearer.
// Access tokens expire (default 21600s); grantry stores the refresh token and
// refreshes automatically. Most accounting endpoints are scoped to a company,
// so company_id is required where noted.
const FREEE_API = "https://api.freee.co.jp";
const FREEE_TIMEOUT_MS = 12_000;

type FreeeArgs = Record<string, unknown>;

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

async function fetchFreee(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FREEE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[freee] request", { path, ...logContext });
    const response = await fetch(`${FREEE_API}${path}`, { ...init, signal: controller.signal });
    console.log("[freee] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[freee] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${FREEE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`freee request timed out after ${FREEE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(token: string, method: string, path: string, body: unknown, tool: string) {
  const init: RequestInit = { method, headers: headers(token) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchFreee(path, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`freee ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function stringArg(args: FreeeArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function companyId(args: FreeeArgs) {
  return stringArg(args, "company_id", ["companyId"]);
}

function queryString(args: FreeeArgs, keys: string[], extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function objArg(args: FreeeArgs, key: string) {
  const value = args[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export async function callFreeeTool(tool: string, args: FreeeArgs, token: string) {
  if (tool === "freee/get_me") {
    return { structuredContent: await requestJson(token, "GET", "/api/1/users/me", undefined, tool) };
  }

  if (tool === "freee/list_companies") {
    return { structuredContent: await requestJson(token, "GET", "/api/1/companies", undefined, tool) };
  }

  if (tool === "freee/list_deals") {
    const qs = queryString(args, ["partner_id", "account_item_id", "status", "type", "start_issue_date", "end_issue_date", "offset", "limit"], { company_id: companyId(args) });
    return { structuredContent: await requestJson(token, "GET", `/api/1/deals${qs}`, undefined, tool) };
  }

  if (tool === "freee/get_deal") {
    const dealId = stringArg(args, "deal_id", ["id"]);
    const qs = queryString(args, [], { company_id: companyId(args) });
    return { structuredContent: await requestJson(token, "GET", `/api/1/deals/${encodeURIComponent(dealId)}${qs}`, undefined, tool) };
  }

  if (tool === "freee/create_deal") {
    const body = objArg(args, "deal") ?? {
      company_id: Number(companyId(args)) || companyId(args),
      issue_date: stringArg(args, "issue_date"),
      type: stringArg(args, "type"),
      details: args.details,
    };
    return { structuredContent: await requestJson(token, "POST", "/api/1/deals", body, tool) };
  }

  if (tool === "freee/list_account_items") {
    const qs = queryString(args, [], { company_id: companyId(args) });
    return { structuredContent: await requestJson(token, "GET", `/api/1/account_items${qs}`, undefined, tool) };
  }

  if (tool === "freee/list_partners") {
    const qs = queryString(args, ["keyword", "offset", "limit"], { company_id: companyId(args) });
    return { structuredContent: await requestJson(token, "GET", `/api/1/partners${qs}`, undefined, tool) };
  }

  if (tool === "freee/create_partner") {
    const body = objArg(args, "partner") ?? {
      company_id: Number(companyId(args)) || companyId(args),
      name: stringArg(args, "name"),
    };
    return { structuredContent: await requestJson(token, "POST", "/api/1/partners", body, tool) };
  }

  if (tool === "freee/trial_pl") {
    const qs = queryString(args, ["fiscal_year", "start_month", "end_month", "breakdown_display_type"], { company_id: companyId(args) });
    return { structuredContent: await requestJson(token, "GET", `/api/1/reports/trial_pl${qs}`, undefined, tool) };
  }

  if (tool === "freee/trial_bs") {
    const qs = queryString(args, ["fiscal_year", "start_month", "end_month", "breakdown_display_type"], { company_id: companyId(args) });
    return { structuredContent: await requestJson(token, "GET", `/api/1/reports/trial_bs${qs}`, undefined, tool) };
  }

  throw new Error(`Unknown freee tool: ${tool}`);
}
