// Calendly connector - Personal Access Token via Authorization: Bearer.
// API v2 (https://api.calendly.com). Resources are addressed by full URIs
// (e.g. https://api.calendly.com/users/XXXX); list endpoints require a
// user= or organization= URI, which we auto-resolve from /users/me.
// PAT: Calendly dashboard > Integrations & apps > API & webhooks.
const CALENDLY_API = "https://api.calendly.com";
const CALENDLY_TIMEOUT_MS = 15_000;

type CalendlyArgs = Record<string, unknown>;

function headers(token: string) {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: "application/json",
  } as Record<string, string>;
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

async function fetchCalendly(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALENDLY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[calendly] request", { path, ...logContext });
    const response = await fetch(`${CALENDLY_API}${path}`, { ...init, signal: controller.signal });
    console.log("[calendly] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[calendly] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${CALENDLY_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Calendly request timed out after ${CALENDLY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(token: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const h = headers(token);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchCalendly(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Calendly ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: CalendlyArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: CalendlyArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

/** Accept either a bare uuid or a full Calendly resource URI. */
function eventUuid(value: string) {
  const m = value.match(/scheduled_events\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : value;
}

async function resolveOwnerParams(token: string, args: CalendlyArgs, tool: string): Promise<Record<string, string>> {
  const user = optionalArg(args, "user", ["user_uri", "userUri"]);
  const organization = optionalArg(args, "organization", ["organization_uri", "organizationUri"]);
  if (user) return { user };
  if (organization) return { organization };
  const me: any = await request(token, "GET", "/users/me", undefined, tool, { step: "resolve_owner" });
  const uri = String(me?.resource?.uri ?? "").trim();
  if (!uri) throw new Error("could not resolve current user URI from /users/me; pass user or organization explicitly");
  return { user: uri };
}

export async function callCalendlyTool(tool: string, args: CalendlyArgs, token: string) {
  if (tool === "calendly/get_me") {
    return { structuredContent: await request(token, "GET", "/users/me", undefined, tool) };
  }

  if (tool === "calendly/list_event_types") {
    const params = new URLSearchParams(await resolveOwnerParams(token, args, tool));
    const active = args.active;
    if (active !== undefined) params.set("active", String(Boolean(active)));
    const count = Number(args.count ?? 0);
    if (count > 0) params.set("count", String(count));
    const pageToken = optionalArg(args, "page_token", ["pageToken"]);
    if (pageToken) params.set("page_token", pageToken);
    return { structuredContent: await request(token, "GET", `/event_types?${params.toString()}`, undefined, tool) };
  }

  if (tool === "calendly/list_events") {
    const params = new URLSearchParams(await resolveOwnerParams(token, args, tool));
    const minStart = optionalArg(args, "min_start_time", ["minStartTime", "from"]);
    if (minStart) params.set("min_start_time", minStart);
    const maxStart = optionalArg(args, "max_start_time", ["maxStartTime", "to"]);
    if (maxStart) params.set("max_start_time", maxStart);
    const status = optionalArg(args, "status");
    if (status) params.set("status", status);
    const inviteeEmail = optionalArg(args, "invitee_email", ["inviteeEmail"]);
    if (inviteeEmail) params.set("invitee_email", inviteeEmail);
    const sort = optionalArg(args, "sort");
    if (sort) params.set("sort", sort);
    const count = Number(args.count ?? 0);
    if (count > 0) params.set("count", String(count));
    const pageToken = optionalArg(args, "page_token", ["pageToken"]);
    if (pageToken) params.set("page_token", pageToken);
    return { structuredContent: await request(token, "GET", `/scheduled_events?${params.toString()}`, undefined, tool) };
  }

  if (tool === "calendly/get_event") {
    const uuid = eventUuid(requireArg(args, "event_uuid", ["eventUuid", "uuid", "event_uri", "eventUri", "id"]));
    return { structuredContent: await request(token, "GET", `/scheduled_events/${encodeURIComponent(uuid)}`, undefined, tool, { uuid }) };
  }

  if (tool === "calendly/list_invitees") {
    const uuid = eventUuid(requireArg(args, "event_uuid", ["eventUuid", "uuid", "event_uri", "eventUri", "id"]));
    const params = new URLSearchParams();
    const status = optionalArg(args, "status");
    if (status) params.set("status", status);
    const email = optionalArg(args, "email");
    if (email) params.set("email", email);
    const count = Number(args.count ?? 0);
    if (count > 0) params.set("count", String(count));
    const pageToken = optionalArg(args, "page_token", ["pageToken"]);
    if (pageToken) params.set("page_token", pageToken);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(token, "GET", `/scheduled_events/${encodeURIComponent(uuid)}/invitees${qs}`, undefined, tool, { uuid }) };
  }

  if (tool === "calendly/cancel_event") {
    const uuid = eventUuid(requireArg(args, "event_uuid", ["eventUuid", "uuid", "event_uri", "eventUri", "id"]));
    const body: Record<string, unknown> = {};
    const reason = optionalArg(args, "reason", ["cancellation_reason", "cancellationReason"]);
    if (reason) body.reason = reason;
    return { structuredContent: await request(token, "POST", `/scheduled_events/${encodeURIComponent(uuid)}/cancellation`, body, tool, { uuid }) };
  }

  throw new Error(`Unknown Calendly tool: ${tool}`);
}
