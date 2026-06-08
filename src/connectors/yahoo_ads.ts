// LINE Yahoo Ads connector — OAuth access token.
const YAHOO_ADS_API_VERSION = process.env.YAHOO_ADS_API_VERSION || "v17";
const YAHOO_ADS_TIMEOUT_MS = 10_000;

type YahooAdsArgs = Record<string, unknown>;

const PRODUCT_BASE_URLS: Record<string, string> = {
  search: "https://ads-search.yahooapis.jp/api",
  display: "https://ads-display.yahooapis.jp/api",
};

function product(value: unknown) {
  const v = String(value ?? "search").trim().toLowerCase();
  if (v === "search" || v === "display") return v;
  throw new Error("product must be either search or display");
}

function service(value: unknown) {
  const v = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9]*Service$/.test(v)) {
    throw new Error("service must be a LINE Yahoo Ads service name, e.g. CampaignService");
  }
  return v;
}

function method(value: unknown, allowed: string[]) {
  const v = String(value ?? "").trim();
  if (!allowed.includes(v)) throw new Error(`method must be one of: ${allowed.join(", ")}`);
  return v;
}

function yahooAdsHeaders(token: string, args: YahooAdsArgs, includeBaseAccount = true) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const baseAccountId = String(args.base_account_id ?? args.baseAccountId ?? "").replace(/-/g, "").trim();
  if (includeBaseAccount && baseAccountId) headers["x-z-base-account-id"] = baseAccountId;
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

async function fetchYahooAds(productKey: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YAHOO_ADS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[yahoo_ads] request", { product: productKey, path, apiVersion: YAHOO_ADS_API_VERSION, ...logContext });
    const response = await fetch(`${PRODUCT_BASE_URLS[productKey]}/${YAHOO_ADS_API_VERSION}${path}`, { ...init, signal: controller.signal });
    console.log("[yahoo_ads] response", {
      product: productKey,
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[yahoo_ads] failed", {
      product: productKey,
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${YAHOO_ADS_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`LINE Yahoo Ads request timed out after ${YAHOO_ADS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function postService(token: string, args: YahooAdsArgs, productKey: string, serviceName: string, methodName: string, body: unknown, includeBaseAccount = true) {
  const r = await fetchYahooAds(productKey, `/${serviceName}/${methodName}`, {
    method: "POST",
    headers: yahooAdsHeaders(token, args, includeBaseAccount),
    body: JSON.stringify(body ?? {}),
  }, { tool: "yahoo_ads", service: serviceName, method: methodName });
  const j: any = await readJsonResponse(r);
  if (!r.ok) {
    throw new Error(`LINE Yahoo Ads ${serviceName}/${methodName} failed: ${r.status} ${JSON.stringify(j).slice(0, 1500)}`);
  }
  return j;
}

export async function callYahooAdsTool(tool: string, args: YahooAdsArgs, token: string) {
  if (tool === "yahoo_ads/list_base_accounts") {
    const productKey = product(args.product);
    const result = await postService(token, args, productKey, "BaseAccountService", "get", args.selector ?? {}, false);
    return {
      structuredContent: {
        api_version: YAHOO_ADS_API_VERSION,
        product: productKey,
        results: result.rval?.values ?? result.values ?? result.results ?? result,
      },
    };
  }

  if (tool === "yahoo_ads/get") {
    const productKey = product(args.product);
    const serviceName = service(args.service);
    const methodName = method(args.method ?? "get", ["get"]);
    const result = await postService(token, args, productKey, serviceName, methodName, args.selector ?? args.body ?? {});
    return {
      structuredContent: {
        api_version: YAHOO_ADS_API_VERSION,
        product: productKey,
        service: serviceName,
        method: methodName,
        result,
      },
    };
  }

  if (tool === "yahoo_ads/mutate") {
    const productKey = product(args.product);
    const serviceName = service(args.service);
    const methodName = method(args.method, ["add", "set", "remove", "upload"]);
    const body = args.operation ?? args.body;
    if (!body || typeof body !== "object") {
      throw new Error("operation/body is required for yahoo_ads/mutate");
    }
    const result = await postService(token, args, productKey, serviceName, methodName, body);
    return {
      structuredContent: {
        api_version: YAHOO_ADS_API_VERSION,
        product: productKey,
        service: serviceName,
        method: methodName,
        result,
      },
    };
  }

  throw new Error(`Unknown LINE Yahoo Ads tool: ${tool}`);
}
