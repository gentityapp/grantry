// Granola connector - static API key (grn_...) via Authorization: Bearer.
// Official public API (read-only): https://public-api.granola.ai/v1
//   GET /v1/notes            - list notes (created_before/after, updated_after, folder_id, cursor, page_size)
//   GET /v1/notes/{note_id}  - get a note (include=transcript)
//   GET /v1/folders          - list folders (cursor, page_size)
// Only notes with a generated AI summary + transcript are returned by the API.
const GRANOLA_API = "https://public-api.granola.ai";
const GRANOLA_TIMEOUT_MS = 12_000;

type GranolaArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

async function fetchGranola(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRANOLA_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[granola] request", { path, ...logContext });
    const response = await fetch(`${GRANOLA_API}${path}`, { ...init, signal: controller.signal });
    console.log("[granola] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[granola] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${GRANOLA_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Granola request timed out after ${GRANOLA_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GranolaArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: GranolaArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function requestJson(apiKey: string, method: string, path: string, tool: string) {
  const init: RequestInit = { method, headers: headers(apiKey) };
  const r = await fetchGranola(path, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Granola ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callGranolaTool(tool: string, args: GranolaArgs, apiKey: string) {
  if (tool === "granola/list_notes") {
    const qs = queryString(args, ["created_before", "created_after", "updated_after", "folder_id", "cursor", "page_size"]);
    return { structuredContent: await requestJson(apiKey, "GET", `/v1/notes${qs}`, tool) };
  }

  if (tool === "granola/get_note") {
    const noteId = idArg(args, "note_id", ["id"]);
    const qs = queryString(args, ["include"]);
    return { structuredContent: await requestJson(apiKey, "GET", `/v1/notes/${encodeURIComponent(noteId)}${qs}`, tool) };
  }

  if (tool === "granola/list_folders") {
    const qs = queryString(args, ["cursor", "page_size"]);
    return { structuredContent: await requestJson(apiKey, "GET", `/v1/folders${qs}`, tool) };
  }

  throw new Error(`Unknown Granola tool: ${tool}`);
}
