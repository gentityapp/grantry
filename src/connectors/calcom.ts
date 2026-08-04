// Cal.com connector - API key (cal_live_...) via Authorization: Bearer.
// API v2 (https://api.cal.com/v2) requires a cal-api-version header on
// versioned endpoints; 2024-08-13 is the current bookings contract.
// API key: Cal.com Settings > Security > API keys.
const CALCOM_API = "https://api.cal.com";
const CALCOM_BOOKINGS_VERSION = "2024-08-13";
const CALCOM_TIMEOUT_MS = 15_000;

type CalcomArgs = Record<string, unknown>;

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
  if (!apiKey) throw new Error("Cal.com credential requires an api_key");
  return apiKey;
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

async function fetchCalcom(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALCOM_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[calcom] request", { path, ...logContext });
    const response = await fetch(`${CALCOM_API}${path}`, { ...init, signal: controller.signal });
    console.log("[calcom] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[calcom] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${CALCOM_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Cal.com request timed out after ${CALCOM_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  token: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  options: { apiVersion?: string; logContext?: Record<string, unknown> } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${parseCredential(token)}`,
    Accept: "application/json",
  };
  if (options.apiVersion) headers["cal-api-version"] = options.apiVersion;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchCalcom(path, init, { tool, ...(options.logContext ?? {}) });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Cal.com ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: CalcomArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: CalcomArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

export async function callCalcomTool(tool: string, args: CalcomArgs, token: string) {
  if (tool === "calcom/get_me") {
    return { structuredContent: await request(token, "GET", "/v2/me", undefined, tool) };
  }

  if (tool === "calcom/list_event_types") {
    const params = new URLSearchParams();
    const username = optionalArg(args, "username");
    if (username) params.set("username", username);
    const eventSlug = optionalArg(args, "event_slug", ["eventSlug"]);
    if (eventSlug) params.set("eventSlug", eventSlug);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(token, "GET", `/v2/event-types${qs}`, undefined, tool, { apiVersion: "2024-06-14" }) };
  }

  if (tool === "calcom/list_schedules") {
    return { structuredContent: await request(token, "GET", "/v2/schedules", undefined, tool, { apiVersion: "2024-06-11" }) };
  }

  if (tool === "calcom/list_bookings") {
    const params = new URLSearchParams();
    const status = optionalArg(args, "status");
    if (status) params.set("status", status);
    const attendeeEmail = optionalArg(args, "attendee_email", ["attendeeEmail"]);
    if (attendeeEmail) params.set("attendeeEmail", attendeeEmail);
    const attendeeName = optionalArg(args, "attendee_name", ["attendeeName"]);
    if (attendeeName) params.set("attendeeName", attendeeName);
    const afterStart = optionalArg(args, "after_start", ["afterStart", "from"]);
    if (afterStart) params.set("afterStart", afterStart);
    const beforeEnd = optionalArg(args, "before_end", ["beforeEnd", "to"]);
    if (beforeEnd) params.set("beforeEnd", beforeEnd);
    const eventTypeId = optionalArg(args, "event_type_id", ["eventTypeId"]);
    if (eventTypeId) params.set("eventTypeId", eventTypeId);
    const sortStart = optionalArg(args, "sort_start", ["sortStart"]);
    if (sortStart) params.set("sortStart", sortStart);
    const take = Number(args.take ?? args.limit ?? 0);
    if (take > 0) params.set("take", String(take));
    const skip = Number(args.skip ?? args.offset ?? 0);
    if (skip > 0) params.set("skip", String(skip));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(token, "GET", `/v2/bookings${qs}`, undefined, tool, { apiVersion: CALCOM_BOOKINGS_VERSION }) };
  }

  if (tool === "calcom/get_booking") {
    const uid = requireArg(args, "booking_uid", ["bookingUid", "uid", "id"]);
    return { structuredContent: await request(token, "GET", `/v2/bookings/${encodeURIComponent(uid)}`, undefined, tool, { apiVersion: CALCOM_BOOKINGS_VERSION, logContext: { uid } }) };
  }

  if (tool === "calcom/cancel_booking") {
    const uid = requireArg(args, "booking_uid", ["bookingUid", "uid", "id"]);
    const body: Record<string, unknown> = {};
    const reason = optionalArg(args, "reason", ["cancellation_reason", "cancellationReason"]);
    if (reason) body.cancellationReason = reason;
    return { structuredContent: await request(token, "POST", `/v2/bookings/${encodeURIComponent(uid)}/cancel`, body, tool, { apiVersion: CALCOM_BOOKINGS_VERSION, logContext: { uid } }) };
  }

  throw new Error(`Unknown Cal.com tool: ${tool}`);
}
