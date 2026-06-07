// HubSpot CRM connector — OAuth access token.
const HUBSPOT_API = "https://api.hubapi.com";
const HUBSPOT_TIMEOUT_MS = 10_000;

type HubSpotArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchHubSpot(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[hubspot] request", { path, ...logContext });
    const response = await fetch(`${HUBSPOT_API}${path}`, { ...init, signal: controller.signal });
    console.log("[hubspot] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[hubspot] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${HUBSPOT_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`HubSpot request timed out after ${HUBSPOT_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function csv(value: unknown, fallback: string[]) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value ?? "").trim();
  return s ? s.split(",").map((v) => v.trim()).filter(Boolean) : fallback;
}

export async function callHubSpotTool(tool: string, args: HubSpotArgs, token: string) {
  if (tool === "hubspot/list_deals") {
    const params = new URLSearchParams();
    const limit = Number(args.limit ?? 20);
    params.set("limit", String(Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 20));
    const after = String(args.after ?? "").trim();
    if (after) params.set("after", after);
    params.set("properties", csv(args.properties, ["dealname", "amount", "dealstage", "pipeline", "closedate", "createdate"]).join(","));
    const r = await fetchHubSpot(`/crm/v3/objects/deals?${params.toString()}`, { headers: headers(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot list_deals failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: { results: j.results ?? [], paging: j.paging ?? null } };
  }

  if (tool === "hubspot/get_contact") {
    const contactId = String(args.contact_id ?? args.contactId ?? "").trim();
    if (!contactId) throw new Error("contact_id is required");
    const params = new URLSearchParams();
    params.set("properties", csv(args.properties, ["email", "firstname", "lastname", "phone", "company", "lifecyclestage", "createdate"]).join(","));
    const r = await fetchHubSpot(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?${params.toString()}`, { headers: headers(token) }, { tool, contactId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot get_contact failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: j };
  }

  if (tool === "hubspot/create_deal") {
    const properties = args.properties && typeof args.properties === "object" && !Array.isArray(args.properties) ? args.properties : null;
    if (!properties) throw new Error("properties object is required");
    const r = await fetchHubSpot("/crm/v3/objects/deals", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ properties }),
    }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot create_deal failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  throw new Error(`Unknown HubSpot tool: ${tool}`);
}
