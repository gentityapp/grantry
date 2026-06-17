// Facebook Messenger connector — Messenger Platform via the Graph API using a
// Page Access Token (Bearer). Talks to https://graph.facebook.com/<version>.
// Graph API returns errors as HTTP status codes plus a JSON { error } body, so
// success is keyed off both r.ok and the absence of body.error.
const MESSENGER_API_VERSION =
  process.env.MESSENGER_API_VERSION || process.env.META_ADS_API_VERSION || "v21.0";
const MESSENGER_API = `https://graph.facebook.com/${MESSENGER_API_VERSION}`;
const MESSENGER_TIMEOUT_MS = 12_000;

type MessengerArgs = Record<string, unknown>;

function headers(token: string, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
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

function requireId(args: MessengerArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function clampLimit(value: unknown, fallback = 25, max = 100) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

async function fetchMessenger(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESSENGER_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[facebook_messenger] request", { path, apiVersion: MESSENGER_API_VERSION, ...logContext });
    const response = await fetch(`${MESSENGER_API}${path}`, { ...init, signal: controller.signal });
    console.log("[facebook_messenger] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[facebook_messenger] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${MESSENGER_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Messenger request timed out after ${MESSENGER_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  token: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const init: RequestInit = { method, headers: headers(token, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchMessenger(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok || j.error) {
    throw new Error(`Messenger ${tool} failed: ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 1000)}`);
  }
  return j;
}

/** Build a `?a=b&c=d` query string from defined entries. */
function query(params: Record<string, string | number | undefined>) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export async function callFacebookMessengerTool(tool: string, args: MessengerArgs, token: string) {
  // The connected Page itself (id, name, category).
  if (tool === "facebook_messenger/get_page") {
    const fields = String(args.fields ?? "id,name,category").trim() || "id,name,category";
    return { structuredContent: await request(token, "GET", `/me${query({ fields })}`, undefined, tool) };
  }

  // Public profile of a user who has messaged the Page (by PSID).
  if (tool === "facebook_messenger/get_user_profile") {
    const psid = requireId(args, "psid", ["user_id", "id"]);
    const fields = String(args.fields ?? "first_name,last_name,profile_pic").trim() || "first_name,last_name,profile_pic";
    return {
      structuredContent: await request(
        token,
        "GET",
        `/${encodeURIComponent(psid)}${query({ fields })}`,
        undefined,
        tool,
        { psid },
      ),
    };
  }

  // Conversations on the Page's Messenger inbox.
  if (tool === "facebook_messenger/list_conversations") {
    const fields = String(args.fields ?? "id,participants,updated_time,snippet,message_count,unread_count").trim();
    const q = query({
      platform: String(args.platform ?? "messenger") || "messenger",
      fields,
      limit: clampLimit(args.limit),
      after: typeof args.after === "string" ? args.after : undefined,
    });
    return { structuredContent: await request(token, "GET", `/me/conversations${q}`, undefined, tool) };
  }

  // Messages within a conversation.
  if (tool === "facebook_messenger/get_conversation_messages") {
    const conversationId = requireId(args, "conversation_id", ["conversationId", "id"]);
    const fields = String(args.fields ?? "id,message,from,to,created_time").trim();
    const q = query({
      fields,
      limit: clampLimit(args.limit),
      after: typeof args.after === "string" ? args.after : undefined,
    });
    return {
      structuredContent: await request(
        token,
        "GET",
        `/${encodeURIComponent(conversationId)}/messages${q}`,
        undefined,
        tool,
        { conversationId },
      ),
    };
  }

  // Send a message via the Send API. Accepts a `text` convenience or a raw
  // `message` object (for attachments, templates, quick replies, etc.).
  if (tool === "facebook_messenger/send_message") {
    const recipientId = requireId(args, "recipient_id", ["recipientId", "psid", "user_id"]);
    let message: unknown = args.message;
    if (!message) {
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("message (object) or text (string) is required");
      message = { text };
    }
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      messaging_type: String(args.messaging_type ?? "RESPONSE") || "RESPONSE",
      message,
    };
    if (args.tag !== undefined) body.tag = args.tag;
    if (args.notification_type !== undefined) body.notification_type = args.notification_type;
    return { structuredContent: await request(token, "POST", "/me/messages", body, tool, { recipientId }) };
  }

  // Sender actions: typing_on, typing_off, mark_seen.
  if (tool === "facebook_messenger/send_sender_action") {
    const recipientId = requireId(args, "recipient_id", ["recipientId", "psid", "user_id"]);
    const senderAction = String(args.sender_action ?? args.senderAction ?? "").trim();
    if (!senderAction) throw new Error("sender_action is required (typing_on, typing_off, or mark_seen)");
    const body = { recipient: { id: recipientId }, sender_action: senderAction };
    return { structuredContent: await request(token, "POST", "/me/messages", body, tool, { recipientId, senderAction }) };
  }

  throw new Error(`Unknown Facebook Messenger tool: ${tool}`);
}
