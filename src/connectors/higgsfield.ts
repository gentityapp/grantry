// Higgsfield connector - AI image/video generation via the Higgsfield platform.
// API key authentication: the credential is KEY_ID:KEY_SECRET, sent as
//   Authorization: Key {KEY_ID}:{KEY_SECRET}
// against https://platform.higgsfield.ai. Docs: https://docs.higgsfield.ai
//
// Higgsfield uses an asynchronous queue: POST /{model_id} enqueues a request and
// returns a request_id + status_url. The job is then polled at
// GET /requests/{request_id}/status until it reaches a terminal state
// (completed | failed | nsfw). generate_image / generate_video submit and poll
// to completion within a bounded window; if the job is still running when the
// window elapses (video jobs can take minutes) they return the request_id so the
// caller can finish polling with higgsfield/get_request.
const HIGGSFIELD_API = "https://platform.higgsfield.ai";
const REQUEST_TIMEOUT_MS = 30_000; // per HTTP call
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_WAIT_MS = 120_000; // total time we block waiting for a job

// Default models (overridable via model_id). See the Models Gallery at
// https://cloud.higgsfield.ai for the full catalog.
const DEFAULT_IMAGE_MODEL = "higgsfield-ai/soul/standard";
const DEFAULT_VIDEO_MODEL = "higgsfield-ai/dop/standard";

const TERMINAL_STATUSES = new Set(["completed", "failed", "nsfw"]);

type HiggsfieldArgs = Record<string, unknown>;

function parseCredential(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("Higgsfield credential is required (KEY_ID:KEY_SECRET)");
  if (!trimmed.includes(":")) {
    throw new Error("Higgsfield credential must be in KEY_ID:KEY_SECRET format");
  }
  return trimmed;
}

function headers(credential: string): Record<string, string> {
  return {
    Authorization: `Key ${credential}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
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

async function request(
  credential: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[higgsfield] request", { path, tool, method });
    const init: RequestInit = { method, headers: headers(credential), signal: controller.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${HIGGSFIELD_API}${path}`, init);
    console.log("[higgsfield] response", { path, tool, status: r.status, durationMs: Date.now() - started });
    const j: any = await readJsonResponse(r);
    if (!r.ok) {
      const message = j?.detail ?? j?.error?.message ?? j?.error ?? j?.message ?? JSON.stringify(j).slice(0, 1000);
      throw new Error(`Higgsfield ${tool} failed: ${r.status} ${typeof message === "string" ? message : JSON.stringify(message)}`);
    }
    return j;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`Higgsfield request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Assemble the generation request body. Well-known fields are lifted to the top
// level for convenience; any additional model-specific parameters can be passed
// through the `params` object (models on the platform accept different fields).
function buildBody(args: HiggsfieldArgs, opts: { requirePrompt?: boolean } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const params = args.params && typeof args.params === "object" ? { ...(args.params as object) } : {};
  Object.assign(body, params);

  const prompt = args.prompt !== undefined && args.prompt !== null ? String(args.prompt).trim() : "";
  if (prompt) body.prompt = prompt;
  if (opts.requirePrompt && !prompt && !("prompt" in body)) throw new Error("prompt is required");

  if (args.image_url) body.image_url = String(args.image_url).trim();
  if (Array.isArray(args.reference_image_urls)) body.reference_image_urls = args.reference_image_urls;
  if (args.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio).trim();
  if (args.resolution) body.resolution = String(args.resolution).trim();
  if (args.duration !== undefined && args.duration !== null && args.duration !== "") body.duration = Number(args.duration);
  if (args.seed !== undefined && args.seed !== null && args.seed !== "") body.seed = Number(args.seed);

  return body;
}

function modelPath(args: HiggsfieldArgs, fallback: string): string {
  const modelId = String(args.model_id ?? fallback).trim() || fallback;
  return `/${modelId.replace(/^\/+/, "")}`;
}

function summarize(json: any) {
  const images = Array.isArray(json?.images) ? json.images : undefined;
  const video = json?.video ?? undefined;
  const notes: string[] = [];
  if (json?.status && !TERMINAL_STATUSES.has(json.status)) {
    notes.push(
      `Job is still ${json.status}. Poll higgsfield/get_request with request_id "${json.request_id}" until status is "completed" (or "failed"/"nsfw").`,
    );
  }
  if (json?.status === "nsfw") notes.push("Content failed moderation (nsfw); credits were refunded.");
  if (json?.status === "failed") notes.push("Generation failed; credits were refunded.");
  return {
    status: json?.status,
    request_id: json?.request_id,
    status_url: json?.status_url,
    cancel_url: json?.cancel_url,
    ...(images ? { images } : {}),
    ...(video ? { video } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

// Submit a generation and poll to a terminal state within POLL_MAX_WAIT_MS.
// Returns the last-seen status payload (already terminal, or still running if the
// window elapsed).
async function submitAndPoll(
  credential: string,
  path: string,
  body: Record<string, unknown>,
  tool: string,
) {
  let json: any = await request(credential, "POST", path, body, tool);
  let requestId: string | undefined = json?.request_id;

  // Some models may return a terminal result inline on submit.
  if (json?.status && TERMINAL_STATUSES.has(json.status)) return json;
  if (!requestId) return json;

  const deadline = Date.now() + POLL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    json = await request(credential, "GET", `/requests/${requestId}/status`, undefined, `${tool} (poll)`);
    if (json?.status && TERMINAL_STATUSES.has(json.status)) return json;
  }
  return json;
}

export async function callHiggsfieldTool(
  tool: string,
  args: HiggsfieldArgs,
  rawCredential: string,
) {
  const credential = parseCredential(rawCredential);

  if (tool === "higgsfield/generate_image") {
    const body = buildBody(args, { requirePrompt: true });
    const path = modelPath(args, DEFAULT_IMAGE_MODEL);
    const json = await submitAndPoll(credential, path, body, tool);
    return { structuredContent: summarize(json) };
  }

  if (tool === "higgsfield/generate_video") {
    const body = buildBody(args);
    if (!body.prompt && !body.image_url) {
      throw new Error("higgsfield/generate_video requires a prompt (text-to-video) and/or image_url (image-to-video)");
    }
    const path = modelPath(args, DEFAULT_VIDEO_MODEL);
    const json = await submitAndPoll(credential, path, body, tool);
    return { structuredContent: summarize(json) };
  }

  if (tool === "higgsfield/get_request") {
    const requestId = String(args.request_id ?? "").trim();
    if (!requestId) throw new Error("request_id is required");
    const json = await request(credential, "GET", `/requests/${requestId}/status`, undefined, tool);
    return { structuredContent: summarize(json) };
  }

  if (tool === "higgsfield/cancel_request") {
    const requestId = String(args.request_id ?? "").trim();
    if (!requestId) throw new Error("request_id is required");
    const json = await request(credential, "POST", `/requests/${requestId}/cancel`, undefined, tool);
    return { structuredContent: { request_id: requestId, ...(json && typeof json === "object" ? json : { result: json }) } };
  }

  throw new Error(`Unknown Higgsfield tool: ${tool}`);
}
