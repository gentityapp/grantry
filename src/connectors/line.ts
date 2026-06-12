// LINE connector - LINE Messaging API via a Channel Access Token (Bearer).
// Targets api.line.me/v2/bot. Errors come back as proper HTTP status codes with
// a JSON { message, details } body, so success is keyed off r.ok.
const LINE_API = "https://api.line.me/v2/bot";
const LINE_TIMEOUT_MS = 12_000;

type LineArgs = Record<string, unknown>;

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

async function fetchLine(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[line] request", { path, ...logContext });
    const response = await fetch(`${LINE_API}${path}`, { ...init, signal: controller.signal });
    console.log("[line] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[line] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${LINE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`LINE request timed out after ${LINE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: LineArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

// LINE message bodies take a `messages` array. Accept either a ready-made array
// or a plain `text` string as a convenience.
function messagesArg(args: LineArgs) {
  const raw = args.messages;
  if (Array.isArray(raw) && raw.length > 0) return raw;
  const text = args.text;
  if (typeof text === "string" && text.trim()) return [{ type: "text", text }];
  throw new Error("messages (array) or text (string) is required");
}

function toArg(args: LineArgs) {
  const value = args.to;
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v).trim()).filter(Boolean);
    if (!list.length) throw new Error("to is required");
    return list;
  }
  const single = String(value ?? "").trim();
  if (!single) throw new Error("to is required");
  return single;
}

async function request(accessToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchLine(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`LINE ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callLineTool(tool: string, args: LineArgs, accessToken: string) {
  if (tool === "line/get_bot_info") {
    return { structuredContent: await request(accessToken, "GET", "/info", undefined, tool) };
  }

  if (tool === "line/get_quota") {
    return { structuredContent: await request(accessToken, "GET", "/message/quota", undefined, tool) };
  }

  if (tool === "line/get_quota_consumption") {
    return { structuredContent: await request(accessToken, "GET", "/message/quota/consumption", undefined, tool) };
  }

  if (tool === "line/get_profile") {
    const userId = idArg(args, "user_id", ["userId"]);
    return { structuredContent: await request(accessToken, "GET", `/profile/${encodeURIComponent(userId)}`, undefined, tool, { userId }) };
  }

  if (tool === "line/push_message") {
    const body: Record<string, unknown> = { to: toArg(args), messages: messagesArg(args) };
    if (args.notification_disabled !== undefined) body.notificationDisabled = !!args.notification_disabled;
    if (args.custom_aggregation_units !== undefined) body.customAggregationUnits = args.custom_aggregation_units;
    return { structuredContent: await request(accessToken, "POST", "/message/push", body, tool) };
  }

  if (tool === "line/reply_message") {
    const body: Record<string, unknown> = {
      replyToken: idArg(args, "reply_token", ["replyToken"]),
      messages: messagesArg(args),
    };
    if (args.notification_disabled !== undefined) body.notificationDisabled = !!args.notification_disabled;
    return { structuredContent: await request(accessToken, "POST", "/message/reply", body, tool) };
  }

  if (tool === "line/multicast") {
    const to = toArg(args);
    const body: Record<string, unknown> = {
      to: Array.isArray(to) ? to : [to],
      messages: messagesArg(args),
    };
    if (args.notification_disabled !== undefined) body.notificationDisabled = !!args.notification_disabled;
    return { structuredContent: await request(accessToken, "POST", "/message/multicast", body, tool) };
  }

  if (tool === "line/broadcast") {
    const body: Record<string, unknown> = { messages: messagesArg(args) };
    if (args.notification_disabled !== undefined) body.notificationDisabled = !!args.notification_disabled;
    return { structuredContent: await request(accessToken, "POST", "/message/broadcast", body, tool) };
  }

  if (tool === "line/get_group_summary") {
    const groupId = idArg(args, "group_id", ["groupId"]);
    return { structuredContent: await request(accessToken, "GET", `/group/${encodeURIComponent(groupId)}/summary`, undefined, tool, { groupId }) };
  }

  if (tool === "line/get_group_member_count") {
    const groupId = idArg(args, "group_id", ["groupId"]);
    return { structuredContent: await request(accessToken, "GET", `/group/${encodeURIComponent(groupId)}/members/count`, undefined, tool, { groupId }) };
  }

  if (tool === "line/get_group_member_profile") {
    const groupId = idArg(args, "group_id", ["groupId"]);
    const userId = idArg(args, "user_id", ["userId"]);
    return { structuredContent: await request(accessToken, "GET", `/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`, undefined, tool, { groupId, userId }) };
  }

  throw new Error(`Unknown LINE tool: ${tool}`);
}
