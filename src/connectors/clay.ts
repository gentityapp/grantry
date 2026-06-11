// Clay connector - sends rows to a Clay webhook source.
const CLAY_TIMEOUT_MS = 10_000;

type ClayArgs = Record<string, unknown>;

type ClayCredential = {
  webhookUrl: string;
  authToken?: string;
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

function parseCredential(credential: string): ClayCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Clay webhook credential is empty");
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const webhookUrl = String(parsed.webhook_url ?? parsed.webhookUrl ?? parsed.url ?? "").trim();
    if (!webhookUrl) throw new Error("Clay credential JSON must include webhook_url");
    return {
      webhookUrl,
      authToken: String(parsed.auth_token ?? parsed.authToken ?? parsed.token ?? "").trim() || undefined,
    };
  }
  return { webhookUrl: trimmed };
}

function assertHttpUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Clay webhook URL must be http or https");
  }
  return parsed.toString();
}

function payloadFromArgs(args: ClayArgs) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) return args.data;
  if (args.row && typeof args.row === "object" && !Array.isArray(args.row)) return args.row;
  throw new Error("data object is required");
}

function rowsFromArgs(args: ClayArgs) {
  if (Array.isArray(args.rows)) return args.rows;
  if (Array.isArray(args.data)) return args.data;
  throw new Error("rows array is required");
}

async function fetchClayWebhook(credential: string, body: unknown, logContext: Record<string, unknown>) {
  const { webhookUrl, authToken } = parseCredential(credential);
  const url = assertHttpUrl(webhookUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[clay] request", { ...logContext });
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    console.log("[clay] response", { status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[clay] failed", {
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CLAY_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Clay webhook request timed out after ${CLAY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callClayTool(tool: string, args: ClayArgs, credential: string) {
  if (tool === "clay/send_webhook") {
    const body = payloadFromArgs(args);
    const r = await fetchClayWebhook(credential, body, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Clay send_webhook failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { status: r.status, data: j } };
  }

  if (tool === "clay/send_batch") {
    const rows = rowsFromArgs(args);
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const r = await fetchClayWebhook(credential, rows[i], { tool, rowIndex: i });
      const j: any = await readJsonResponse(r);
      if (!r.ok) throw new Error(`Clay send_batch failed at row ${i}: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
      results.push({ index: i, status: r.status, data: j });
    }
    return { structuredContent: { data: results } };
  }

  throw new Error(`Unknown Clay tool: ${tool}`);
}
