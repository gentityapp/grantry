// Google Search Console connector — OAuth access tokens.
// Calls the Search Console API using the stored OAuth access token.
const GSC_API = "https://www.googleapis.com/webmasters/v3";
const GSC_TIMEOUT_MS = 8_000;

type GscArgs = Record<string, unknown>;

function googleHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
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

async function fetchGoogleGsc(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GSC_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_gsc] request", { path, ...logContext });
    const response = await fetch(`${GSC_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_gsc] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const durationMs = Date.now() - started;
    const aborted = e?.name === "AbortError";
    console.error("[google_gsc] failed", {
      path,
      durationMs,
      error: aborted ? `timeout after ${GSC_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Google GSC request timed out after ${GSC_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callGoogleGscTool(tool: string, args: GscArgs, token: string) {
  const headers = googleHeaders(token);

  if (tool === "google_gsc/list_sites") {
    const r = await fetchGoogleGsc("/sites", { headers }, { tool });
    const j = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google GSC list_sites failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        results: (j.siteEntry ?? []).map((site: any) => ({
          site_url: site.siteUrl,
          permission_level: site.permissionLevel,
        })),
      },
    };
  }

  if (tool === "google_gsc/search_analytics") {
    const siteUrl = String(args.site_url ?? args.siteUrl ?? "");
    if (!siteUrl) throw new Error("site_url is required");

    const startDate = String(args.start_date ?? args.startDate ?? "");
    const endDate = String(args.end_date ?? args.endDate ?? "");
    if (!startDate || !endDate) throw new Error("start_date and end_date are required");

    const body: Record<string, unknown> = {
      startDate,
      endDate,
      dimensions: Array.isArray(args.dimensions) ? args.dimensions : ["query", "page"],
      rowLimit: Number(args.row_limit ?? args.rowLimit ?? 1000),
    };

    const startRow = args.start_row ?? args.startRow;
    if (startRow !== undefined) body.startRow = Number(startRow);
    const searchType = args.search_type ?? args.searchType;
    if (searchType !== undefined) body.searchType = String(searchType);
    const aggregationType = args.aggregation_type ?? args.aggregationType;
    if (aggregationType !== undefined) body.aggregationType = String(aggregationType);
    const dimensionFilterGroups = args.dimension_filter_groups ?? args.dimensionFilterGroups;
    if (dimensionFilterGroups !== undefined) body.dimensionFilterGroups = dimensionFilterGroups;

    const r = await fetchGoogleGsc(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { tool, siteUrl, startDate, endDate });
    const j = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google GSC search_analytics failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        results: (j.rows ?? []).map((row: any) => ({
          keys: row.keys ?? [],
          clicks: row.clicks ?? 0,
          impressions: row.impressions ?? 0,
          ctr: row.ctr ?? 0,
          position: row.position ?? 0,
        })),
        response_aggregation_type: j.responseAggregationType,
      },
    };
  }

  throw new Error(`Unknown Google GSC tool: ${tool}`);
}
