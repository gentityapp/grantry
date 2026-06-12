// BigQuery connector - OAuth access token via Authorization: Bearer.
// Targets the BigQuery REST API v2 (scoped to a project).
const BQ_API = "https://bigquery.googleapis.com/bigquery/v2";
const BQ_TIMEOUT_MS = 12_000;

type BqArgs = Record<string, unknown>;

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

async function fetchBq(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BQ_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[bigquery] request", { path, ...logContext });
    const response = await fetch(`${BQ_API}${path}`, { ...init, signal: controller.signal });
    console.log("[bigquery] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[bigquery] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${BQ_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`BigQuery request timed out after ${BQ_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: BqArgs, snake: string, aliases: string[] = []) {
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
  const r = await fetchBq(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`BigQuery ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callBigQueryTool(tool: string, args: BqArgs, accessToken: string) {
  if (tool === "bigquery/list_datasets") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    const params = new URLSearchParams();
    if (args.max_results ?? args.maxResults) params.set("maxResults", String(args.max_results ?? args.maxResults));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    if (args.all) params.set("all", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `/projects/${encodeURIComponent(projectId)}/datasets${qs}`, undefined, tool, { projectId }) };
  }

  if (tool === "bigquery/list_tables") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    const datasetId = idArg(args, "dataset_id", ["datasetId"]);
    const params = new URLSearchParams();
    if (args.max_results ?? args.maxResults) params.set("maxResults", String(args.max_results ?? args.maxResults));
    if (args.page_token ?? args.pageToken) params.set("pageToken", String(args.page_token ?? args.pageToken));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables${qs}`, undefined, tool, { projectId, datasetId }) };
  }

  if (tool === "bigquery/get_table") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    const datasetId = idArg(args, "dataset_id", ["datasetId"]);
    const tableId = idArg(args, "table_id", ["tableId"]);
    return { structuredContent: await request(accessToken, "GET", `/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableId)}`, undefined, tool, { projectId, datasetId, tableId }) };
  }

  if (tool === "bigquery/query") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    const query = idArg(args, "query");
    const body: Record<string, unknown> = {
      query,
      useLegacySql: args.use_legacy_sql ?? args.useLegacySql ?? false,
    };
    if (args.max_results ?? args.maxResults) body.maxResults = args.max_results ?? args.maxResults;
    if (args.timeout_ms ?? args.timeoutMs) body.timeoutMs = args.timeout_ms ?? args.timeoutMs;
    if (args.default_dataset ?? args.defaultDataset) body.defaultDataset = args.default_dataset ?? args.defaultDataset;
    if (args.dry_run ?? args.dryRun) body.dryRun = args.dry_run ?? args.dryRun;
    return { structuredContent: await request(accessToken, "POST", `/projects/${encodeURIComponent(projectId)}/queries`, body, tool, { projectId }) };
  }

  if (tool === "bigquery/get_job") {
    const projectId = idArg(args, "project_id", ["projectId"]);
    const jobId = idArg(args, "job_id", ["jobId"]);
    const params = new URLSearchParams();
    if (args.location) params.set("location", String(args.location));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}${qs}`, undefined, tool, { projectId, jobId }) };
  }

  throw new Error(`Unknown BigQuery tool: ${tool}`);
}
