// Discord connector - Bot token authentication via Authorization: Bot <token>.
// Targets the Discord REST API v10. Errors come back as proper 4xx/5xx HTTP
// statuses with a JSON { message, code } body, so success is keyed off r.ok.
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_TIMEOUT_MS = 12_000;

type DiscordArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(botToken: string, json = false) {
  return {
    Authorization: `Bot ${botToken}`,
    Accept: "application/json",
    "User-Agent": "grantry (https://grantry.ai, 1.0)",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchDiscord(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[discord] request", { path, ...logContext });
    const response = await fetch(`${DISCORD_API}${path}`, { ...init, signal: controller.signal });
    console.log("[discord] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[discord] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${DISCORD_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Discord request timed out after ${DISCORD_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: DiscordArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: DiscordArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function jsonBody(args: DiscordArgs, requiredKeys: string[], optionalKeys: string[] = []) {
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

async function request(botToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(botToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchDiscord(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Discord ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callDiscordTool(tool: string, args: DiscordArgs, botToken: string) {
  if (tool === "discord/get_me") {
    return { structuredContent: await request(botToken, "GET", "/users/@me", undefined, tool) };
  }

  if (tool === "discord/list_guilds") {
    const qs = queryString(args, ["before", "after", "limit", "with_counts"]);
    return { structuredContent: { guilds: await request(botToken, "GET", `/users/@me/guilds${qs}`, undefined, tool) } };
  }

  if (tool === "discord/get_guild") {
    const guildId = idArg(args, "guild_id");
    const qs = queryString(args, ["with_counts"]);
    return { structuredContent: await request(botToken, "GET", `/guilds/${encodeURIComponent(guildId)}${qs}`, undefined, tool, { guildId }) };
  }

  if (tool === "discord/list_channels") {
    const guildId = idArg(args, "guild_id");
    return { structuredContent: { channels: await request(botToken, "GET", `/guilds/${encodeURIComponent(guildId)}/channels`, undefined, tool, { guildId }) } };
  }

  if (tool === "discord/get_channel") {
    const channelId = idArg(args, "channel_id");
    return { structuredContent: await request(botToken, "GET", `/channels/${encodeURIComponent(channelId)}`, undefined, tool, { channelId }) };
  }

  if (tool === "discord/list_messages") {
    const channelId = idArg(args, "channel_id");
    const qs = queryString(args, ["around", "before", "after", "limit"]);
    return { structuredContent: { messages: await request(botToken, "GET", `/channels/${encodeURIComponent(channelId)}/messages${qs}`, undefined, tool, { channelId }) } };
  }

  if (tool === "discord/get_message") {
    const channelId = idArg(args, "channel_id");
    const messageId = idArg(args, "message_id");
    return { structuredContent: await request(botToken, "GET", `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, undefined, tool, { channelId, messageId }) };
  }

  if (tool === "discord/send_message") {
    const channelId = idArg(args, "channel_id");
    const body = jsonBody(args, [], ["content", "embeds", "tts", "allowed_mentions", "message_reference", "components", "flags"]);
    if (body.content === undefined && body.embeds === undefined && body.components === undefined) {
      throw new Error("one of content, embeds, or components is required");
    }
    return { structuredContent: await request(botToken, "POST", `/channels/${encodeURIComponent(channelId)}/messages`, body, tool, { channelId }) };
  }

  if (tool === "discord/edit_message") {
    const channelId = idArg(args, "channel_id");
    const messageId = idArg(args, "message_id");
    const body = jsonBody(args, [], ["content", "embeds", "allowed_mentions", "components", "flags"]);
    return { structuredContent: await request(botToken, "PATCH", `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, body, tool, { channelId, messageId }) };
  }

  if (tool === "discord/delete_message") {
    const channelId = idArg(args, "channel_id");
    const messageId = idArg(args, "message_id");
    await request(botToken, "DELETE", `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, undefined, tool, { channelId, messageId });
    return { structuredContent: { deleted: true, channel_id: channelId, message_id: messageId } };
  }

  if (tool === "discord/list_members") {
    const guildId = idArg(args, "guild_id");
    const qs = queryString(args, ["limit", "after"]);
    return { structuredContent: { members: await request(botToken, "GET", `/guilds/${encodeURIComponent(guildId)}/members${qs}`, undefined, tool, { guildId }) } };
  }

  if (tool === "discord/get_user") {
    const userId = idArg(args, "user_id");
    return { structuredContent: await request(botToken, "GET", `/users/${encodeURIComponent(userId)}`, undefined, tool, { userId }) };
  }

  throw new Error(`Unknown Discord tool: ${tool}`);
}
