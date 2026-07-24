// Google Forms connector - OAuth access token via Authorization: Bearer.
// Targets the Google Forms API v1.
const GFORMS_API = "https://forms.googleapis.com/v1";
const GFORMS_TIMEOUT_MS = 12_000;

type GFormsArgs = Record<string, unknown>;

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

async function fetchGForms(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GFORMS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_forms] request", { path, ...logContext });
    const response = await fetch(`${GFORMS_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_forms] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_forms] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${GFORMS_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Google Forms request timed out after ${GFORMS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GFormsArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function request(accessToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchGForms(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Forms ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callGoogleFormsTool(tool: string, args: GFormsArgs, accessToken: string) {
  if (tool === "google_forms/get_form") {
    const formId = idArg(args, "form_id", ["formId"]);
    return { structuredContent: await request(accessToken, "GET", `/forms/${encodeURIComponent(formId)}`, undefined, tool, { formId }) };
  }

  if (tool === "google_forms/create_form") {
    const title = idArg(args, "title");
    const documentTitle = String(args.document_title ?? args.documentTitle ?? "").trim();
    const info: Record<string, unknown> = { title };
    if (documentTitle) info.documentTitle = documentTitle;
    return { structuredContent: await request(accessToken, "POST", "/forms", { info }, tool) };
  }

  if (tool === "google_forms/batch_update") {
    const formId = idArg(args, "form_id", ["formId"]);
    const requests = args.requests;
    if (!Array.isArray(requests) || !requests.length) throw new Error("requests (non-empty array of Forms batchUpdate request objects) is required");
    const body: Record<string, unknown> = { requests };
    if (args.include_form_in_response ?? args.includeFormInResponse) body.includeFormInResponse = true;
    if (args.write_control ?? args.writeControl) body.writeControl = args.write_control ?? args.writeControl;
    return { structuredContent: await request(accessToken, "POST", `/forms/${encodeURIComponent(formId)}:batchUpdate`, body, tool, { formId, requestCount: requests.length }) };
  }

  if (tool === "google_forms/list_responses") {
    const formId = idArg(args, "form_id", ["formId"]);
    const params = new URLSearchParams();
    const filter = String(args.filter ?? "").trim();
    if (filter) params.set("filter", filter);
    const pageSize = Number(args.page_size ?? args.pageSize ?? 0);
    if (pageSize > 0) params.set("pageSize", String(Math.min(pageSize, 5000)));
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) params.set("pageToken", pageToken);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `/forms/${encodeURIComponent(formId)}/responses${qs}`, undefined, tool, { formId }) };
  }

  if (tool === "google_forms/get_response") {
    const formId = idArg(args, "form_id", ["formId"]);
    const responseId = idArg(args, "response_id", ["responseId"]);
    return { structuredContent: await request(accessToken, "GET", `/forms/${encodeURIComponent(formId)}/responses/${encodeURIComponent(responseId)}`, undefined, tool, { formId, responseId }) };
  }

  throw new Error(`Unknown Google Forms tool: ${tool}`);
}
