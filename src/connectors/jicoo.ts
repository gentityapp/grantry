// Jicoo (ジクー) connector - API key via the x-jicoo-api-key header.
// REST API v1 (https://api.jicoo.com/v1), available on all plans.
// API keys are issued in the Jicoo dashboard (developer settings).
// Docs: https://developer.jicoo.com/
const JICOO_API = "https://api.jicoo.com";
const JICOO_TIMEOUT_MS = 15_000;

type JicooArgs = Record<string, unknown>;

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
  if (!apiKey) throw new Error("Jicoo credential requires an api_key");
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

async function fetchJicoo(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JICOO_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[jicoo] request", { path, ...logContext });
    const response = await fetch(`${JICOO_API}${path}`, { ...init, signal: controller.signal });
    console.log("[jicoo] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[jicoo] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${JICOO_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Jicoo request timed out after ${JICOO_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "x-jicoo-api-key": parseCredential(credential),
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchJicoo(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Jicoo ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: JicooArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: JicooArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

export async function callJicooTool(tool: string, args: JicooArgs, credential: string) {
  if (tool === "jicoo/get_me") {
    return { structuredContent: await request(credential, "GET", "/v1/users/me", undefined, tool) };
  }

  if (tool === "jicoo/list_teams") {
    return { structuredContent: await request(credential, "GET", "/v1/teams", undefined, tool) };
  }

  if (tool === "jicoo/list_event_types") {
    const params = new URLSearchParams();
    const teamId = optionalArg(args, "team_id", ["teamId"]);
    if (teamId) params.set("teamId", teamId);
    const page = Number(args.page ?? 0);
    if (page > 0) params.set("page", String(page));
    const perPage = Number(args.per_page ?? args.perPage ?? 0);
    if (perPage > 0) params.set("perPage", String(perPage));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/v1/event_types${qs}`, undefined, tool) };
  }

  if (tool === "jicoo/get_event_type") {
    const eventTypeId = requireArg(args, "event_type_id", ["eventTypeId", "id"]);
    return { structuredContent: await request(credential, "GET", `/v1/event_types/${encodeURIComponent(eventTypeId)}`, undefined, tool, { eventTypeId }) };
  }

  if (tool === "jicoo/list_available_schedules") {
    const eventTypeId = requireArg(args, "event_type_id", ["eventTypeId", "id"]);
    const params = new URLSearchParams();
    const startedAt = optionalArg(args, "started_at", ["startedAt", "from"]);
    if (startedAt) params.set("startedAt", startedAt);
    const endedAt = optionalArg(args, "ended_at", ["endedAt", "to"]);
    if (endedAt) params.set("endedAt", endedAt);
    const timezone = optionalArg(args, "timezone", ["timeZone"]);
    if (timezone) params.set("timeZone", timezone);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/v1/event_types/${encodeURIComponent(eventTypeId)}/available_schedules${qs}`, undefined, tool, { eventTypeId }) };
  }

  if (tool === "jicoo/list_bookings") {
    const params = new URLSearchParams();
    const status = optionalArg(args, "status");
    if (status) params.set("status", status);
    const startedAt = optionalArg(args, "started_at", ["startedAt", "from"]);
    if (startedAt) params.set("startedAt", startedAt);
    const endedAt = optionalArg(args, "ended_at", ["endedAt", "to"]);
    if (endedAt) params.set("endedAt", endedAt);
    const sort = optionalArg(args, "sort");
    if (sort) params.set("sort", sort);
    const order = optionalArg(args, "order");
    if (order) params.set("order", order);
    const page = Number(args.page ?? 0);
    if (page > 0) params.set("page", String(page));
    const perPage = Number(args.per_page ?? args.perPage ?? args.limit ?? 0);
    if (perPage > 0) params.set("perPage", String(perPage));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/v1/bookings${qs}`, undefined, tool) };
  }

  if (tool === "jicoo/get_booking") {
    const bookingId = requireArg(args, "booking_id", ["bookingId", "id"]);
    return { structuredContent: await request(credential, "GET", `/v1/bookings/${encodeURIComponent(bookingId)}`, undefined, tool, { bookingId }) };
  }

  if (tool === "jicoo/update_booking") {
    const bookingId = requireArg(args, "booking_id", ["bookingId", "id"]);
    const data = args.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("data must be an object of booking fields to update");
    }
    return { structuredContent: await request(credential, "PATCH", `/v1/bookings/${encodeURIComponent(bookingId)}`, data, tool, { bookingId }) };
  }

  if (tool === "jicoo/cancel_booking") {
    const bookingId = requireArg(args, "booking_id", ["bookingId", "id"]);
    const body: Record<string, unknown> = {};
    const reason = optionalArg(args, "reason", ["cancellation_reason", "cancellationReason"]);
    if (reason) body.reason = reason;
    return { structuredContent: await request(credential, "POST", `/v1/bookings/${encodeURIComponent(bookingId)}/cancel`, body, tool, { bookingId }) };
  }

  throw new Error(`Unknown Jicoo tool: ${tool}`);
}
