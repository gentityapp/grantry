// tl;dv connector - personal API key via the x-api-key header.
// Public API v1alpha1 (https://pasta.tldv.io/v1alpha1), documented at
// https://doc.tldv.io. API access requires a Pro or Business plan; keys are
// created in tl;dv under Settings > Personal Settings > API Keys.
//   GET  /meetings                        - list meetings (query/page/limit/from/to/onlyParticipated/meetingType)
//   GET  /meetings/{id}                   - meeting metadata
//   GET  /meetings/{id}/transcript        - full transcript (speaker/text/startTime/endTime)
//   GET  /meetings/{id}/notes             - AI notes (markdown + structured notes + topics)
//   GET  /meetings/{id}/highlights        - deprecated, superseded by /notes
//   GET  /meetings/{id}/download          - 302 to a signed, expiring recording URL
//   POST /meetings/import                 - import a recording from a public URL
const TLDV_API = "https://pasta.tldv.io/v1alpha1";
const TLDV_TIMEOUT_MS = 15_000;

type TldvArgs = Record<string, unknown>;

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
  if (!apiKey) throw new Error("tl;dv credential requires an api_key");
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

async function fetchTldv(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TLDV_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[tldv] request", { path, ...logContext });
    const response = await fetch(`${TLDV_API}${path}`, { ...init, signal: controller.signal });
    console.log("[tldv] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[tldv] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${TLDV_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`tl;dv request timed out after ${TLDV_TIMEOUT_MS}ms`);
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
  const r = await fetchTldv(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`tl;dv ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function requireArg(args: TldvArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optionalArg(args: TldvArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const raw = args[key];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "boolean" ? String(raw) : String(raw).trim();
    if (value) return value;
  }
  return "";
}

export async function callTldvTool(tool: string, args: TldvArgs, credential: string) {
  if (tool === "tldv/list_meetings") {
    const params = new URLSearchParams();
    // tl;dv reads camelCase query params; snake_case aliases are accepted here.
    const mapping: Array<[string, string, string[]]> = [
      ["query", "query", ["search"]],
      ["page", "page", []],
      ["limit", "limit", ["page_size", "pageSize"]],
      ["from", "from", ["start", "from_date"]],
      ["to", "to", ["end", "to_date"]],
      ["onlyParticipated", "only_participated", ["onlyParticipated"]],
      ["meetingType", "meeting_type", ["meetingType"]],
    ];
    for (const [param, snake, aliases] of mapping) {
      const value = optionalArg(args, snake, aliases);
      if (value) params.set(param, value);
    }
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(credential, "GET", `/meetings${qs}`, undefined, tool) };
  }

  if (tool === "tldv/get_meeting") {
    const meetingId = requireArg(args, "meeting_id", ["meetingId", "id"]);
    return { structuredContent: await request(credential, "GET", `/meetings/${encodeURIComponent(meetingId)}`, undefined, tool, { meetingId }) };
  }

  if (tool === "tldv/get_transcript") {
    const meetingId = requireArg(args, "meeting_id", ["meetingId", "id"]);
    return { structuredContent: await request(credential, "GET", `/meetings/${encodeURIComponent(meetingId)}/transcript`, undefined, tool, { meetingId }) };
  }

  if (tool === "tldv/get_notes") {
    const meetingId = requireArg(args, "meeting_id", ["meetingId", "id"]);
    return { structuredContent: await request(credential, "GET", `/meetings/${encodeURIComponent(meetingId)}/notes`, undefined, tool, { meetingId }) };
  }

  if (tool === "tldv/get_highlights") {
    const meetingId = requireArg(args, "meeting_id", ["meetingId", "id"]);
    return { structuredContent: await request(credential, "GET", `/meetings/${encodeURIComponent(meetingId)}/highlights`, undefined, tool, { meetingId }) };
  }

  if (tool === "tldv/get_download_url") {
    // The endpoint answers 302 with a signed, expiring URL in Location. Following
    // it here would stream the recording through this service, so the redirect is
    // read manually and the URL handed back to the caller.
    const meetingId = requireArg(args, "meeting_id", ["meetingId", "id"]);
    const path = `/meetings/${encodeURIComponent(meetingId)}/download`;
    const r = await fetchTldv(path, {
      method: "GET",
      headers: { "x-api-key": parseCredential(credential), Accept: "application/json" },
      redirect: "manual",
    }, { tool, meetingId });
    const location = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && location) {
      return { structuredContent: { meetingId, url: location, status: r.status } };
    }
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`tl;dv ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { meetingId, ...j } };
  }

  if (tool === "tldv/import_meeting") {
    const url = requireArg(args, "url", ["media_url", "mediaUrl"]);
    const extra = (typeof args.data === "object" && args.data !== null && !Array.isArray(args.data)) ? args.data as Record<string, unknown> : {};
    const name = optionalArg(args, "name", ["title"]);
    const body: Record<string, unknown> = { ...extra, url };
    if (name) body.name = name;
    return { structuredContent: await request(credential, "POST", "/meetings/import", body, tool) };
  }

  throw new Error(`Unknown tl;dv tool: ${tool}`);
}
