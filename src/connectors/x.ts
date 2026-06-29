// X (Twitter) connector - OAuth 2.0 bearer token (access token issued via the
// generic OAuth flow with PKCE). Calls go to the X API v2.
const X_API = "https://api.x.com/2";
const X_TIMEOUT_MS = 12_000;
// Downloading + uploading image bytes is slower than a JSON call, so media gets
// its own, longer budget.
const X_MEDIA_TIMEOUT_MS = 30_000;
// X allows at most 4 images per tweet.
const X_MAX_MEDIA = 4;

type XArgs = Record<string, unknown>;

const DEFAULT_TWEET_FIELDS = "created_at,public_metrics,author_id,conversation_id,lang";
const DEFAULT_USER_FIELDS = "created_at,description,public_metrics,verified,location";

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchX(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), X_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[x] request", { path, ...logContext });
    const response = await fetch(`${X_API}${path}`, { ...init, signal: controller.signal });
    console.log("[x] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[x] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${X_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`X request timed out after ${X_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function strArg(args: XArgs, key: string, aliases: string[] = []): string {
  for (const candidate of [key, ...aliases]) {
    const value = String(args[candidate] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function requireArg(args: XArgs, key: string, aliases: string[] = []): string {
  const value = strArg(args, key, aliases);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

// Reads an argument that may be a single string or an array of strings, and
// returns a cleaned list (empty strings dropped).
function arrArg(args: XArgs, key: string, aliases: string[] = []): string[] {
  for (const candidate of [key, ...aliases]) {
    const value = args[candidate];
    if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
}

async function downloadImage(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), X_MEDIA_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`failed to download image (${r.status}) from ${url}`);
    const mime = (r.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
    return { bytes: new Uint8Array(await r.arrayBuffer()), mime };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`image download timed out after ${X_MEDIA_TIMEOUT_MS}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeBase64Image(input: string): { bytes: Uint8Array; mime: string } {
  let mime = "image/png";
  let b64 = input.trim();
  const dataUri = b64.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataUri) {
    mime = dataUri[1];
    b64 = dataUri[2];
  }
  return { bytes: new Uint8Array(Buffer.from(b64, "base64")), mime };
}

// Uploads image bytes via the X v2 media upload endpoint (multipart/form-data,
// not JSON) and returns the resulting media id for attaching to a tweet.
async function uploadMedia(token: string, bytes: Uint8Array, mime: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), X_MEDIA_TIMEOUT_MS);
  const started = Date.now();
  try {
    const form = new FormData();
    const ext = (mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
    form.append("media", new Blob([bytes as unknown as BlobPart], { type: mime }), `upload.${ext}`);
    form.append("media_category", "tweet_image");
    console.log("[x] media upload", { mime, bytes: bytes.length });
    const r = await fetch(`${X_API}/media/upload`, {
      method: "POST",
      // No Content-Type header: fetch sets the multipart boundary itself.
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: form,
      signal: controller.signal,
    });
    const j: any = await readJsonResponse(r);
    console.log("[x] media upload response", { status: r.status, durationMs: Date.now() - started });
    if (!r.ok) throw new Error(`X media upload failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    const id = j?.data?.id ?? j?.media_id_string ?? j?.id;
    if (!id) throw new Error(`X media upload returned no media id: ${JSON.stringify(j).slice(0, 500)}`);
    return String(id);
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`X media upload timed out after ${X_MEDIA_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Resolves image_urls / image_base64 / media_ids args into a list of X media
// ids (uploading where needed), capped at X_MAX_MEDIA.
async function resolveMediaIds(token: string, args: XArgs): Promise<string[]> {
  const ids = [...arrArg(args, "media_ids", ["media_id"])];
  for (const url of arrArg(args, "image_urls", ["image_url"])) {
    if (ids.length >= X_MAX_MEDIA) break;
    const { bytes, mime } = await downloadImage(url);
    ids.push(await uploadMedia(token, bytes, mime));
  }
  for (const b64 of arrArg(args, "image_base64", ["images_base64"])) {
    if (ids.length >= X_MAX_MEDIA) break;
    const { bytes, mime } = decodeBase64Image(b64);
    ids.push(await uploadMedia(token, bytes, mime));
  }
  return ids.slice(0, X_MAX_MEDIA);
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

async function request(token: string, method: string, path: string, body: unknown, tool: string) {
  const init: RequestInit = { method, headers: headers(token) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchX(path, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`X ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callXTool(tool: string, args: XArgs, token: string) {
  if (tool === "x/get_me") {
    const qs = buildQuery({ "user.fields": strArg(args, "user_fields") || DEFAULT_USER_FIELDS });
    return { structuredContent: await request(token, "GET", `/users/me${qs}`, undefined, tool) };
  }

  if (tool === "x/get_user") {
    const username = requireArg(args, "username").replace(/^@/, "");
    const qs = buildQuery({ "user.fields": strArg(args, "user_fields") || DEFAULT_USER_FIELDS });
    return { structuredContent: await request(token, "GET", `/users/by/username/${encodeURIComponent(username)}${qs}`, undefined, tool) };
  }

  if (tool === "x/get_user_tweets") {
    const userId = requireArg(args, "user_id", ["id"]);
    const qs = buildQuery({
      max_results: args.max_results,
      pagination_token: args.pagination_token,
      "tweet.fields": strArg(args, "tweet_fields") || DEFAULT_TWEET_FIELDS,
    });
    return { structuredContent: await request(token, "GET", `/users/${encodeURIComponent(userId)}/tweets${qs}`, undefined, tool) };
  }

  if (tool === "x/search_recent") {
    const query = requireArg(args, "query", ["q"]);
    const qs = buildQuery({
      query,
      max_results: args.max_results,
      next_token: args.next_token,
      "tweet.fields": strArg(args, "tweet_fields") || DEFAULT_TWEET_FIELDS,
    });
    return { structuredContent: await request(token, "GET", `/tweets/search/recent${qs}`, undefined, tool) };
  }

  if (tool === "x/get_tweet") {
    const id = requireArg(args, "id", ["tweet_id"]);
    const qs = buildQuery({ "tweet.fields": strArg(args, "tweet_fields") || DEFAULT_TWEET_FIELDS });
    return { structuredContent: await request(token, "GET", `/tweets/${encodeURIComponent(id)}${qs}`, undefined, tool) };
  }

  if (tool === "x/post_tweet") {
    const text = strArg(args, "text");
    const mediaIds = await resolveMediaIds(token, args);
    if (!text && mediaIds.length === 0) throw new Error("text or at least one image is required");
    const body: Record<string, unknown> = {};
    if (text) body.text = text;
    if (mediaIds.length) body.media = { media_ids: mediaIds };
    const replyTo = strArg(args, "reply_to", ["in_reply_to_tweet_id"]);
    if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
    const quote = strArg(args, "quote_tweet_id");
    if (quote) body.quote_tweet_id = quote;
    return { structuredContent: await request(token, "POST", "/tweets", body, tool) };
  }

  if (tool === "x/delete_tweet") {
    const id = requireArg(args, "id", ["tweet_id"]);
    return { structuredContent: await request(token, "DELETE", `/tweets/${encodeURIComponent(id)}`, undefined, tool) };
  }

  throw new Error(`Unknown X tool: ${tool}`);
}
