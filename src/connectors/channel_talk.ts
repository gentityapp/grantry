// Channel Talk connector - Open API v5.
// Auth is a JSON credential {"accessKey":"...","accessSecret":"..."} sent as the
// x-access-key and x-access-secret request headers.
const CHANNEL_TALK_API = "https://api.channel.io/open/v5";
const CHANNEL_TALK_TIMEOUT_MS = 12_000;

type ChannelTalkArgs = Record<string, unknown>;

type ChannelTalkCredential = { accessKey: string; accessSecret: string };

function parseCredential(credential: string): ChannelTalkCredential {
  let parsed: any;
  try {
    parsed = JSON.parse(credential.trim());
  } catch {
    throw new Error('Channel Talk credential must be JSON {"accessKey":"...","accessSecret":"..."}');
  }
  const accessKey = String(parsed.accessKey ?? parsed.access_key ?? "").trim();
  const accessSecret = String(parsed.accessSecret ?? parsed.access_secret ?? "").trim();
  if (!accessKey || !accessSecret) {
    throw new Error("Channel Talk JSON must include accessKey and accessSecret");
  }
  return { accessKey, accessSecret };
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

function headers(cred: ChannelTalkCredential, json = false) {
  return {
    Accept: "application/json",
    "x-access-key": cred.accessKey,
    "x-access-secret": cred.accessSecret,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchChannelTalk(path: string, init: RequestInit, logContext: Record<string, unknown>, base: string = CHANNEL_TALK_API) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHANNEL_TALK_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[channel_talk] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[channel_talk] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[channel_talk] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CHANNEL_TALK_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Channel Talk request timed out after ${CHANNEL_TALK_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: ChannelTalkArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: ChannelTalkArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function getJson(cred: ChannelTalkCredential, path: string, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchChannelTalk(path, { headers: headers(cred) }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Channel Talk ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

async function postJson(cred: ChannelTalkCredential, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchChannelTalk(path, {
    method: "POST",
    headers: headers(cred, true),
    body: JSON.stringify(body),
  }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Channel Talk ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callChannelTalkTool(tool: string, args: ChannelTalkArgs, credential: string) {
  const cred = parseCredential(credential);

  if (tool === "channel_talk/list_managers") {
    const qs = queryString(args, ["limit", "since", "sortOrder"]);
    return { structuredContent: await getJson(cred, `/managers${qs}`, tool) };
  }

  if (tool === "channel_talk/get_manager") {
    const managerId = idArg(args, "manager_id");
    return { structuredContent: await getJson(cred, `/managers/${encodeURIComponent(managerId)}`, tool, { managerId }) };
  }

  if (tool === "channel_talk/list_user_chats") {
    const qs = queryString(args, ["state", "sortOrder", "limit", "since"]);
    return { structuredContent: await getJson(cred, `/user-chats${qs}`, tool) };
  }

  if (tool === "channel_talk/get_user_chat") {
    const userChatId = idArg(args, "user_chat_id");
    return { structuredContent: await getJson(cred, `/user-chats/${encodeURIComponent(userChatId)}`, tool, { userChatId }) };
  }

  if (tool === "channel_talk/list_messages") {
    const userChatId = idArg(args, "user_chat_id");
    const qs = queryString(args, ["limit", "since", "sortOrder"]);
    return { structuredContent: await getJson(cred, `/user-chats/${encodeURIComponent(userChatId)}/messages${qs}`, tool, { userChatId }) };
  }

  if (tool === "channel_talk/send_message") {
    const userChatId = idArg(args, "user_chat_id");
    const plainText = String(args.plain_text ?? args.plainText ?? "").trim();
    const blocks = args.blocks;
    if (!plainText && !blocks) throw new Error("plain_text or blocks is required");
    const body: Record<string, unknown> = {};
    if (plainText) body.plainText = plainText;
    if (blocks !== undefined) body.blocks = blocks;
    // botName attributes the message to a bot; defaults to the channel's default bot.
    const botName = String(args.bot_name ?? args.botName ?? "").trim();
    const qs = botName ? `?botName=${encodeURIComponent(botName)}` : "";
    return { structuredContent: await postJson(cred, `/user-chats/${encodeURIComponent(userChatId)}/messages${qs}`, body, tool, { userChatId }) };
  }

  if (tool === "channel_talk/get_user") {
    const userId = idArg(args, "user_id");
    return { structuredContent: await getJson(cred, `/users/${encodeURIComponent(userId)}`, tool, { userId }) };
  }

  throw new Error(`Unknown Channel Talk tool: ${tool}`);
}

// --- Channel Talk Documents Open API ---------------------------------------
// A separate service from the desk Open API above. Base is
// https://document-api.channel.io/open/v1 and auth is HTTP Basic using an API
// key issued in the Documents *space* settings (NOT the desk Open API key). The
// current space is addressed by the literal path token "$me".
//
// Confirmed write surface (probed live): POST /spaces/$me/articles (create) and
// DELETE /spaces/$me/articles/{id}. There is no update (PUT/PATCH) or import
// endpoint in v1. The create body schema is not published; convenience fields
// map to the documented Article model (title, content, description, slug, state,
// topicId, language) and a raw `data` object is merged last as an escape hatch.
export const CHANNEL_TALK_DOCS_API = "https://document-api.channel.io/open/v1";

// Basic auth token from the Documents space credential. Accepts JSON
// {"accessKey":"...","accessSecret":"..."} (→ base64("key:secret")) or a bare
// API key string (→ base64(key)).
export function channelTalkDocsBasic(credential: string): string {
  const raw = (credential ?? "").trim();
  if (!raw) throw new Error("Channel Talk Documents credential is required (Documents space API key)");
  let accessKey = "";
  let accessSecret = "";
  if (raw.startsWith("{")) {
    let p: any;
    try {
      p = JSON.parse(raw);
    } catch {
      throw new Error('Channel Talk Documents credential must be JSON {"accessKey":"...","accessSecret":"..."} or a bare API key');
    }
    accessKey = String(p.accessKey ?? p.access_key ?? p.apiKey ?? p.api_key ?? "").trim();
    accessSecret = String(p.accessSecret ?? p.access_secret ?? "").trim();
    if (!accessKey) throw new Error("Channel Talk Documents JSON must include accessKey (and usually accessSecret)");
  } else {
    accessKey = raw;
  }
  const token = accessSecret ? `${accessKey}:${accessSecret}` : accessKey;
  return Buffer.from(token).toString("base64");
}

function docQuery(args: ChannelTalkArgs, spec: Array<[string, string[]]>) {
  const params = new URLSearchParams();
  for (const [param, aliases] of spec) {
    for (const alias of aliases) {
      const value = args[alias];
      if (value === undefined || value === null || value === "") continue;
      params.set(param, Array.isArray(value) ? value.join(",") : String(value));
      break;
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function docFetch(credential: string, path: string, init: RequestInit, tool: string, logContext: Record<string, unknown> = {}) {
  const basic = channelTalkDocsBasic(credential);
  const method = (init.method ?? "GET").toUpperCase();
  const h: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Basic ${basic}`,
  };
  if (method === "POST" || method === "PUT" || method === "PATCH") h["Content-Type"] = "application/json";
  const r = await fetchChannelTalk(path, { ...init, method, headers: h }, { tool, ...logContext }, CHANNEL_TALK_DOCS_API);
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Channel Talk ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callChannelTalkDocumentsTool(tool: string, args: ChannelTalkArgs, credential: string) {
  if (tool === "channel_talk_documents/list_articles") {
    const qs = docQuery(args, [
      ["language", ["language"]],
      ["state", ["state"]],
      ["topicId", ["topic_id", "topicId"]],
      ["limit", ["limit"]],
      ["since", ["since"]],
      ["order", ["order", "sortOrder"]],
    ]);
    return { structuredContent: await docFetch(credential, `/spaces/$me/articles${qs}`, {}, tool) };
  }

  if (tool === "channel_talk_documents/get_article") {
    const articleId = idArg(args, "article_id", ["articleId", "slug"]);
    const qs = docQuery(args, [["language", ["language"]]]);
    return { structuredContent: await docFetch(credential, `/spaces/$me/articles/${encodeURIComponent(articleId)}${qs}`, {}, tool, { articleId }) };
  }

  if (tool === "channel_talk_documents/create_article") {
    const body: Record<string, unknown> = {};
    const map: Array<[string, string]> = [
      ["title", "title"],
      ["content", "content"],
      ["description", "description"],
      ["slug", "slug"],
      ["state", "state"],
      ["topic_id", "topicId"],
      ["language", "language"],
    ];
    for (const [arg, field] of map) {
      const value = args[arg] ?? args[field];
      if (value !== undefined && value !== null && value !== "") body[field] = value;
    }
    // Raw passthrough wins — lets callers supply the exact body if the
    // convenience mapping is insufficient for a given space.
    if (args.data && typeof args.data === "object") Object.assign(body, args.data as Record<string, unknown>);
    if (Object.keys(body).length === 0) throw new Error("create_article requires at least one of title/content/data");
    return { structuredContent: await docFetch(credential, `/spaces/$me/articles`, { method: "POST", body: JSON.stringify(body) }, tool) };
  }

  if (tool === "channel_talk_documents/delete_article") {
    const articleId = idArg(args, "article_id", ["articleId"]);
    return { structuredContent: await docFetch(credential, `/spaces/$me/articles/${encodeURIComponent(articleId)}`, { method: "DELETE" }, tool, { articleId }) };
  }

  if (tool === "channel_talk_documents/list_topics") {
    const qs = docQuery(args, [
      ["limit", ["limit"]],
      ["since", ["since"]],
      ["order", ["order", "sortOrder"]],
    ]);
    return { structuredContent: await docFetch(credential, `/spaces/$me/topics${qs}`, {}, tool) };
  }

  if (tool === "channel_talk_documents/get_topic") {
    const topicId = idArg(args, "topic_id", ["topicId"]);
    return { structuredContent: await docFetch(credential, `/spaces/$me/topics/${encodeURIComponent(topicId)}`, {}, tool, { topicId }) };
  }

  throw new Error(`Unknown Channel Talk Documents tool: ${tool}`);
}
