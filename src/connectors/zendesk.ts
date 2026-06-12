// Zendesk connector — JSON credential {subdomain, email, token}.
// Auth: Basic with user="${email}/token" pass="${token}".
const ZENDESK_TIMEOUT_MS = 12_000;

type ZendeskArgs = Record<string, unknown>;

type ZendeskCredential = {
  subdomain: string;
  email: string;
  token: string;
};

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseZendeskCredential(credential: string): ZendeskCredential & { base: string; authHeader: string } {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Zendesk credential is empty");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      'Zendesk credential must be a JSON object like {"subdomain":"acme","email":"you@x.com","token":"..."}'
    );
  }
  const subdomain = String(parsed.subdomain ?? "").trim();
  const email = String(parsed.email ?? "").trim();
  const token = String(parsed.token ?? "").trim();
  if (!subdomain) throw new Error('Zendesk credential JSON must include "subdomain"');
  if (!email) throw new Error('Zendesk credential JSON must include "email"');
  if (!token) throw new Error('Zendesk credential JSON must include "token"');
  const base = `https://${subdomain}.zendesk.com/api/v2`;
  const authHeader = "Basic " + Buffer.from(`${email}/token:${token}`).toString("base64");
  return { subdomain, email, token, base, authHeader };
}

async function fetchZendesk(
  base: string,
  authHeader: string,
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZENDESK_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[zendesk] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[zendesk] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[zendesk] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${ZENDESK_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Zendesk request timed out after ${ZENDESK_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: ZendeskArgs, snake: string) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const value = String(args[snake] ?? args[camel] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

function queryString(args: ZendeskArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = args[key] ?? args[camel];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(
  base: string,
  authHeader: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {}
) {
  const hdrs: Record<string, string> = {
    Authorization: authHeader,
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const init: RequestInit = { method, headers: hdrs };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchZendesk(base, authHeader, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Zendesk ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callZendeskTool(tool: string, args: ZendeskArgs, credential: string) {
  const { base, authHeader } = parseZendeskCredential(credential);

  if (tool === "zendesk/list_tickets") {
    const qs = queryString(args, ["page", "per_page", "sort_by"]);
    return { structuredContent: await request(base, authHeader, "GET", `/tickets.json${qs}`, undefined, tool) };
  }

  if (tool === "zendesk/get_ticket") {
    const ticketId = idArg(args, "ticket_id");
    return {
      structuredContent: await request(
        base, authHeader, "GET",
        `/tickets/${encodeURIComponent(ticketId)}.json`,
        undefined, tool, { ticketId }
      ),
    };
  }

  if (tool === "zendesk/create_ticket") {
    const subject = String(args.subject ?? "").trim();
    if (!subject) throw new Error("subject is required");
    const body = String(args.body ?? "").trim();
    if (!body) throw new Error("body is required");
    return {
      structuredContent: await request(
        base, authHeader, "POST",
        "/tickets.json",
        { ticket: { subject, comment: { body } } },
        tool
      ),
    };
  }

  if (tool === "zendesk/update_ticket") {
    const ticketId = idArg(args, "ticket_id");
    // Accept either a full ticket object or individual fields
    let ticketUpdate: Record<string, unknown>;
    if (args.ticket && typeof args.ticket === "object" && !Array.isArray(args.ticket)) {
      ticketUpdate = args.ticket as Record<string, unknown>;
    } else {
      ticketUpdate = {};
      const status = String(args.status ?? "").trim();
      if (status) ticketUpdate.status = status;
      const priority = String(args.priority ?? "").trim();
      if (priority) ticketUpdate.priority = priority;
      const assigneeId = args.assignee_id ?? args.assigneeId;
      if (assigneeId !== undefined && assigneeId !== null && assigneeId !== "") ticketUpdate.assignee_id = assigneeId;
    }
    return {
      structuredContent: await request(
        base, authHeader, "PUT",
        `/tickets/${encodeURIComponent(ticketId)}.json`,
        { ticket: ticketUpdate },
        tool, { ticketId }
      ),
    };
  }

  if (tool === "zendesk/add_comment") {
    const ticketId = idArg(args, "ticket_id");
    const body = String(args.body ?? "").trim();
    if (!body) throw new Error("body is required");
    const isPublic = args.public !== undefined ? Boolean(args.public) : true;
    return {
      structuredContent: await request(
        base, authHeader, "PUT",
        `/tickets/${encodeURIComponent(ticketId)}.json`,
        { ticket: { comment: { body, public: isPublic } } },
        tool, { ticketId }
      ),
    };
  }

  if (tool === "zendesk/search") {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const params = new URLSearchParams({ query });
    return {
      structuredContent: await request(base, authHeader, "GET", `/search.json?${params.toString()}`, undefined, tool),
    };
  }

  if (tool === "zendesk/list_users") {
    const qs = queryString(args, ["page", "per_page", "role"]);
    return { structuredContent: await request(base, authHeader, "GET", `/users.json${qs}`, undefined, tool) };
  }

  throw new Error(`Unknown Zendesk tool: ${tool}`);
}
