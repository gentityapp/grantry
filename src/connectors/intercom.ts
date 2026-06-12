// Intercom connector - Bearer token authentication.
// Sends Accept: application/json and Intercom-Version: 2.11 on every request.
const INTERCOM_API = "https://api.intercom.io";
const INTERCOM_TIMEOUT_MS = 12_000;

type IntercomArgs = Record<string, unknown>;

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
    "Intercom-Version": "2.11",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchIntercom(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[intercom] request", { path, ...logContext });
    const response = await fetch(`${INTERCOM_API}${path}`, { ...init, signal: controller.signal });
    console.log("[intercom] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[intercom] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${INTERCOM_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Intercom request timed out after ${INTERCOM_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: IntercomArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: IntercomArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(token: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(token, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchIntercom(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Intercom ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callIntercomTool(tool: string, args: IntercomArgs, credential: string) {
  if (tool === "intercom/get_me") {
    return { structuredContent: await request(credential, "GET", "/me", undefined, tool) };
  }

  if (tool === "intercom/list_contacts") {
    const qs = queryString(args, ["per_page", "starting_after"]);
    return { structuredContent: await request(credential, "GET", `/contacts${qs}`, undefined, tool) };
  }

  if (tool === "intercom/get_contact") {
    const contactId = idArg(args, "contact_id");
    return { structuredContent: await request(credential, "GET", `/contacts/${encodeURIComponent(contactId)}`, undefined, tool, { contactId }) };
  }

  if (tool === "intercom/search_contacts") {
    const query = args.query;
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      throw new Error("query is required and must be an object");
    }
    return { structuredContent: await request(credential, "POST", "/contacts/search", { query }, tool) };
  }

  if (tool === "intercom/create_contact") {
    const email = String(args.email ?? "").trim();
    const externalId = String(args.external_id ?? args.externalId ?? "").trim();
    if (!email && !externalId) throw new Error("at least one of email or external_id is required");
    const body: Record<string, unknown> = { role: "user" };
    if (email) body.email = email;
    if (externalId) body.external_id = externalId;
    const name = String(args.name ?? "").trim();
    if (name) body.name = name;
    return { structuredContent: await request(credential, "POST", "/contacts", body, tool) };
  }

  if (tool === "intercom/list_conversations") {
    const qs = queryString(args, ["per_page", "starting_after"]);
    return { structuredContent: await request(credential, "GET", `/conversations${qs}`, undefined, tool) };
  }

  if (tool === "intercom/reply_conversation") {
    const conversationId = idArg(args, "conversation_id");
    const adminId = String(args.admin_id ?? args.adminId ?? "").trim();
    if (!adminId) throw new Error("admin_id is required");
    const body = String(args.body ?? "").trim();
    if (!body) throw new Error("body is required");
    const replyBody = {
      message_type: "comment",
      type: "admin",
      admin_id: adminId,
      body,
    };
    return { structuredContent: await request(credential, "POST", `/conversations/${encodeURIComponent(conversationId)}/reply`, replyBody, tool, { conversationId }) };
  }

  throw new Error(`Unknown Intercom tool: ${tool}`);
}
