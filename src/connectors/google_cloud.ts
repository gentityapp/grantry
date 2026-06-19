// Google Cloud connector - OAuth access token via Authorization: Bearer.
// Covers Cloud Resource Manager (projects), Service Usage, Cloud Logging (read),
// and Cloud Billing (billing account config + pricing catalog, read-only).
// NOTE: actual spend/cost figures are NOT exposed by the Cloud Billing API —
// enable Cloud Billing export to BigQuery and query it via the bigquery connector.
const GCLOUD_TIMEOUT_MS = 12_000;
const CLOUD_BILLING_API = "https://cloudbilling.googleapis.com/v1";

/** Normalize a billing account id to the `billingAccounts/<id>` resource name. */
function billingAccountName(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("billing_account_id is required");
  return raw.startsWith("billingAccounts/") ? raw : `billingAccounts/${raw}`;
}

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

  // --- Cloud Billing: billing account config (read-only) ---
  if (tool === "google_cloud/list_billing_accounts") {
    const params = new URLSearchParams();
    if (args.filter) params.set("filter", String(args.filter));
    if (args.page_size ?? args.pageSize) params.set("pageSize", String(args.page_size ?? args.pageSize));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `${CLOUD_BILLING_API}/billingAccounts${qs}`, undefined, tool) };
  }

  if (tool === "google_cloud/get_billing_account") {
    const name = billingAccountName(args.billing_account_id ?? args.billingAccountId ?? args.name);
    return { structuredContent: await request(accessToken, "GET", `${CLOUD_BILLING_API}/${name}`, undefined, tool, { name }) };
  }

  if (tool === "google_cloud/list_billing_account_projects") {
    const name = billingAccountName(args.billing_account_id ?? args.billingAccountId ?? args.name);
    const params = new URLSearchParams();
    if (args.page_size ?? args.pageSize) params.set("pageSize", String(args.page_size ?? args.pageSize));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `${CLOUD_BILLING_API}/${name}/projects${qs}`, undefined, tool, { name }) };
  }

  if (tool === "google_cloud/get_project_billing_info") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    return { structuredContent: await request(accessToken, "GET", `${CLOUD_BILLING_API}/projects/${encodeURIComponent(projectId)}/billingInfo`, undefined, tool, { projectId }) };
  }

  // --- Cloud Billing: pricing catalog (read-only) ---
  if (tool === "google_cloud/list_billing_services") {
    const params = new URLSearchParams();
    if (args.page_size ?? args.pageSize) params.set("pageSize", String(args.page_size ?? args.pageSize));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `${CLOUD_BILLING_API}/services${qs}`, undefined, tool) };
  }

  if (tool === "google_cloud/list_skus") {
    const serviceId = idArg(args, "service_id", ["serviceId"]).replace(/^services\//, "");
    const params = new URLSearchParams();
    if (args.currency_code ?? args.currencyCode) params.set("currencyCode", String(args.currency_code ?? args.currencyCode));
    if (args.start_time ?? args.startTime) params.set("startTime", String(args.start_time ?? args.startTime));
    if (args.end_time ?? args.endTime) params.set("endTime", String(args.end_time ?? args.endTime));
    if (args.page_size ?? args.pageSize) params.set("pageSize", String(args.page_size ?? args.pageSize));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `${CLOUD_BILLING_API}/services/${encodeURIComponent(serviceId)}/skus${qs}`, undefined, tool, { serviceId }) };
  }

  throw new Error(`Unknown Google Cloud tool: ${tool}`);
}
