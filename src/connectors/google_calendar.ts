// Google Calendar connector - OAuth access token via Authorization: Bearer.
// Targets the Google Calendar API v3.
const GCAL_API = "https://www.googleapis.com/calendar/v3";
const GCAL_TIMEOUT_MS = 12_000;

type GCalArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(accessToken: string, json = false) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchGCal(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GCAL_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_calendar] request", { path, ...logContext });
    const response = await fetch(`${GCAL_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_calendar] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_calendar] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${GCAL_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Google Calendar request timed out after ${GCAL_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GCalArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: GCalArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function jsonBody(args: GCalArgs, requiredKeys: string[], optionalKeys: string[] = []) {
  const body: Record<string, unknown> = {};
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") {
      if (requiredKeys.includes(key)) throw new Error(`${key} is required`);
      continue;
    }
    body[key] = value;
  }
  return body;
}

async function request(accessToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchGCal(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Calendar ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callGoogleCalendarTool(tool: string, args: GCalArgs, accessToken: string) {
  if (tool === "google_calendar/list_calendars") {
    return { structuredContent: await request(accessToken, "GET", "/users/me/calendarList", undefined, tool) };
  }

  if (tool === "google_calendar/list_events") {
    const calendarId = idArg(args, "calendar_id", ["calendarId"]);
    const qs = queryString(args, ["time_min", "timeMin", "time_max", "timeMax", "q", "max_results", "maxResults", "single_events", "singleEvents", "order_by", "orderBy", "page_token", "pageToken"]);
    return { structuredContent: await request(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}/events${qs}`, undefined, tool, { calendarId }) };
  }

  if (tool === "google_calendar/get_event") {
    const calendarId = idArg(args, "calendar_id", ["calendarId"]);
    const eventId = idArg(args, "event_id", ["eventId"]);
    return { structuredContent: await request(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, undefined, tool, { calendarId, eventId }) };
  }

  if (tool === "google_calendar/create_event") {
    const calendarId = idArg(args, "calendar_id", ["calendarId"]);
    const body = jsonBody(args, ["start", "end"], ["summary", "description", "location", "attendees", "reminders", "recurrence", "conferenceData", "colorId", "visibility"]);
    const qs = queryString(args, ["send_updates", "sendUpdates", "conference_data_version", "conferenceDataVersion"]);
    return { structuredContent: await request(accessToken, "POST", `/calendars/${encodeURIComponent(calendarId)}/events${qs}`, body, tool, { calendarId }) };
  }

  if (tool === "google_calendar/update_event") {
    const calendarId = idArg(args, "calendar_id", ["calendarId"]);
    const eventId = idArg(args, "event_id", ["eventId"]);
    const body = jsonBody(args, [], ["summary", "description", "location", "start", "end", "attendees", "reminders", "recurrence", "colorId", "visibility", "status"]);
    const qs = queryString(args, ["send_updates", "sendUpdates"]);
    return { structuredContent: await request(accessToken, "PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${qs}`, body, tool, { calendarId, eventId }) };
  }

  if (tool === "google_calendar/delete_event") {
    const calendarId = idArg(args, "calendar_id", ["calendarId"]);
    const eventId = idArg(args, "event_id", ["eventId"]);
    const qs = queryString(args, ["send_updates", "sendUpdates"]);
    await request(accessToken, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${qs}`, undefined, tool, { calendarId, eventId });
    return { structuredContent: { deleted: true, calendar_id: calendarId, event_id: eventId } };
  }

  throw new Error(`Unknown Google Calendar tool: ${tool}`);
}
