// Microsoft Teams connector - OAuth access token via Microsoft Graph.
// Uses delegated permissions; calls act as the signed-in user.
const GRAPH_API = "https://graph.microsoft.com/v1.0";
const GRAPH_TIMEOUT_MS = 12_000;

type TeamsArgs = Record<string, unknown>;

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

async function fetchGraph(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[microsoft_teams] request", { path, ...logContext });
    const response = await fetch(`${GRAPH_API}${path}`, { ...init, signal: controller.signal });
    console.log("[microsoft_teams] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[microsoft_teams] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${GRAPH_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Microsoft Teams request timed out after ${GRAPH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: TeamsArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: TeamsArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    const graphKey = key === "top" ? "$top" : key === "expand" ? "$expand" : key === "skip_token" ? "$skiptoken" : key;
    params.set(graphKey, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function messageBody(args: TeamsArgs) {
  const content = String(args.content ?? args.body ?? args.text ?? "").trim();
  if (!content) throw new Error("content is required");
  const contentType = String(args.content_type ?? args.contentType ?? "text").trim() || "text";
  if (contentType !== "text" && contentType !== "html") throw new Error("content_type must be text or html");
  return {
    body: {
      contentType,
      content,
    },
  };
}

async function request(accessToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchGraph(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Microsoft Teams ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callMicrosoftTeamsTool(tool: string, args: TeamsArgs, accessToken: string) {
  if (tool === "microsoft_teams/get_me") {
    return { structuredContent: await request(accessToken, "GET", "/me", undefined, tool) };
  }

  if (tool === "microsoft_teams/list_joined_teams") {
    return { structuredContent: await request(accessToken, "GET", "/me/joinedTeams", undefined, tool) };
  }

  if (tool === "microsoft_teams/list_channels") {
    const teamId = idArg(args, "team_id", ["teamId"]);
    return { structuredContent: await request(accessToken, "GET", `/teams/${encodeURIComponent(teamId)}/channels`, undefined, tool, { teamId }) };
  }

  if (tool === "microsoft_teams/list_messages") {
    const teamId = idArg(args, "team_id", ["teamId"]);
    const channelId = idArg(args, "channel_id", ["channelId"]);
    const qs = queryString(args, ["top", "expand"]);
    return { structuredContent: await request(accessToken, "GET", `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages${qs}`, undefined, tool, { teamId, channelId }) };
  }

  if (tool === "microsoft_teams/get_message") {
    const teamId = idArg(args, "team_id", ["teamId"]);
    const channelId = idArg(args, "channel_id", ["channelId"]);
    const messageId = idArg(args, "message_id", ["messageId"]);
    return { structuredContent: await request(accessToken, "GET", `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, undefined, tool, { teamId, channelId, messageId }) };
  }

  if (tool === "microsoft_teams/list_replies") {
    const teamId = idArg(args, "team_id", ["teamId"]);
    const channelId = idArg(args, "channel_id", ["channelId"]);
    const messageId = idArg(args, "message_id", ["messageId"]);
    const qs = queryString(args, ["top"]);
    return { structuredContent: await request(accessToken, "GET", `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies${qs}`, undefined, tool, { teamId, channelId, messageId }) };
  }

  if (tool === "microsoft_teams/send_message") {
    const teamId = idArg(args, "team_id", ["teamId"]);
    const channelId = idArg(args, "channel_id", ["channelId"]);
    return { structuredContent: await request(accessToken, "POST", `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`, messageBody(args), tool, { teamId, channelId }) };
  }

  if (tool === "microsoft_teams/send_reply") {
    const teamId = idArg(args, "team_id", ["teamId"]);
    const channelId = idArg(args, "channel_id", ["channelId"]);
    const messageId = idArg(args, "message_id", ["messageId"]);
    return { structuredContent: await request(accessToken, "POST", `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`, messageBody(args), tool, { teamId, channelId, messageId }) };
  }

  throw new Error(`Unknown Microsoft Teams tool: ${tool}`);
}
