// Google Slides connector - OAuth access token via Authorization: Bearer.
// Targets the Google Slides API v1.
const GSLIDES_API = "https://slides.googleapis.com/v1";
const GSLIDES_TIMEOUT_MS = 12_000;

type GSlidesArgs = Record<string, unknown>;

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

async function fetchGSlides(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GSLIDES_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_slides] request", { path, ...logContext });
    const response = await fetch(`${GSLIDES_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_slides] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_slides] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${GSLIDES_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Google Slides request timed out after ${GSLIDES_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GSlidesArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function request(accessToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchGSlides(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Slides ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callGoogleSlidesTool(tool: string, args: GSlidesArgs, accessToken: string) {
  if (tool === "google_slides/get_presentation") {
    const presentationId = idArg(args, "presentation_id", ["presentationId"]);
    return { structuredContent: await request(accessToken, "GET", `/presentations/${encodeURIComponent(presentationId)}`, undefined, tool, { presentationId }) };
  }

  if (tool === "google_slides/get_page") {
    const presentationId = idArg(args, "presentation_id", ["presentationId"]);
    const pageObjectId = idArg(args, "page_object_id", ["pageObjectId"]);
    return { structuredContent: await request(accessToken, "GET", `/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}`, undefined, tool, { presentationId, pageObjectId }) };
  }

  if (tool === "google_slides/get_page_thumbnail") {
    const presentationId = idArg(args, "presentation_id", ["presentationId"]);
    const pageObjectId = idArg(args, "page_object_id", ["pageObjectId"]);
    const size = String(args.thumbnail_size ?? args.thumbnailSize ?? "").trim();
    const params = new URLSearchParams();
    if (size) params.set("thumbnailProperties.thumbnailSize", size);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}/thumbnail${qs}`, undefined, tool, { presentationId, pageObjectId }) };
  }

  if (tool === "google_slides/create_presentation") {
    const title = idArg(args, "title");
    return { structuredContent: await request(accessToken, "POST", "/presentations", { title }, tool) };
  }

  if (tool === "google_slides/batch_update") {
    const presentationId = idArg(args, "presentation_id", ["presentationId"]);
    const requests = args.requests;
    if (!Array.isArray(requests) || !requests.length) throw new Error("requests (non-empty array of Slides batchUpdate request objects) is required");
    const body: Record<string, unknown> = { requests };
    if (args.write_control ?? args.writeControl) body.writeControl = args.write_control ?? args.writeControl;
    return { structuredContent: await request(accessToken, "POST", `/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, body, tool, { presentationId, requestCount: requests.length }) };
  }

  throw new Error(`Unknown Google Slides tool: ${tool}`);
}
