// Chatwork connector - API token authentication via x-chatworktoken.
const CHATWORK_API = "https://api.chatwork.com/v2";
const CHATWORK_TIMEOUT_MS = 12_000;

type ChatworkArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(apiToken: string, form = false) {
  return {
    Accept: "application/json",
    "x-chatworktoken": apiToken,
    ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
  };
}

async function fetchChatwork(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHATWORK_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[chatwork] request", { path, ...logContext });
    const response = await fetch(`${CHATWORK_API}${path}`, { ...init, signal: controller.signal });
    console.log("[chatwork] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[chatwork] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CHATWORK_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Chatwork request timed out after ${CHATWORK_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: ChatworkArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function boolParam(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true" || value === "1" || value === 1) return "1";
  if (value === false || value === "false" || value === "0" || value === 0) return "0";
  return String(value);
}

function queryString(args: ChatworkArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function formBody(args: ChatworkArgs, requiredKeys: string[], optionalKeys: string[] = []) {
  const params = new URLSearchParams();
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") {
      if (requiredKeys.includes(key)) throw new Error(`${key} is required`);
      continue;
    }
    const normalized = key === "self_unread" ? boolParam(value) : (Array.isArray(value) ? value.join(",") : String(value));
    if (normalized !== undefined) params.set(key, normalized);
  }
  return params;
}

async function getJson(apiToken: string, path: string, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchChatwork(path, { headers: headers(apiToken) }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Chatwork ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

async function postForm(apiToken: string, path: string, body: URLSearchParams, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchChatwork(path, {
    method: "POST",
    headers: headers(apiToken, true),
    body,
  }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Chatwork ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callChatworkTool(tool: string, args: ChatworkArgs, apiToken: string) {
  if (tool === "chatwork/get_me") {
    return { structuredContent: await getJson(apiToken, "/me", tool) };
  }

  if (tool === "chatwork/list_contacts") {
    return { structuredContent: { contacts: await getJson(apiToken, "/contacts", tool) } };
  }

  if (tool === "chatwork/list_rooms") {
    return { structuredContent: { rooms: await getJson(apiToken, "/rooms", tool) } };
  }

  if (tool === "chatwork/get_room") {
    const roomId = idArg(args, "room_id");
    return { structuredContent: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}`, tool, { roomId }) };
  }

  if (tool === "chatwork/list_room_members") {
    const roomId = idArg(args, "room_id");
    return { structuredContent: { members: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}/members`, tool, { roomId }) } };
  }

  if (tool === "chatwork/list_messages") {
    const roomId = idArg(args, "room_id");
    const qs = queryString({ force: boolParam(args.force) }, ["force"]);
    return { structuredContent: { messages: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}/messages${qs}`, tool, { roomId }) } };
  }

  if (tool === "chatwork/get_message") {
    const roomId = idArg(args, "room_id");
    const messageId = idArg(args, "message_id");
    return { structuredContent: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, tool, { roomId, messageId }) };
  }

  if (tool === "chatwork/send_message") {
    const roomId = idArg(args, "room_id");
    const body = formBody(args, ["body"], ["self_unread"]);
    return { structuredContent: await postForm(apiToken, `/rooms/${encodeURIComponent(roomId)}/messages`, body, tool, { roomId }) };
  }

  if (tool === "chatwork/list_my_tasks") {
    const qs = queryString(args, ["assigned_by_account_id", "status"]);
    return { structuredContent: { tasks: await getJson(apiToken, `/my/tasks${qs}`, tool) } };
  }

  if (tool === "chatwork/list_room_tasks") {
    const roomId = idArg(args, "room_id");
    const qs = queryString(args, ["account_id", "assigned_by_account_id", "status"]);
    return { structuredContent: { tasks: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}/tasks${qs}`, tool, { roomId }) } };
  }

  if (tool === "chatwork/get_room_task") {
    const roomId = idArg(args, "room_id");
    const taskId = idArg(args, "task_id");
    return { structuredContent: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}`, tool, { roomId, taskId }) };
  }

  if (tool === "chatwork/create_room_task") {
    const roomId = idArg(args, "room_id");
    const body = formBody(args, ["body", "to_ids"], ["limit"]);
    return { structuredContent: await postForm(apiToken, `/rooms/${encodeURIComponent(roomId)}/tasks`, body, tool, { roomId }) };
  }

  if (tool === "chatwork/list_room_files") {
    const roomId = idArg(args, "room_id");
    const qs = queryString(args, ["account_id"]);
    return { structuredContent: { files: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}/files${qs}`, tool, { roomId }) } };
  }

  if (tool === "chatwork/get_room_file") {
    const roomId = idArg(args, "room_id");
    const fileId = idArg(args, "file_id");
    const qs = queryString({ create_download_url: boolParam(args.create_download_url ?? args.createDownloadUrl) }, ["create_download_url"]);
    return { structuredContent: await getJson(apiToken, `/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}${qs}`, tool, { roomId, fileId }) };
  }

  throw new Error(`Unknown Chatwork tool: ${tool}`);
}
