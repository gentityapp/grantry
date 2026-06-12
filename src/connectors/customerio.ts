// Customer.io connector - Bearer App API key authentication.
// Credential is EITHER a plain API key string OR JSON {"token":"...","region":"us"|"eu"}.
// Region defaults to "us". EU base: https://api-eu.customer.io, US base: https://api.customer.io
const CUSTOMERIO_TIMEOUT_MS = 12_000;

type CustomerioArgs = Record<string, unknown>;

type CustomerioCredential = {
  token: string;
  region: "us" | "eu";
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

export function parseCustomerioCredential(credential: string): CustomerioCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Customer.io token is empty");
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const token = String(parsed.token ?? parsed.api_key ?? parsed.apiKey ?? "").trim();
    if (!token) throw new Error("Customer.io credential JSON must include token");
    const region = String(parsed.region ?? "us").trim().toLowerCase();
    if (region !== "us" && region !== "eu") {
      throw new Error("Customer.io region must be 'us' or 'eu'");
    }
    return { token, region: region as "us" | "eu" };
  }
  return { token: trimmed, region: "us" };
}

function baseUrl(region: "us" | "eu") {
  return region === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchCustomerio(base: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOMERIO_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[customerio] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[customerio] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[customerio] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CUSTOMERIO_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Customer.io request timed out after ${CUSTOMERIO_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: CustomerioArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function request(cred: CustomerioCredential, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const base = baseUrl(cred.region);
  const init: RequestInit = { method, headers: headers(cred.token) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchCustomerio(base, path, init, { tool, region: cred.region, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Customer.io ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callCustomerioTool(tool: string, args: CustomerioArgs, credential: string) {
  const cred = parseCustomerioCredential(credential);

  if (tool === "customerio/send_transactional") {
    let body: Record<string, unknown>;
    // Accept raw data passthrough
    if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) {
      body = args.data as Record<string, unknown>;
    } else {
      const to = String(args.to ?? "").trim();
      if (!to) throw new Error("to is required");
      body = { to };
      const transactionalMessageId = args.transactional_message_id ?? args.transactionalMessageId;
      if (transactionalMessageId !== undefined && transactionalMessageId !== null && transactionalMessageId !== "") {
        body.transactional_message_id = transactionalMessageId;
      }
      if (args.identifiers !== undefined) body.identifiers = args.identifiers;
      if (args.message_data !== undefined) body.message_data = args.message_data;
      if (args.messageData !== undefined) body.message_data = args.messageData;
    }
    return { structuredContent: await request(cred, "POST", "/v1/send/email", body, tool) };
  }

  if (tool === "customerio/list_campaigns") {
    return { structuredContent: await request(cred, "GET", "/v1/campaigns", undefined, tool) };
  }

  if (tool === "customerio/get_campaign") {
    const campaignId = idArg(args, "campaign_id");
    return { structuredContent: await request(cred, "GET", `/v1/campaigns/${encodeURIComponent(campaignId)}`, undefined, tool, { campaignId }) };
  }

  if (tool === "customerio/get_campaign_metrics") {
    const campaignId = idArg(args, "campaign_id");
    return { structuredContent: await request(cred, "GET", `/v1/campaigns/${encodeURIComponent(campaignId)}/metrics`, undefined, tool, { campaignId }) };
  }

  if (tool === "customerio/get_customer") {
    const customerId = idArg(args, "customer_id");
    return { structuredContent: await request(cred, "GET", `/v1/customers/${encodeURIComponent(customerId)}/attributes`, undefined, tool, { customerId }) };
  }

  if (tool === "customerio/list_newsletters") {
    return { structuredContent: await request(cred, "GET", "/v1/newsletters", undefined, tool) };
  }

  throw new Error(`Unknown Customer.io tool: ${tool}`);
}
