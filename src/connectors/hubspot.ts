// HubSpot CRM connector — OAuth access token.
// redeploy-marker: activate content scope request (v2)
import { PROVIDERS } from "./registry.js";

const HUBSPOT_API = "https://api.hubapi.com";
const HUBSPOT_TIMEOUT_MS = 10_000;

// Marketing-email tools (read + write). Registered idempotently for deployments
// that may still have an older registry shape loaded.
// NOTE: read/draft need the `content` granular scope; publishing needs
// `marketing-email`. PAT connections need them on the Private App; OAuth
// connections must reconnect after these are added to the authorize request.
const HUBSPOT_MARKETING_EMAIL_TOOLS = [
  "hubspot/list_marketing_emails",
  "hubspot/get_marketing_email",
  "hubspot/get_marketing_email_statistics",
  "hubspot/update_marketing_email",
  "hubspot/publish_marketing_email",
];
const hubspotProvider = PROVIDERS.hubspot;
if (hubspotProvider) {
  for (const t of HUBSPOT_MARKETING_EMAIL_TOOLS) {
    if (!hubspotProvider.tools.includes(t)) hubspotProvider.tools.push(t);
  }
  // HubSpot optional app scopes must be sent with the `optional_scope` query
  // parameter. Keep these out of the required scope list to avoid mismatches
  // when the HubSpot app config marks them optional.
  if (!Array.isArray(hubspotProvider.oauthOptionalScopes)) {
    hubspotProvider.oauthOptionalScopes = [];
  }
  for (const s of ["content", "marketing-email"]) {
    if (!hubspotProvider.oauthOptionalScopes.includes(s)) {
      hubspotProvider.oauthOptionalScopes.push(s);
    }
  }
}

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

  // --- Marketing emails (broadcast / automated nurture sends) ---
  // GET /marketing/v3/emails — list marketing emails. Supports includeStats=true
  // to inline open/click metrics per email.
  if (tool === "hubspot/list_marketing_emails") {
    const params = new URLSearchParams();
    const limit = Number(args.limit ?? 20);
    params.set("limit", String(Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 20));
    const after = String(args.after ?? "").trim();
    if (after) params.set("after", after);
    const sort = String(args.sort ?? "").trim();
    if (sort) params.set("sort", sort);
    const type = String(args.type ?? "").trim();
    if (type) params.set("type", type);
    const createdAfter = String(args.created_after ?? args.createdAfter ?? "").trim();
    if (createdAfter) params.set("createdAfter", createdAfter);
    const createdBefore = String(args.created_before ?? args.createdBefore ?? "").trim();
    if (createdBefore) params.set("createdBefore", createdBefore);
    if (args.includeStats === true || String(args.includeStats ?? args.include_stats ?? "").trim() === "true") {
      params.set("includeStats", "true");
    }
    if (args.isPublished !== undefined && String(args.isPublished).trim() !== "") {
      params.set("isPublished", String(args.isPublished));
    }
    if (args.archived !== undefined && String(args.archived).trim() !== "") {
      params.set("archived", String(args.archived));
    }
    const r = await fetchHubSpot(`/marketing/v3/emails?${params.toString()}`, { headers: headers(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot list_marketing_emails failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: { results: j.results ?? [], paging: j.paging ?? null, total: j.total ?? null } };
  }

  // GET /marketing/v3/emails/{emailId}
  if (tool === "hubspot/get_marketing_email") {
    const emailId = String(args.email_id ?? args.emailId ?? "").trim();
    if (!emailId) throw new Error("email_id is required");
    const params = new URLSearchParams();
    if (args.includeStats === true || String(args.includeStats ?? args.include_stats ?? "").trim() === "true") {
      params.set("includeStats", "true");
    }
    const qs = params.toString();
    const r = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}${qs ? `?${qs}` : ""}`, { headers: headers(token) }, { tool, emailId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot get_marketing_email failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: j };
  }

  // GET /marketing/v3/emails/statistics/list — aggregated stats over a window.
  if (tool === "hubspot/get_marketing_email_statistics") {
    const startTimestamp = String(args.start_timestamp ?? args.startTimestamp ?? "").trim();
    const endTimestamp = String(args.end_timestamp ?? args.endTimestamp ?? "").trim();
    if (!startTimestamp) throw new Error("start_timestamp is required (ISO 8601)");
    if (!endTimestamp) throw new Error("end_timestamp is required (ISO 8601)");
    const params = new URLSearchParams();
    params.set("startTimestamp", startTimestamp);
    params.set("endTimestamp", endTimestamp);
    for (const id of csv(args.email_ids ?? args.emailIds, [])) params.append("emailIds", id);
    const property = String(args.property ?? "").trim();
    if (property) params.set("property", property);
    const r = await fetchHubSpot(`/marketing/v3/emails/statistics/list?${params.toString()}`, { headers: headers(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot get_marketing_email_statistics failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: j };
  }

  // PATCH /marketing/v3/emails/{emailId} — update subject/name/content.
  // Published emails cannot be PATCHed directly: fall back to PATCH {id}/draft
  // then POST {id}/publish (unless publish=false). Requires content(+marketing-email to publish).
  if (tool === "hubspot/update_marketing_email") {
    const emailId = String(args.email_id ?? args.emailId ?? "").trim();
    if (!emailId) throw new Error("email_id is required");
    const body: Record<string, unknown> = {};
    if (args.updates && typeof args.updates === "object" && !Array.isArray(args.updates)) {
      Object.assign(body, args.updates as Record<string, unknown>);
    }
    if (args.subject !== undefined) body.subject = String(args.subject);
    if (args.name !== undefined) body.name = String(args.name);
    if (args.content && typeof args.content === "object" && !Array.isArray(args.content)) {
      body.content = args.content;
    }
    if (Object.keys(body).length === 0) {
      throw new Error("nothing to update: provide `updates` (object) and/or subject/name/content");
    }
    const r = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(body),
    }, { tool, emailId });
    const j: any = await readJsonResponse(r);
    if (r.ok) return { structuredContent: j };
    const msg = JSON.stringify(j);
    const isPublished = r.status === 400 && /published email/i.test(msg);
    if (!isPublished) throw new Error(`HubSpot update_marketing_email failed: ${r.status} ${msg.slice(0, 1500)}`);
    // Published: update the draft, then publish (unless publish=false).
    const dr = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}/draft`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(body),
    }, { tool, emailId, step: "draft" });
    const dj: any = await readJsonResponse(dr);
    if (!dr.ok) throw new Error(`HubSpot update_marketing_email(draft) failed: ${dr.status} ${JSON.stringify(dj).slice(0, 1500)}`);
    if (args.publish === false || String(args.publish) === "false") {
      return { structuredContent: { draftUpdated: true, published: false, draft: dj } };
    }
    const pr = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}/publish`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({}),
    }, { tool, emailId, step: "publish" });
    const pj: any = await readJsonResponse(pr);
    if (!pr.ok) throw new Error(`HubSpot update_marketing_email(publish) failed: ${pr.status} ${JSON.stringify(pj).slice(0, 1500)}`);
    return { structuredContent: { draftUpdated: true, published: true, result: pj } };
  }

  // POST /marketing/v3/emails/{emailId}/publish — publish the email.
  if (tool === "hubspot/publish_marketing_email") {
    const emailId = String(args.email_id ?? args.emailId ?? "").trim();
    if (!emailId) throw new Error("email_id is required");
    const r = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}/publish`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({}),
    }, { tool, emailId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot publish_marketing_email failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: j };
  }

  throw new Error(`Unknown HubSpot tool: ${tool}`);
}
