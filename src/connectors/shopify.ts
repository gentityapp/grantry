// Shopify connector — JSON credential {shop, token}.
// Auth: X-Shopify-Access-Token header.
const SHOPIFY_TIMEOUT_MS = 12_000;

type ShopifyArgs = Record<string, unknown>;

type ShopifyCredential = {
  shop: string;
  token: string;
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

function parseShopifyCredential(credential: string): ShopifyCredential & { base: string } {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Shopify credential is empty");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      'Shopify credential must be a JSON object like {"shop":"acme.myshopify.com","token":"shpat_..."}'
    );
  }
  const shop = String(parsed.shop ?? "").trim();
  const token = String(parsed.token ?? "").trim();
  if (!shop) throw new Error('Shopify credential JSON must include "shop"');
  if (!token) throw new Error('Shopify credential JSON must include "token"');
  const base = `https://${shop}/admin/api/2024-10`;
  return { shop, token, base };
}

async function fetchShopify(
  base: string,
  token: string,
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[shopify] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[shopify] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[shopify] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${SHOPIFY_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Shopify request timed out after ${SHOPIFY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: ShopifyArgs, snake: string) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const value = String(args[snake] ?? args[camel] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

function queryString(args: ShopifyArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = args[key] ?? args[camel];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(
  base: string,
  token: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {}
) {
  const hdrs: Record<string, string> = {
    "X-Shopify-Access-Token": token,
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const init: RequestInit = { method, headers: hdrs };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchShopify(base, token, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Shopify ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callShopifyTool(tool: string, args: ShopifyArgs, credential: string) {
  const { base, token } = parseShopifyCredential(credential);

  if (tool === "shopify/list_products") {
    const qs = queryString(args, ["limit", "status"]);
    return { structuredContent: await request(base, token, "GET", `/products.json${qs}`, undefined, tool) };
  }

  if (tool === "shopify/get_product") {
    const productId = idArg(args, "product_id");
    return {
      structuredContent: await request(
        base, token, "GET",
        `/products/${encodeURIComponent(productId)}.json`,
        undefined, tool, { productId }
      ),
    };
  }

  if (tool === "shopify/create_product") {
    const title = String(args.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const product: Record<string, unknown> = { title };
    const bodyHtml = String(args.body_html ?? args.bodyHtml ?? "").trim();
    if (bodyHtml) product.body_html = bodyHtml;
    const vendor = String(args.vendor ?? "").trim();
    if (vendor) product.vendor = vendor;
    const status = String(args.status ?? "").trim();
    if (status) product.status = status;
    return {
      structuredContent: await request(base, token, "POST", "/products.json", { product }, tool),
    };
  }

  if (tool === "shopify/list_orders") {
    const qs = queryString(args, ["limit", "status", "financial_status"]);
    return { structuredContent: await request(base, token, "GET", `/orders.json${qs}`, undefined, tool) };
  }

  if (tool === "shopify/get_order") {
    const orderId = idArg(args, "order_id");
    return {
      structuredContent: await request(
        base, token, "GET",
        `/orders/${encodeURIComponent(orderId)}.json`,
        undefined, tool, { orderId }
      ),
    };
  }

  if (tool === "shopify/list_customers") {
    const qs = queryString(args, ["limit"]);
    return { structuredContent: await request(base, token, "GET", `/customers.json${qs}`, undefined, tool) };
  }

  throw new Error(`Unknown Shopify tool: ${tool}`);
}
