// Google Cloud connector - OAuth access token via Authorization: Bearer.
// Covers Cloud Resource Manager (projects) and Cloud Logging (read).
const GCLOUD_TIMEOUT_MS = 12_000;

type GCloudArgs = Record<string, unknown>;

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

async function fetchGCloud(url: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GCLOUD_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_cloud] request", { url, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[google_cloud] response", { url, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_cloud] failed", { url, durationMs: Date.now() - started, error: aborted ? `timeout after ${GCLOUD_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Google Cloud request timed out after ${GCLOUD_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GCloudArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function request(accessToken: string, method: string, url: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchGCloud(url, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Cloud ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callGoogleCloudTool(tool: string, args: GCloudArgs, accessToken: string) {
  if (tool === "google_cloud/list_projects") {
    const params = new URLSearchParams();
    if (args.filter) params.set("filter", String(args.filter));
    if (args.page_size ?? args.pageSize) params.set("pageSize", String(args.page_size ?? args.pageSize));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `https://cloudresourcemanager.googleapis.com/v1/projects${qs}`, undefined, tool) };
  }

  if (tool === "google_cloud/get_project") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    return { structuredContent: await request(accessToken, "GET", `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`, undefined, tool, { projectId }) };
  }

  if (tool === "google_cloud/list_services") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    const params = new URLSearchParams();
    if (args.page_size ?? args.pageSize) params.set("pageSize", String(args.page_size ?? args.pageSize));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services${qs}`, undefined, tool, { projectId }) };
  }

  if (tool === "google_cloud/list_log_entries") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    const body: Record<string, unknown> = {
      resourceNames: [`projects/${projectId}`],
      pageSize: args.page_size ?? args.pageSize ?? 50,
    };
    if (args.filter) body.filter = args.filter;
    if (args.order_by ?? args.orderBy) body.orderBy = args.order_by ?? args.orderBy;
    if (args.page_token ?? args.pageToken) body.pageToken = args.page_token ?? args.pageToken;
    return { structuredContent: await request(accessToken, "POST", "https://logging.googleapis.com/v2/entries:list", body, tool, { projectId }) };
  }

  throw new Error(`Unknown Google Cloud tool: ${tool}`);
}
