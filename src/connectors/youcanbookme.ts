// YouCanBook.me connector - Basic auth (account email + account API key).
// The YCBM v1 API rejects Bearer tokens ("caligraph_not_using_basic_authentication");
// credentials travel as Authorization: Basic base64(email:apiKey).
// API key: dashboard My Account > Security. Docs: https://ycbm.stoplight.io/
const YCBM_API = "https://api.youcanbook.me";
const YCBM_TIMEOUT_MS = 15_000;

type YcbmArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let email = "";
  let apiKey = "";
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      email = String(parsed.account_email ?? parsed.accountEmail ?? parsed.email ?? "").trim();
      apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
    }
  } catch {
    // plain "email:apiKey" credential
    const raw = credential.trim();
    const sep = raw.indexOf(":");
    if (sep > 0) {
      email = raw.slice(0, sep).trim();
      apiKey = raw.slice(sep + 1).trim();
    }
  }
  if (!email || !apiKey) {
    throw new Error('YouCanBook.me credential requires {"account_email","api_key"} (Basic auth: email + account API key)');
  }
  return { email, apiKey };
}

function authHeader(credential: string) {
  const { email, apiKey } = parseCredential(credential);
  return `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
}

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchYcbm(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YCBM_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[youcanbookme] request", { path, ...logContext });
    const response = await fetch(`${YCBM_API}${path}`, { ...init, signal: controller.signal });
    console.log("[youcanbookme] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[youcanbookme] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${YCBM_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`YouCanBook.me request timed out after ${YCBM_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  credential: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    Authorization: authHeader(credential),
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchYcbm(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`YouCanBook.me ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: YcbmArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: YcbmArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const raw = String(value ?? "").trim();
  return raw ? raw.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

async function resolveAccountId(credential: string, args: YcbmArgs, tool: string) {
  const provided = optionalArg(args, "account_id", ["accountId"]);
  if (provided) return provided;
  const account: any = await request(credential, "GET", "/v1/account", undefined, tool, { step: "resolve_account_id" });
  const id = String(account?.id ?? "").trim();
  if (!id) throw new Error("could not resolve account_id from /v1/account; pass account_id explicitly");
  return id;
}

export async function callYouCanBookMeTool(tool: string, args: YcbmArgs, credential: string) {
  if (tool === "youcanbookme/get_account") {
    return { structuredContent: await request(credential, "GET", "/v1/account", undefined, tool) };
  }

  if (tool === "youcanbookme/list_profiles") {
    const params = new URLSearchParams();
    const fields = optionalArg(args, "fields");
    if (fields) params.set("fields", fields);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const profiles = await request(credential, "GET", `/v1/profiles${qs}`, undefined, tool);
    return { structuredContent: { profiles } };
  }

  if (tool === "youcanbookme/get_profile") {
    const profileId = requireArg(args, "profile_id", ["profileId", "id"]);
    const params = new URLSearchParams();
    const fields = optionalArg(args, "fields");
    if (fields) params.set("fields", fields);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/v1/profiles/${encodeURIComponent(profileId)}${qs}`, undefined, tool, { profileId }) };
  }

  if (tool === "youcanbookme/query_bookings") {
    const accountId = await resolveAccountId(credential, args, tool);
    const params = new URLSearchParams();
    params.set("from", requireArg(args, "from", ["from_date", "fromDate"]));
    const to = optionalArg(args, "to", ["to_date", "toDate"]);
    if (to) params.set("to", to);
    for (const status of stringList(args.statuses ?? args.status)) params.append("statuses", status);
    for (const pageId of stringList(args.booking_page_ids ?? args.bookingPageIds ?? args.profile_ids)) params.append("bookingPageIds", pageId);
    const searchText = optionalArg(args, "search_text", ["searchText"]);
    if (searchText) {
      params.set("searchText", searchText);
      const criteria = stringList(args.search_text_criteria ?? args.searchTextCriteria);
      for (const c of criteria.length ? criteria : ["title", "form", "ref"]) params.append("searchTextCriteria", c);
    }
    const direction = optionalArg(args, "direction");
    if (direction) params.set("direction", direction);
    const fromBookingId = optionalArg(args, "from_booking_id", ["fromBookingId"]);
    if (fromBookingId) params.set("fromBookingId", fromBookingId);
    const pageSize = Number(args.page_size ?? args.pageSize ?? 0);
    if (pageSize > 0) params.set("pageSize", String(pageSize));
    const bookings = await request(credential, "GET", `/v1/accounts/${encodeURIComponent(accountId)}/bookings/query?${params.toString()}`, undefined, tool, { accountId });
    return { structuredContent: { account_id: accountId, bookings } };
  }

  if (tool === "youcanbookme/get_booking") {
    const bookingId = requireArg(args, "booking_id", ["bookingId", "id"]);
    const params = new URLSearchParams();
    const fields = optionalArg(args, "fields");
    if (fields) params.set("fields", fields);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/v1/bookings/${encodeURIComponent(bookingId)}${qs}`, undefined, tool, { bookingId }) };
  }

  if (tool === "youcanbookme/update_booking") {
    const bookingId = requireArg(args, "booking_id", ["bookingId", "id"]);
    const data = args.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("data must be an object of booking fields to update");
    }
    return { structuredContent: await request(credential, "PATCH", `/v1/bookings/${encodeURIComponent(bookingId)}`, data, tool, { bookingId }) };
  }

  if (tool === "youcanbookme/cancel_booking") {
    const bookingId = requireArg(args, "booking_id", ["bookingId", "id"]);
    const body: Record<string, unknown> = { cancelled: true };
    const reason = optionalArg(args, "reason", ["cancellation_reason", "cancellationReason"]);
    if (reason) body.cancellationReason = reason;
    return { structuredContent: await request(credential, "PATCH", `/v1/bookings/${encodeURIComponent(bookingId)}`, body, tool, { bookingId }) };
  }

  throw new Error(`Unknown YouCanBook.me tool: ${tool}`);
}
