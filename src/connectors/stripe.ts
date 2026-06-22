// Stripe connector - Bearer secret key authentication.
// Writes use application/x-www-form-urlencoded with bracket notation for nested objects.
const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_TIMEOUT_MS = 12_000;

type StripeArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(secretKey: string, form = false) {
  return {
    Authorization: `Bearer ${secretKey}`,
    Accept: "application/json",
    "Stripe-Version": "2024-06-20",
    ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
  };
}

async function fetchStripe(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[stripe] request", { path, ...logContext });
    const response = await fetch(`${STRIPE_API}${path}`, { ...init, signal: controller.signal });
    console.log("[stripe] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[stripe] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${STRIPE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Stripe request timed out after ${STRIPE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: StripeArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: StripeArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Flatten a nested object into Stripe bracket notation for form encoding.
 * e.g. { metadata: { key: "v" } } → "metadata[key]=v"
 * Top-level primitives are encoded directly.
 */
export function flattenForm(obj: Record<string, unknown>, prefix = ""): URLSearchParams {
  const params = new URLSearchParams();
  function flatten(current: unknown, path: string) {
    if (current === undefined || current === null || current === "") return;
    if (typeof current === "object" && !Array.isArray(current)) {
      for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
        flatten(v, path ? `${path}[${k}]` : k);
      }
    } else if (Array.isArray(current)) {
      current.forEach((item, i) => flatten(item, `${path}[${i}]`));
    } else {
      params.set(path, String(current));
    }
  }
  flatten(obj, prefix);
  return params;
}

async function requestGet(secretKey: string, path: string, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method: "GET", headers: headers(secretKey) };
  const r = await fetchStripe(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Stripe ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

async function requestForm(secretKey: string, method: string, path: string, body: Record<string, unknown>, tool: string, logContext: Record<string, unknown> = {}) {
  const params = flattenForm(body);
  const init: RequestInit = {
    method,
    headers: headers(secretKey, true),
    body: params.toString(),
  };
  const r = await fetchStripe(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Stripe ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callStripeTool(tool: string, args: StripeArgs, credential: string) {
  if (tool === "stripe/list_customers") {
    const qs = queryString(args, ["limit", "email", "starting_after"]);
    return { structuredContent: await requestGet(credential, `/customers${qs}`, tool) };
  }

  if (tool === "stripe/get_customer") {
    const customerId = idArg(args, "customer_id");
    return { structuredContent: await requestGet(credential, `/customers/${encodeURIComponent(customerId)}`, tool, { customerId }) };
  }

  if (tool === "stripe/create_customer") {
    const body: Record<string, unknown> = {};
    // Accept raw params passthrough
    if (args.params && typeof args.params === "object" && !Array.isArray(args.params)) {
      Object.assign(body, args.params);
    }
    for (const key of ["email", "name", "description", "phone", "metadata"]) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== "") body[key] = value;
    }
    return { structuredContent: await requestForm(credential, "POST", "/customers", body, tool) };
  }

  if (tool === "stripe/list_charges") {
    const qs = queryString(args, ["limit", "customer", "starting_after"]);
    return { structuredContent: await requestGet(credential, `/charges${qs}`, tool) };
  }

  if (tool === "stripe/list_payment_intents") {
    const qs = queryString(args, ["limit", "customer"]);
    return { structuredContent: await requestGet(credential, `/payment_intents${qs}`, tool) };
  }

  if (tool === "stripe/create_payment_intent") {
    const amount = args.amount;
    const currency = args.currency;
    if (amount === undefined || amount === null || amount === "") throw new Error("amount is required");
    if (!currency) throw new Error("currency is required");
    const body: Record<string, unknown> = { amount, currency };
    for (const key of ["customer", "description", "metadata"]) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== "") body[key] = value;
    }
    return { structuredContent: await requestForm(credential, "POST", "/payment_intents", body, tool) };
  }

  if (tool === "stripe/list_invoices") {
    const qs = queryString(args, ["limit", "customer", "status"]);
    return { structuredContent: await requestGet(credential, `/invoices${qs}`, tool) };
  }

  throw new Error(`Unknown Stripe tool: ${tool}`);
}
