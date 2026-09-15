// AgentMail connector - API key authentication via Authorization: Bearer <key>.
// Targets the AgentMail REST API v0 (email inboxes built for agents): send and
// reply from an inbox, and read its messages and threads so an agent can pick up
// replies. Generic calls go through agentmail/request.
//
// Credential: paste an AgentMail API key (am_...), or JSON
//   {"api_key":"am_...","inbox_id":"press@example.com","region":"eu"}
// inbox_id becomes the default inbox for every tool (inbox-scoped keys only
// reach one inbox, so pinning it saves a lookup). Keys that start with am_eu_
// or region "eu" go to api.agentmail.eu; everything else to api.agentmail.to.
const AGENTMAIL_API_US = "https://api.agentmail.to/v0";
const AGENTMAIL_API_EU = "https://api.agentmail.eu/v0";
const AGENTMAIL_TIMEOUT_MS = 60_000;

type AgentMailArgs = Record<string, unknown>;

type AgentMailCredential = {
  apiKey: string;
  inboxId?: string;
  region: "us" | "eu";
};

export function parseAgentMailCredential(raw: string): AgentMailCredential {
  const trimmed = String(raw ?? "").trim();
  let apiKey = trimmed;
  let inboxId = "";
  let region = "";
  if (trimmed.startsWith("{")) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('AgentMail credential JSON is invalid; expected {"api_key":"am_..."}');
    }
    apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
    inboxId = String(parsed.inbox_id ?? parsed.inboxId ?? "").trim();
    region = String(parsed.region ?? "").trim().toLowerCase();
  }
  if (!apiKey) throw new Error("AgentMail API key is required");
  return {
    apiKey,
    ...(inboxId ? { inboxId } : {}),
    region: region === "eu" || apiKey.startsWith("am_eu_") ? "eu" : "us",
  };
}

export function agentMailBaseUrl(credential: AgentMailCredential) {
  return credential.region === "eu" ? AGENTMAIL_API_EU : AGENTMAIL_API_US;
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
  credential: AgentMailCredential,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  extraHeaders: Record<string, string> = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENTMAIL_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[agentmail] request", { path, tool });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.apiKey}`,
      Accept: "application/json",
      ...extraHeaders,
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${agentMailBaseUrl(credential)}${path}`, init);
    console.log("[agentmail] response", { path, tool, status: r.status, durationMs: Date.now() - started });
    const j: any = await readJsonResponse(r);
    if (!r.ok) {
      const message = j?.message ?? j?.error ?? j?.name ?? JSON.stringify(j).slice(0, 1000);
      throw new Error(`AgentMail ${tool} failed: ${r.status} ${typeof message === "string" ? message : JSON.stringify(message)}`);
    }
    return j;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`AgentMail request timed out after ${AGENTMAIL_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function queryString(params: Record<string, unknown>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) qs.append(k, String(item));
      continue;
    }
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function inboxPath(credential: AgentMailCredential, args: AgentMailArgs) {
  const inboxId = String(args.inbox_id ?? credential.inboxId ?? "").trim();
  if (!inboxId) {
    throw new Error("inbox_id is required (pass it, or save the connection as JSON with inbox_id; agentmail/list_inboxes shows the ids this key can reach)");
  }
  return `/inboxes/${encodeURIComponent(inboxId)}`;
}

function requiredId(args: AgentMailArgs, key: string) {
  const value = String(args[key] ?? "").trim();
  if (!value) throw new Error(`${key} is required`);
  return encodeURIComponent(value);
}

const MESSAGE_FIELDS = ["to", "cc", "bcc", "reply_to", "subject", "text", "html", "labels", "attachments", "headers", "track_opens"];

function messageBody(args: AgentMailArgs, fields = MESSAGE_FIELDS) {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (args[field] !== undefined && args[field] !== null && args[field] !== "") body[field] = args[field];
  }
  return body;
}

// Sends are irreversible, so callers can pass idempotency_key to make a retry safe.
function sendHeaders(args: AgentMailArgs): Record<string, string> {
  const key = String(args.idempotency_key ?? "").trim();
  return key ? { "Idempotency-Key": key } : {};
}

function listQuery(args: AgentMailArgs) {
  return queryString({
    limit: args.limit,
    page_token: args.page_token,
    labels: args.labels,
    before: args.before,
    after: args.after,
    ascending: args.ascending,
    include_spam: args.include_spam,
  });
}

export async function callAgentMailTool(
  tool: string,
  args: AgentMailArgs,
  rawCredential: string,
) {
  const credential = parseAgentMailCredential(rawCredential);

  if (tool === "agentmail/list_inboxes") {
    const qs = queryString({ limit: args.limit, page_token: args.page_token });
    return { structuredContent: await request(credential, "GET", `/inboxes${qs}`, undefined, tool) };
  }

  if (tool === "agentmail/get_inbox") {
    return { structuredContent: await request(credential, "GET", inboxPath(credential, args), undefined, tool) };
  }

  if (tool === "agentmail/send_message") {
    const body = messageBody(args);
    if (!body.to) throw new Error("to is required");
    if (!body.subject) throw new Error("subject is required");
    if (!body.text && !body.html) throw new Error("text or html is required");
    const path = `${inboxPath(credential, args)}/messages/send`;
    return { structuredContent: await request(credential, "POST", path, body, tool, sendHeaders(args)) };
  }

  if (tool === "agentmail/reply_message") {
    const body = messageBody(args, ["text", "html", "labels", "attachments", "headers", "reply_to", "cc", "bcc"]);
    if (!body.text && !body.html) throw new Error("text or html is required");
    const action = args.reply_all === true ? "reply-all" : "reply";
    const path = `${inboxPath(credential, args)}/messages/${requiredId(args, "message_id")}/${action}`;
    return { structuredContent: await request(credential, "POST", path, body, tool, sendHeaders(args)) };
  }

  if (tool === "agentmail/list_messages") {
    const path = `${inboxPath(credential, args)}/messages${listQuery(args)}`;
    return { structuredContent: await request(credential, "GET", path, undefined, tool) };
  }

  if (tool === "agentmail/get_message") {
    const path = `${inboxPath(credential, args)}/messages/${requiredId(args, "message_id")}`;
    return { structuredContent: await request(credential, "GET", path, undefined, tool) };
  }

  if (tool === "agentmail/list_threads") {
    const path = `${inboxPath(credential, args)}/threads${listQuery(args)}`;
    return { structuredContent: await request(credential, "GET", path, undefined, tool) };
  }

  if (tool === "agentmail/get_thread") {
    const path = `${inboxPath(credential, args)}/threads/${requiredId(args, "thread_id")}`;
    return { structuredContent: await request(credential, "GET", path, undefined, tool) };
  }

  throw new Error(`Unknown AgentMail tool: ${tool}`);
}
