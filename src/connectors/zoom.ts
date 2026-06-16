// Zoom connector — OAuth 2.0 bearer token (access token issued via the generic
// OAuth flow; Zoom authenticates the confidential client with HTTP Basic auth
// at the token endpoint, like reddit/x). All calls hit the Zoom API v2.
const ZOOM_API = "https://api.zoom.us/v2";
const ZOOM_TIMEOUT_MS = 15_000;

type ZoomArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchZoom(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZOOM_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[zoom] request", { path, ...logContext });
    const response = await fetch(`${ZOOM_API}${path}`, { ...init, signal: controller.signal });
    console.log("[zoom] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[zoom] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${ZOOM_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Zoom request timed out after ${ZOOM_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function strArg(args: ZoomArgs, key: string, aliases: string[] = []): string {
  for (const candidate of [key, ...aliases]) {
    const value = String(args[candidate] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function requireArg(args: ZoomArgs, key: string, aliases: string[] = []): string {
  const value = strArg(args, key, aliases);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function buildQuery(pairs: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// Meeting UUIDs that begin with "/" or contain "//" must be double URL-encoded
// before being used as a path segment, per Zoom's API rules. Plain numeric
// meeting IDs need no special handling.
function encodeMeetingId(raw: string): string {
  const id = raw.trim();
  if (/^\d+$/.test(id)) return id;
  const once = encodeURIComponent(id);
  if (id.startsWith("/") || id.includes("//")) return encodeURIComponent(once);
  return once;
}

async function getJson(token: string, path: string, tool: string) {
  const r = await fetchZoom(path, { method: "GET", headers: authHeaders(token) }, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Zoom ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

async function postJson(token: string, path: string, payload: Record<string, unknown>, tool: string) {
  const r = await fetchZoom(path, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Zoom ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callZoomTool(tool: string, args: ZoomArgs, token: string) {
  // --- Users ---
  if (tool === "zoom/get_me") {
    return { structuredContent: await getJson(token, "/users/me", tool) };
  }

  if (tool === "zoom/list_users") {
    const qs = buildQuery({
      status: args.status,
      page_size: args.page_size,
      next_page_token: args.next_page_token,
      role_id: args.role_id,
    });
    return { structuredContent: await getJson(token, `/users${qs}`, tool) };
  }

  // --- Cloud Recording ---
  if (tool === "zoom/list_recordings") {
    const userId = strArg(args, "user_id", ["userId"]) || "me";
    const qs = buildQuery({
      from: args.from,
      to: args.to,
      page_size: args.page_size,
      next_page_token: args.next_page_token,
      mc: args.mc,
      trash: args.trash,
      trash_type: args.trash_type,
    });
    return { structuredContent: await getJson(token, `/users/${encodeURIComponent(userId)}/recordings${qs}`, tool) };
  }

  if (tool === "zoom/get_meeting_recordings") {
    const meetingId = requireArg(args, "meeting_id", ["meetingId", "meeting_uuid", "uuid"]);
    const qs = buildQuery({ include_fields: args.include_fields, ttl: args.ttl });
    return { structuredContent: await getJson(token, `/meetings/${encodeMeetingId(meetingId)}/recordings${qs}`, tool) };
  }

  // --- Meetings ---
  if (tool === "zoom/list_meetings") {
    const userId = strArg(args, "user_id", ["userId"]) || "me";
    const qs = buildQuery({
      type: args.type, // scheduled | live | upcoming | upcoming_meetings | previous_meetings
      page_size: args.page_size,
      next_page_token: args.next_page_token,
      from: args.from,
      to: args.to,
    });
    return { structuredContent: await getJson(token, `/users/${encodeURIComponent(userId)}/meetings${qs}`, tool) };
  }

  if (tool === "zoom/get_meeting") {
    const meetingId = requireArg(args, "meeting_id", ["meetingId"]);
    const qs = buildQuery({ occurrence_id: args.occurrence_id, show_previous_occurrences: args.show_previous_occurrences });
    return { structuredContent: await getJson(token, `/meetings/${encodeMeetingId(meetingId)}${qs}`, tool) };
  }

  if (tool === "zoom/create_meeting") {
    const userId = strArg(args, "user_id", ["userId"]) || "me";
    const topic = requireArg(args, "topic");
    const payload: Record<string, unknown> = { topic };
    // type: 1 instant, 2 scheduled (default), 3 recurring no fixed time, 8 recurring fixed time
    payload.type = args.type ?? 2;
    for (const k of ["start_time", "duration", "timezone", "agenda", "password", "schedule_for"]) {
      if (args[k] !== undefined && args[k] !== null && args[k] !== "") payload[k] = args[k];
    }
    if (args.settings && typeof args.settings === "object") payload.settings = args.settings;
    if (args.recurrence && typeof args.recurrence === "object") payload.recurrence = args.recurrence;
    return { structuredContent: await postJson(token, `/users/${encodeURIComponent(userId)}/meetings`, payload, tool) };
  }

  // --- Reports / participants ---
  if (tool === "zoom/get_meeting_participants") {
    const meetingId = requireArg(args, "meeting_id", ["meetingId", "meeting_uuid", "uuid"]);
    const qs = buildQuery({
      page_size: args.page_size,
      next_page_token: args.next_page_token,
      include_fields: args.include_fields,
    });
    return { structuredContent: await getJson(token, `/report/meetings/${encodeMeetingId(meetingId)}/participants${qs}`, tool) };
  }

  throw new Error(`Unknown Zoom tool: ${tool}`);
}
