// Gmail connector — OAuth access token.
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_TIMEOUT_MS = 10_000;

type GmailArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchGmail(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GMAIL_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[gmail] request", { path, ...logContext });
    const response = await fetch(`${GMAIL_API}${path}`, { ...init, signal: controller.signal });
    console.log("[gmail] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[gmail] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${GMAIL_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Gmail request timed out after ${GMAIL_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function headerLine(name: string, value: unknown) {
  const s = String(value ?? "").replace(/\r?\n/g, " ").trim();
  return s ? `${name}: ${s}` : "";
}

/**
 * RFC 2047 encoded-word for a free-text header (Subject). Raw UTF-8 in a header is read as
 * Latin-1 by mail clients: a Japanese subject sent in 2026-09-19 arrived as "Ã£ÂƒÂ«…" while the
 * body (declared charset) rendered fine. ASCII-only values are returned unchanged. Long values are
 * split into several encoded-words so each stays within the 75-character limit.
 */
export function encodeMimeHeaderValue(value: string) {
  const s = String(value ?? "").replace(/\r?\n/g, " ").trim();
  if (!s || /^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    // "=?UTF-8?B?" + base64 + "?=" must stay <= 75 chars → at most 45 bytes of input per word
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words.join(" ");
}

export async function callGmailTool(tool: string, args: GmailArgs, token: string) {
  if (tool === "gmail/list_messages") {
    const params = new URLSearchParams();
    const q = String(args.q ?? args.query ?? "").trim();
    if (q) params.set("q", q);
    const maxResults = Number(args.max_results ?? args.maxResults ?? 10);
    params.set("maxResults", String(Number.isFinite(maxResults) ? Math.min(Math.max(Math.floor(maxResults), 1), 100) : 10));
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetchGmail(`/messages?${params.toString()}`, { headers: headers(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Gmail list_messages failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: { messages: j.messages ?? [], next_page_token: j.nextPageToken ?? null, result_size_estimate: j.resultSizeEstimate ?? null } };
  }

  if (tool === "gmail/get_message") {
    const messageId = String(args.message_id ?? args.messageId ?? "").trim();
    if (!messageId) throw new Error("message_id is required");
    const format = String(args.format ?? "metadata").trim();
    const params = new URLSearchParams({ format });
    const r = await fetchGmail(`/messages/${encodeURIComponent(messageId)}?${params.toString()}`, { headers: headers(token) }, { tool, messageId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Gmail get_message failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: j };
  }

  if (tool === "gmail/send_message") {
    const to = String(args.to ?? "").trim();
    const subject = String(args.subject ?? "").trim();
    const body = String(args.body ?? "");
    if (!to || !subject || !body) throw new Error("to, subject, and body are required");
    const mimeType = String(args.mime_type ?? args.mimeType ?? "text/plain; charset=UTF-8").trim();
    const messageHeaders = [
      headerLine("To", to),
      headerLine("Cc", args.cc),
      headerLine("Bcc", args.bcc),
      headerLine("Reply-To", args.reply_to ?? args.replyTo),
      headerLine("Subject", encodeMimeHeaderValue(subject)),
      "MIME-Version: 1.0",
      `Content-Type: ${mimeType}`,
    ].filter(Boolean);
    const lines = [
      ...messageHeaders,
      "",
      body,
    ];
    const payload: Record<string, unknown> = { raw: base64Url(lines.join("\r\n")) };
    const threadId = String(args.thread_id ?? args.threadId ?? "").trim();
    if (threadId) payload.threadId = threadId;
    const r = await fetchGmail("/messages/send", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(payload),
    }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Gmail send_message failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  throw new Error(`Unknown Gmail tool: ${tool}`);
}
