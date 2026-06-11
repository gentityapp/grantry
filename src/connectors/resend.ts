// Resend connector - API key authentication via Authorization: Bearer.
const RESEND_API = "https://api.resend.com";
const RESEND_TIMEOUT_MS = 12_000;

type ResendArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchResend(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[resend] request", { path, ...logContext });
    const response = await fetch(`${RESEND_API}${path}`, { ...init, signal: controller.signal });
    console.log("[resend] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[resend] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${RESEND_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Resend request timed out after ${RESEND_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function stringOrArray(value: unknown) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  const s = String(value ?? "").trim();
  if (!s) return undefined;
  if (s.includes(",")) return s.split(",").map((v) => v.trim()).filter(Boolean);
  return s;
}

function idArg(args: ResendArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: ResendArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function emailBody(args: ResendArgs) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data;
  const body: Record<string, unknown> = {
    from: args.from,
    to: stringOrArray(args.to),
    subject: args.subject,
  };
  const optional = ["html", "text", "react", "cc", "bcc", "reply_to", "scheduled_at", "headers", "attachments", "tags"];
  for (const key of optional) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    body[key] = key === "cc" || key === "bcc" || key === "reply_to" ? stringOrArray(value) : value;
  }
  if (!body.from) throw new Error("from is required");
  if (!body.to) throw new Error("to is required");
  if (!body.subject) throw new Error("subject is required");
  if (!body.html && !body.text && !body.react) throw new Error("one of html, text, or react is required");
  return body;
}

async function requestJson(apiKey: string, method: string, path: string, body: unknown, tool: string) {
  const init: RequestInit = { method, headers: headers(apiKey) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchResend(path, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Resend ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callResendTool(tool: string, args: ResendArgs, apiKey: string) {
  if (tool === "resend/send_email") {
    return { structuredContent: await requestJson(apiKey, "POST", "/emails", emailBody(args), tool) };
  }

  if (tool === "resend/list_emails") {
    const qs = queryString(args, ["limit", "after", "before"]);
    return { structuredContent: await requestJson(apiKey, "GET", `/emails${qs}`, undefined, tool) };
  }

  if (tool === "resend/get_email") {
    const emailId = idArg(args, "email_id", ["id"]);
    return { structuredContent: await requestJson(apiKey, "GET", `/emails/${encodeURIComponent(emailId)}`, undefined, tool) };
  }

  if (tool === "resend/list_domains") {
    return { structuredContent: await requestJson(apiKey, "GET", "/domains", undefined, tool) };
  }

  if (tool === "resend/get_domain") {
    const domainId = idArg(args, "domain_id", ["id"]);
    return { structuredContent: await requestJson(apiKey, "GET", `/domains/${encodeURIComponent(domainId)}`, undefined, tool) };
  }

  if (tool === "resend/list_api_keys") {
    return { structuredContent: await requestJson(apiKey, "GET", "/api-keys", undefined, tool) };
  }

  throw new Error(`Unknown Resend tool: ${tool}`);
}
