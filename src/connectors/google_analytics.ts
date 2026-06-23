// Google Analytics connector — GA4 Admin + Data APIs using OAuth access tokens.
const GA_ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const GA_DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const GA_TIMEOUT_MS = 10_000;

type GaArgs = Record<string, unknown>;

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

async function fetchGoogleAnalytics(url: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GA_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_analytics] request", { url, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[google_analytics] response", {
      url,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_analytics] failed", {
      url,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${GA_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Google Analytics request timed out after ${GA_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function propertyPath(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("properties/") ? raw : `properties/${raw}`;
}

function accountPath(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("accounts/") ? raw : `accounts/${raw}`;
}

function namesArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const names = value.map((v) => String(v).trim()).filter(Boolean);
  return names.length ? names : fallback;
}

export async function callGoogleAnalyticsTool(tool: string, args: GaArgs, token: string) {
  const headers = googleHeaders(token);

  if (tool === "google_analytics/list_properties") {
    const pageSize = Math.min(Math.max(Number(args.page_size ?? args.pageSize ?? 200) || 200, 1), 200);
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    const url = new URL(`${GA_ADMIN_API}/accountSummaries`);
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const r = await fetchGoogleAnalytics(url.toString(), { headers }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Analytics list_properties failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        results: (j.accountSummaries ?? []).map((account: any) => ({
          account: account.account,
          account_id: String(account.account ?? "").replace(/^accounts\//, ""),
          display_name: account.displayName,
          properties: (account.propertySummaries ?? []).map((property: any) => ({
            property: property.property,
            property_id: String(property.property ?? "").replace(/^properties\//, ""),
            display_name: property.displayName,
            property_type: property.propertyType,
            parent: property.parent,
          })),
        })),
        next_page_token: j.nextPageToken ?? null,
      },
    };
  }

  if (tool === "google_analytics/run_report") {
    const property = propertyPath(args.property_id ?? args.propertyId ?? args.property);
    if (!property) throw new Error("property_id is required");
    const startDate = String(args.start_date ?? args.startDate ?? "");
    const endDate = String(args.end_date ?? args.endDate ?? "");
    if (!startDate || !endDate) throw new Error("start_date and end_date are required");

    const dimensions = namesArray(args.dimensions, ["date"]).map((name) => ({ name }));
    const metrics = namesArray(args.metrics, ["activeUsers", "sessions"]).map((name) => ({ name }));
    const body: Record<string, unknown> = {
      dateRanges: [{ startDate, endDate }],
      dimensions,
      metrics,
      limit: String(Math.min(Math.max(Number(args.limit ?? args.row_limit ?? args.rowLimit ?? 1000) || 1000, 1), 250000)),
    };
    const offset = args.offset ?? args.start_row ?? args.startRow;
    if (offset !== undefined) body.offset = String(Math.max(Number(offset) || 0, 0));
    if (args.dimension_filter !== undefined) body.dimensionFilter = args.dimension_filter;
    if (args.dimensionFilter !== undefined) body.dimensionFilter = args.dimensionFilter;
    if (args.metric_filter !== undefined) body.metricFilter = args.metric_filter;
    if (args.metricFilter !== undefined) body.metricFilter = args.metricFilter;
    if (args.order_bys !== undefined) body.orderBys = args.order_bys;
    if (args.orderBys !== undefined) body.orderBys = args.orderBys;
    if (args.keep_empty_rows !== undefined) body.keepEmptyRows = Boolean(args.keep_empty_rows);
    if (args.keepEmptyRows !== undefined) body.keepEmptyRows = Boolean(args.keepEmptyRows);

    const r = await fetchGoogleAnalytics(`${GA_DATA_API}/${property}:runReport`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { tool, property, startDate, endDate });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Analytics run_report failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        property,
        dimension_headers: (j.dimensionHeaders ?? []).map((h: any) => h.name),
        metric_headers: (j.metricHeaders ?? []).map((h: any) => ({ name: h.name, type: h.type })),
        rows: (j.rows ?? []).map((row: any) => ({
          dimensions: (row.dimensionValues ?? []).map((v: any) => v.value),
          metrics: (row.metricValues ?? []).map((v: any) => v.value),
        })),
        row_count: j.rowCount ?? 0,
        metadata: j.metadata,
      },
    };
  }

  if (tool === "google_analytics/list_data_streams") {
    const property = propertyPath(args.property_id ?? args.propertyId ?? args.property);
    if (!property) throw new Error("property_id is required");
    const pageSize = Math.min(Math.max(Number(args.page_size ?? args.pageSize ?? 200) || 200, 1), 200);
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    const url = new URL(`${GA_ADMIN_API}/${property}/dataStreams`);
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const r = await fetchGoogleAnalytics(url.toString(), { headers }, { tool, property });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Analytics list_data_streams failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        property,
        data_streams: (j.dataStreams ?? []).map((s: any) => ({
          name: s.name,
          display_name: s.displayName,
          type: s.type,
          // For WEB_DATA_STREAM, webStreamData.measurementId is the "G-XXXX" tag id.
          measurement_id: s.webStreamData?.measurementId ?? null,
          default_uri: s.webStreamData?.defaultUri ?? null,
          firebase_app_id: s.androidAppStreamData?.firebaseAppId ?? s.iosAppStreamData?.firebaseAppId ?? null,
        })),
        next_page_token: j.nextPageToken ?? null,
      },
    };
  }

  if (tool === "google_analytics/create_property") {
    // Requires the analytics.edit OAuth scope. Creates a new GA4 property under an account.
    const parent = accountPath(args.account_id ?? args.accountId ?? args.account ?? args.parent);
    if (!parent) throw new Error("account_id is required (e.g. 123456 or accounts/123456)");
    const displayName = String(args.display_name ?? args.displayName ?? "").trim();
    if (!displayName) throw new Error("display_name is required");
    const body: Record<string, unknown> = {
      parent,
      displayName,
      timeZone: String(args.time_zone ?? args.timeZone ?? "Asia/Tokyo").trim() || "Asia/Tokyo",
      currencyCode: String(args.currency_code ?? args.currencyCode ?? "JPY").trim() || "JPY",
    };
    const industry = String(args.industry_category ?? args.industryCategory ?? "").trim();
    if (industry) body.industryCategory = industry;

    const r = await fetchGoogleAnalytics(`${GA_ADMIN_API}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { tool, parent });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Analytics create_property failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        property: j.name,
        property_id: String(j.name ?? "").replace(/^properties\//, ""),
        display_name: j.displayName,
        parent: j.parent,
        time_zone: j.timeZone,
        currency_code: j.currencyCode,
        property_type: j.propertyType,
        create_time: j.createTime,
      },
    };
  }

  if (tool === "google_analytics/create_data_stream") {
    // Requires the analytics.edit OAuth scope. Creates a WEB data stream and returns its measurement id (G-XXXX).
    const property = propertyPath(args.property_id ?? args.propertyId ?? args.property);
    if (!property) throw new Error("property_id is required");
    const defaultUri = String(args.default_uri ?? args.defaultUri ?? args.url ?? "").trim();
    if (!defaultUri) throw new Error("default_uri is required (the website URL, e.g. https://one-webinar.ai)");
    const displayName = String(args.display_name ?? args.displayName ?? "").trim() || defaultUri;
    const body = {
      type: "WEB_DATA_STREAM",
      displayName,
      webStreamData: { defaultUri },
    };

    const r = await fetchGoogleAnalytics(`${GA_ADMIN_API}/${property}/dataStreams`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { tool, property });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Analytics create_data_stream failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        property,
        name: j.name,
        display_name: j.displayName,
        type: j.type,
        // measurement_id is the "G-XXXX" tag id to embed on the site.
        measurement_id: j.webStreamData?.measurementId ?? null,
        default_uri: j.webStreamData?.defaultUri ?? null,
        stream_id: String(j.name ?? "").split("/").pop() ?? null,
        create_time: j.createTime,
      },
    };
  }

  throw new Error(`Unknown Google Analytics tool: ${tool}`);
}
