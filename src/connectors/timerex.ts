// TimeRex (ミクステンド) connector - team API key via the x-api-key header.
// 日程調整API beta (https://timerex.net/api/beta). API keys are team-scoped:
// dashboard > チーム設定 > デベロッパーツール > TimeRex 日程調整API. With API-key
// auth, GET /user/me is unavailable (400) and every resource is limited to the
// issuing team; the smoke-test/anchor endpoint is /user/me/teams/primary.
// Docs: https://developers.timerex.net/ja/api/reference/
const TIMEREX_API = "https://timerex.net/api/beta";
const TIMEREX_TIMEOUT_MS = 15_000;

type TimerexArgs = Record<string, unknown>;

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
  if (!apiKey) throw new Error("TimeRex credential requires an api_key");
  return apiKey;
}

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // An invalid API key gets an HTML login redirect instead of JSON.
    if (/<html/i.test(text)) return { raw: "HTML response (likely invalid API key: TimeRex redirects unauthenticated requests to the login page)" };
    return { raw: text.slice(0, 500) };
  }
}

async function fetchTimerex(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEREX_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[timerex] request", { path, ...logContext });
    const response = await fetch(`${TIMEREX_API}${path}`, { ...init, signal: controller.signal, redirect: "manual" });
    console.log("[timerex] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[timerex] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${TIMEREX_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`TimeRex request timed out after ${TIMEREX_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "x-api-key": parseCredential(credential),
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchTimerex(path, init, { tool, ...logContext });
  if (r.status >= 300 && r.status < 400) {
    throw new Error(`TimeRex ${tool} failed: got a redirect (${r.status}) — the API key is likely invalid or lacks access`);
  }
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`TimeRex ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: TimerexArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: TimerexArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

export async function callTimerexTool(tool: string, args: TimerexArgs, credential: string) {
  if (tool === "timerex/get_primary_team") {
    return { structuredContent: await request(credential, "GET", "/user/me/teams/primary", undefined, tool) };
  }

  if (tool === "timerex/list_teams") {
    return { structuredContent: await request(credential, "GET", "/user/me/teams", undefined, tool) };
  }

  if (tool === "timerex/get_team") {
    const teamId = requireArg(args, "team_id", ["teamId", "id"]);
    return { structuredContent: await request(credential, "GET", `/teams/${encodeURIComponent(teamId)}`, undefined, tool, { teamId }) };
  }

  if (tool === "timerex/list_calendars") {
    const teamId = requireArg(args, "team_id", ["teamId"]);
    const params = new URLSearchParams();
    const sortOrder = optionalArg(args, "sort_order", ["sortOrder"]);
    if (sortOrder) params.set("sort_order", sortOrder);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/teams/${encodeURIComponent(teamId)}/calendars${qs}`, undefined, tool, { teamId }) };
  }

  if (tool === "timerex/get_calendar") {
    const calendarId = requireArg(args, "calendar_id", ["calendarId", "id"]);
    return { structuredContent: await request(credential, "GET", `/calendars/${encodeURIComponent(calendarId)}`, undefined, tool, { calendarId }) };
  }

  if (tool === "timerex/list_calendar_events") {
    const calendarId = requireArg(args, "calendar_id", ["calendarId"]);
    const params = new URLSearchParams();
    const startTime = optionalArg(args, "start_time", ["startTime", "from"]);
    if (startTime) params.set("startTime", startTime);
    const endTime = optionalArg(args, "end_time", ["endTime", "to"]);
    if (endTime) params.set("endTime", endTime);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/calendars/${encodeURIComponent(calendarId)}/events${qs}`, undefined, tool, { calendarId }) };
  }

  if (tool === "timerex/get_event") {
    const eventId = requireArg(args, "event_id", ["eventId", "id"]);
    return { structuredContent: await request(credential, "GET", `/events/${encodeURIComponent(eventId)}`, undefined, tool, { eventId }) };
  }

  if (tool === "timerex/cancel_event") {
    const eventId = requireArg(args, "event_id", ["eventId", "id"]);
    const body = (typeof args.data === "object" && args.data !== null && !Array.isArray(args.data)) ? args.data : {};
    return { structuredContent: await request(credential, "POST", `/events/${encodeURIComponent(eventId)}/cancel`, body, tool, { eventId }) };
  }

  if (tool === "timerex/create_one_time_url") {
    const calendarId = requireArg(args, "calendar_id", ["calendarId"]);
    const data = args.data;
    if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) {
      throw new Error("data must be an object (one-time URL options)");
    }
    return { structuredContent: await request(credential, "POST", `/calendars/${encodeURIComponent(calendarId)}/one-time-url`, data ?? {}, tool, { calendarId }) };
  }

  if (tool === "timerex/get_one_time_url") {
    const oneTimeUrlId = requireArg(args, "one_time_url_id", ["oneTimeUrlId", "id"]);
    return { structuredContent: await request(credential, "GET", `/calendars/one-time-url/${encodeURIComponent(oneTimeUrlId)}`, undefined, tool, { oneTimeUrlId }) };
  }

  throw new Error(`Unknown TimeRex tool: ${tool}`);
}
