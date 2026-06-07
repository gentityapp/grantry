// Google Ads connector — OAuth access token + Google Ads API developer token.
const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v22";
const GOOGLE_ADS_API = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const GOOGLE_ADS_TIMEOUT_MS = 10_000;

type AdsArgs = Record<string, unknown>;

function adsHeaders(token: string, args: AdsArgs, developerTokenOverride?: string | null) {
  const developerToken = developerTokenOverride || process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) throw new Error("Google Ads developer token is required. Add it to this Google Ads connection in the tenant UI.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": developerToken,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const loginCustomerId = String(args.login_customer_id ?? args.loginCustomerId ?? "").replace(/-/g, "").trim();
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  return headers;
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

async function fetchGoogleAds(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_ADS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_ads] request", { path, apiVersion: GOOGLE_ADS_API_VERSION, ...logContext });
    const response = await fetch(`${GOOGLE_ADS_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_ads] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_ads] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${GOOGLE_ADS_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Google Ads request timed out after ${GOOGLE_ADS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function customerId(value: unknown) {
  return String(value ?? "").replace(/-/g, "").trim();
}

export async function callGoogleAdsTool(tool: string, args: AdsArgs, token: string, developerToken?: string | null) {
  const headers = adsHeaders(token, args, developerToken);

  if (tool === "google_ads/list_accessible_customers") {
    const r = await fetchGoogleAds("/customers:listAccessibleCustomers", { headers }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Ads list_accessible_customers failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
    return {
      structuredContent: {
        api_version: GOOGLE_ADS_API_VERSION,
        results: (j.resourceNames ?? []).map((name: string) => ({
          resource_name: name,
          customer_id: String(name).replace(/^customers\//, ""),
        })),
      },
    };
  }

  if (tool === "google_ads/search") {
    const cid = customerId(args.customer_id ?? args.customerId);
    const query = String(args.query ?? "").trim();
    if (!cid || !query) throw new Error("customer_id and query are required");

    const body: Record<string, unknown> = { query };
    const pageSize = Number(args.page_size ?? args.pageSize);
    if (Number.isFinite(pageSize) && pageSize > 0) body.pageSize = Math.min(Math.floor(pageSize), 10000);
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) body.pageToken = pageToken;

    const r = await fetchGoogleAds(`/customers/${cid}/googleAds:search`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { tool, customerId: cid });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Ads search failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return {
      structuredContent: {
        api_version: GOOGLE_ADS_API_VERSION,
        results: j.results ?? [],
        next_page_token: j.nextPageToken ?? null,
        field_mask: j.fieldMask ?? null,
        summary_row: j.summaryRow ?? null,
      },
    };
  }

  if (tool === "google_ads/mutate") {
    const cid = customerId(args.customer_id ?? args.customerId);
    const operations = Array.isArray(args.operations) ? args.operations : null;
    if (!cid || !operations || operations.length === 0) {
      throw new Error("customer_id and non-empty operations array are required");
    }

    const body: Record<string, unknown> = { mutateOperations: operations };
    if (typeof args.partial_failure === "boolean") body.partialFailure = args.partial_failure;
    if (typeof args.partialFailure === "boolean") body.partialFailure = args.partialFailure;
    if (typeof args.validate_only === "boolean") body.validateOnly = args.validate_only;
    if (typeof args.validateOnly === "boolean") body.validateOnly = args.validateOnly;
    const responseContentType = String(args.response_content_type ?? args.responseContentType ?? "").trim();
    if (responseContentType) body.responseContentType = responseContentType;

    const r = await fetchGoogleAds(`/customers/${cid}/googleAds:mutate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { tool, customerId: cid, operationCount: operations.length });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Ads mutate failed: ${r.status} ${JSON.stringify(j).slice(0, 1500)}`);
    return {
      structuredContent: {
        api_version: GOOGLE_ADS_API_VERSION,
        results: j.mutateOperationResponses ?? j.results ?? [],
        partial_failure_error: j.partialFailureError ?? null,
      },
    };
  }

  throw new Error(`Unknown Google Ads tool: ${tool}`);
}
