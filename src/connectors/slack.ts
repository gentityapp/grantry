// Slack connector - Bot/User OAuth token via Authorization: Bearer.
// Slack Web API returns HTTP 200 with { ok: false, error } on logical
// failures, so success is determined by body.ok, not the HTTP status.
const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 12_000;

type SlackArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(token: string, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json; charset=utf-8" } : {}),
  };
}

async function fetchSlack(method: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[slack] request", { method, ...logContext });
    const response = await fetch(`${SLACK_API}/${method}`, { ...init, signal: controller.signal });
    console.log("[slack] response", { method, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[slack] failed", {
      method,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${SLACK_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Slack request timed out after ${SLACK_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: SlackArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: SlackArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function jsonBody(args: SlackArgs, requiredKeys: string[], optionalKeys: string[] = []) {
  const body: Record<string, unknown> = {};
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") {
      if (requiredKeys.includes(key)) throw new Error(`${key} is required`);
      continue;
    }
    body[key] = value;
  }
  return body;
}

async function get(token: string, method: string, qs: string, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchSlack(`${method}${qs}`, { headers: headers(token) }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Slack ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  if (j && j.ok === false) throw new Error(`Slack ${tool} failed: ${j.error ?? "unknown_error"}${j.needed ? ` (needed: ${j.needed})` : ""}`);
  return j;
}

async function post(token: string, method: string, body: Record<string, unknown>, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchSlack(method, {
    method: "POST",
    headers: headers(token, true),
    body: JSON.stringify(body),
  }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Slack ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  if (j && j.ok === false) throw new Error(`Slack ${tool} failed: ${j.error ?? "unknown_error"}${j.needed ? ` (needed: ${j.needed})` : ""}`);
  return j;
}

export async function callSlackTool(tool: string, args: SlackArgs, token: string) {
  if (tool === "slack/auth_test") {
    return { structuredContent: await post(token, "auth.test", {}, tool) };
  }

  if (tool === "slack/list_channels") {
    const qs = queryString(args, ["types", "limit", "cursor", "exclude_archived", "team_id"]);
    return { structuredContent: await get(token, "conversations.list", qs, tool) };
  }

  if (tool === "slack/get_channel") {
    const channel = idArg(args, "channel", ["channel_id"]);
    const qs = queryString({ channel, include_num_members: args.include_num_members }, ["channel", "include_num_members"]);
    return { structuredContent: await get(token, "conversations.info", qs, tool, { channel }) };
  }

  if (tool === "slack/list_messages") {
    const channel = idArg(args, "channel", ["channel_id"]);
    const qs = queryString({ ...args, channel }, ["channel", "limit", "cursor", "oldest", "latest", "inclusive"]);
    return { structuredContent: await get(token, "conversations.history", qs, tool, { channel }) };
  }

  if (tool === "slack/get_thread") {
    const channel = idArg(args, "channel", ["channel_id"]);
    const ts = idArg(args, "ts", ["thread_ts"]);
    const qs = queryString({ ...args, channel, ts }, ["channel", "ts", "limit", "cursor", "oldest", "latest", "inclusive"]);
    return { structuredContent: await get(token, "conversations.replies", qs, tool, { channel, ts }) };
  }

  if (tool === "slack/post_message") {
    const body = jsonBody(
      args,
      ["channel"],
      ["text", "blocks", "attachments", "thread_ts", "reply_broadcast", "unfurl_links", "unfurl_media", "mrkdwn"],
    );
    if (body.text === undefined && body.blocks === undefined && body.attachments === undefined) {
      throw new Error("one of text, blocks, or attachments is required");
    }
    return { structuredContent: await post(token, "chat.postMessage", body, tool, { channel: body.channel }) };
  }

  if (tool === "slack/update_message") {
    const body = jsonBody(
      args,
      ["channel", "ts"],
      ["text", "blocks", "attachments", "reply_broadcast"],
    );
    if (body.text === undefined && body.blocks === undefined && body.attachments === undefined) {
      throw new Error("one of text, blocks, or attachments is required");
    }
    return { structuredContent: await post(token, "chat.update", body, tool, { channel: body.channel, ts: body.ts }) };
  }

  if (tool === "slack/create_channel") {
    const body = jsonBody(args, ["name"], ["is_private", "team_id"]);
    return { structuredContent: await post(token, "conversations.create", body, tool, { name: body.name }) };
  }

  if (tool === "slack/invite_members") {
    const channel = idArg(args, "channel", ["channel_id"]);
    const usersRaw = args.users ?? args.user_ids;
    const users = Array.isArray(usersRaw) ? usersRaw.join(",") : String(usersRaw ?? "").trim();
    if (!users) throw new Error("users is required (comma-separated user IDs or an array)");
    return { structuredContent: await post(token, "conversations.invite", { channel, users }, tool, { channel }) };
  }

  if (tool === "slack/open_group_dm") {
    const usersRaw = args.users ?? args.user_ids;
    const users = Array.isArray(usersRaw) ? usersRaw.join(",") : String(usersRaw ?? "").trim();
    if (!users) throw new Error("users is required (comma-separated user IDs or an array)");
    return { structuredContent: await post(token, "conversations.open", { users, return_im: false }, tool) };
  }

  if (tool === "slack/invite_shared") {
    const channel = idArg(args, "channel", ["channel_id"]);
    const emailsRaw = args.emails;
    const userIdsRaw = args.user_ids ?? args.users;
    const emails = Array.isArray(emailsRaw) ? emailsRaw.join(",") : String(emailsRaw ?? "").trim();
    const userIds = Array.isArray(userIdsRaw) ? userIdsRaw.join(",") : String(userIdsRaw ?? "").trim();
    if (!emails && !userIds) throw new Error("one of emails or user_ids is required");
    const body: Record<string, unknown> = { channel };
    if (emails) body.emails = emails;
    if (userIds) body.user_ids = userIds;
    if (args.external_limited !== undefined) body.external_limited = args.external_limited;
    return { structuredContent: await post(token, "conversations.inviteShared", body, tool, { channel }) };
  }

  if (tool === "slack/list_users") {
    const qs = queryString(args, ["limit", "cursor", "team_id"]);
    return { structuredContent: await get(token, "users.list", qs, tool) };
  }

  if (tool === "slack/get_user") {
    const user = idArg(args, "user", ["user_id"]);
    const qs = queryString({ user }, ["user"]);
    return { structuredContent: await get(token, "users.info", qs, tool, { user }) };
  }

  throw new Error(`Unknown Slack tool: ${tool}`);
}
