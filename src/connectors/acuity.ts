// Acuity Scheduling (Squarespace Scheduling) connector - HTTP Basic auth
// with the numeric User ID as username and the API key as password.
// API v1 (https://acuityscheduling.com/api/v1). Credentials: Acuity
// dashboard > Integrations > API.
const ACUITY_API = "https://acuityscheduling.com/api/v1";
const ACUITY_TIMEOUT_MS = 15_000;

type AcuityArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let userId = "";
  let apiKey = "";
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      userId = String(parsed.user_id ?? parsed.userId ?? "").trim();
      apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
    }
  } catch {
    // plain "userId:apiKey" credential
    const raw = credential.trim();
    const sep = raw.indexOf(":");
    if (sep > 0) {
      userId = raw.slice(0, sep).trim();
      apiKey = raw.slice(sep + 1).trim();
    }
  }
  if (!userId || !apiKey) {
    throw new Error('Acuity credential requires {"user_id","api_key"} (Basic auth: numeric User ID + API key from Integrations > API)');
  }
  return { userId, apiKey };
}

function authHeader(credential: string) {
  const { userId, apiKey } = parseCredential(credential);
  return `Basic ${Buffer.from(`${userId}:${apiKey}`).toString("base64")}`;
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

async function fetchAcuity(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACUITY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[acuity] request", { path, ...logContext });
    const response = await fetch(`${ACUITY_API}${path}`, { ...init, signal: controller.signal });
    console.log("[acuity] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[acuity] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${ACUITY_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Acuity request timed out after ${ACUITY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    Authorization: authHeader(credential),
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchAcuity(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Acuity ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: AcuityArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: AcuityArgs, snake: string, aliases: string[] = []) {
  try {
    return requireArg(args, snake, aliases);
  } catch {
    return "";
  }
}

export async function callAcuityTool(tool: string, args: AcuityArgs, credential: string) {
  if (tool === "acuity/get_me") {
    return { structuredContent: await request(credential, "GET", "/me", undefined, tool) };
  }

  if (tool === "acuity/list_calendars") {
    const calendars = await request(credential, "GET", "/calendars", undefined, tool);
    return { structuredContent: { calendars } };
  }

  if (tool === "acuity/list_appointment_types") {
    const params = new URLSearchParams();
    if (args.include_deleted !== undefined) params.set("includeDeleted", String(Boolean(args.include_deleted ?? args.includeDeleted)));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const appointmentTypes = await request(credential, "GET", `/appointment-types${qs}`, undefined, tool);
    return { structuredContent: { appointment_types: appointmentTypes } };
  }

  if (tool === "acuity/list_appointments") {
    const params = new URLSearchParams();
    const minDate = optionalArg(args, "min_date", ["minDate", "from"]);
    if (minDate) params.set("minDate", minDate);
    const maxDate = optionalArg(args, "max_date", ["maxDate", "to"]);
    if (maxDate) params.set("maxDate", maxDate);
    const calendarId = optionalArg(args, "calendar_id", ["calendarID", "calendarId"]);
    if (calendarId) params.set("calendarID", calendarId);
    const appointmentTypeId = optionalArg(args, "appointment_type_id", ["appointmentTypeID", "appointmentTypeId"]);
    if (appointmentTypeId) params.set("appointmentTypeID", appointmentTypeId);
    const email = optionalArg(args, "email");
    if (email) params.set("email", email);
    const firstName = optionalArg(args, "first_name", ["firstName"]);
    if (firstName) params.set("firstName", firstName);
    const lastName = optionalArg(args, "last_name", ["lastName"]);
    if (lastName) params.set("lastName", lastName);
    if (args.canceled !== undefined || args.cancelled !== undefined) params.set("canceled", String(Boolean(args.canceled ?? args.cancelled)));
    const max = Number(args.max ?? args.limit ?? 0);
    if (max > 0) params.set("max", String(max));
    const direction = optionalArg(args, "direction");
    if (direction) params.set("direction", direction);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const appointments = await request(credential, "GET", `/appointments${qs}`, undefined, tool);
    return { structuredContent: { appointments } };
  }

  if (tool === "acuity/get_appointment") {
    const appointmentId = requireArg(args, "appointment_id", ["appointmentId", "id"]);
    return { structuredContent: await request(credential, "GET", `/appointments/${encodeURIComponent(appointmentId)}`, undefined, tool, { appointmentId }) };
  }

  if (tool === "acuity/list_availability_times") {
    const params = new URLSearchParams();
    params.set("date", requireArg(args, "date"));
    params.set("appointmentTypeID", requireArg(args, "appointment_type_id", ["appointmentTypeID", "appointmentTypeId"]));
    const calendarId = optionalArg(args, "calendar_id", ["calendarID", "calendarId"]);
    if (calendarId) params.set("calendarID", calendarId);
    const timezone = optionalArg(args, "timezone");
    if (timezone) params.set("timezone", timezone);
    const times = await request(credential, "GET", `/availability/times?${params.toString()}`, undefined, tool);
    return { structuredContent: { times } };
  }

  if (tool === "acuity/cancel_appointment") {
    const appointmentId = requireArg(args, "appointment_id", ["appointmentId", "id"]);
    const params = new URLSearchParams();
    if (args.no_email !== undefined || args.noEmail !== undefined) params.set("noEmail", String(Boolean(args.no_email ?? args.noEmail)));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const body: Record<string, unknown> = {};
    const reason = optionalArg(args, "reason", ["cancel_note", "cancelNote"]);
    if (reason) body.cancelNote = reason;
    return { structuredContent: await request(credential, "PUT", `/appointments/${encodeURIComponent(appointmentId)}/cancel${qs}`, body, tool, { appointmentId }) };
  }

  throw new Error(`Unknown Acuity tool: ${tool}`);
}
