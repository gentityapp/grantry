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
// Automation / Workflows (v4 flows) — read tools for the workflow-optimization
// engine. Require the `automation` scope (added to optional scopes below).
const HUBSPOT_AUTOMATION_TOOLS = [
  "hubspot/list_flows",
  "hubspot/get_flow",
  "hubspot/update_flow",
];
const hubspotProvider = PROVIDERS.hubspot;
if (hubspotProvider) {
  for (const t of [...HUBSPOT_MARKETING_EMAIL_TOOLS, ...HUBSPOT_AUTOMATION_TOOLS]) {
    if (!hubspotProvider.tools.includes(t)) hubspotProvider.tools.push(t);
  }
  if (!Array.isArray(hubspotProvider.oauthOptionalScopes)) {
    hubspotProvider.oauthOptionalScopes = [];
  }
  for (const s of ["content", "marketing-email", "automation"]) {
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

  // PATCH /marketing/v3/emails/{emailId} — update subject/name/content/preview_text,
  // with optional replace_in_content (find/replace across the content object).
  // Published emails go via {id}/draft then {id}/publish. publish 403 (account
  // lacking marketing-email) is non-fatal: draft is saved, publish via UI.
  if (tool === "hubspot/update_marketing_email") {
    const emailId = String(args.email_id ?? args.emailId ?? "").trim();
    if (!emailId) throw new Error("email_id is required");
    const previewText = args.preview_text ?? args.previewText;
    const rawReplace: any = args.replace_in_content ?? args.replaceInContent;
    const replaceList: Array<{ from: string; to: string }> = Array.isArray(rawReplace)
      ? rawReplace.map((x: any) => ({ from: String(x?.from ?? ""), to: String(x?.to ?? "") }))
      : (rawReplace && typeof rawReplace === "object"
        ? [{ from: String(rawReplace.from ?? ""), to: String(rawReplace.to ?? "") }]
        : []);
    const needsContentOps = previewText !== undefined || replaceList.some((x) => x.from);

    const body: Record<string, unknown> = {};
    if (args.updates && typeof args.updates === "object" && !Array.isArray(args.updates)) {
      Object.assign(body, args.updates as Record<string, unknown>);
    }
    if (args.subject !== undefined) body.subject = String(args.subject);
    if (args.name !== undefined) body.name = String(args.name);
    if (args.content && typeof args.content === "object" && !Array.isArray(args.content)) {
      body.content = args.content;
    }

    if (needsContentOps) {
      let content: any = body.content;
      if (!content) {
        const gr = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}`, { headers: headers(token) }, { tool, emailId, step: "get" });
        const gj: any = await readJsonResponse(gr);
        if (!gr.ok) throw new Error(`HubSpot update_marketing_email(get) failed: ${gr.status} ${JSON.stringify(gj).slice(0, 1200)}`);
        content = gj.content ?? {};
      }
      if (replaceList.some((x) => x.from)) {
        let s = JSON.stringify(content);
        for (const rep of replaceList) {
          if (rep.from) s = s.split(rep.from).join(rep.to);
        }
        content = JSON.parse(s);
      }
      if (previewText !== undefined) {
        content.widgets = content.widgets || {};
        const pt: any = content.widgets.preview_text || { id: "preview_text", name: "preview_text", type: "text", order: 0 };
        pt.body = pt.body || {};
        pt.body.value = String(previewText);
        content.widgets.preview_text = pt;
      }
      body.content = content;
    }

    if (Object.keys(body).length === 0) {
      throw new Error("nothing to update: provide subject/name/content/updates/preview_text/replace_in_content");
    }

    const finishPublish = async () => {
      if (args.publish === false || String(args.publish) === "false") {
        return { structuredContent: { draftUpdated: true, published: false } };
      }
      const pr = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}/publish`, {
        method: "POST", headers: headers(token), body: JSON.stringify({}),
      }, { tool, emailId, step: "publish" });
      const pj: any = await readJsonResponse(pr);
      if (pr.ok) return { structuredContent: { draftUpdated: true, published: true, result: pj } };
      if (pr.status === 403 && /MISSING_SCOPES|marketing-email/i.test(JSON.stringify(pj))) {
        return { structuredContent: { draftUpdated: true, published: false, needsUiPublish: true, reason: "publish requires marketing-email entitlement; draft saved, publish via HubSpot UI" } };
      }
      throw new Error(`HubSpot update_marketing_email(publish) failed: ${pr.status} ${JSON.stringify(pj).slice(0, 1500)}`);
    };

    const r = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}`, {
      method: "PATCH", headers: headers(token), body: JSON.stringify(body),
    }, { tool, emailId });
    const j: any = await readJsonResponse(r);
    if (r.ok) return { structuredContent: j };
    const msg = JSON.stringify(j);
    if (!(r.status === 400 && /published email/i.test(msg))) {
      throw new Error(`HubSpot update_marketing_email failed: ${r.status} ${msg.slice(0, 1500)}`);
    }
    const dr = await fetchHubSpot(`/marketing/v3/emails/${encodeURIComponent(emailId)}/draft`, {
      method: "PATCH", headers: headers(token), body: JSON.stringify(body),
    }, { tool, emailId, step: "draft" });
    const dj: any = await readJsonResponse(dr);
    if (!dr.ok) throw new Error(`HubSpot update_marketing_email(draft) failed: ${dr.status} ${JSON.stringify(dj).slice(0, 1500)}`);
    return await finishPublish();
  }

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

  // --- Automation / Workflows (v4 flows) — read, for structure analysis ---
  // GET /automation/v4/flows — list flows (workflows). Requires `automation` scope.
  if (tool === "hubspot/list_flows") {
    const params = new URLSearchParams();
    const limit = Number(args.limit ?? 100);
    params.set("limit", String(Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 500) : 100));
    const after = String(args.after ?? "").trim();
    if (after) params.set("after", after);
    const r = await fetchHubSpot(`/automation/v4/flows?${params.toString()}`, { headers: headers(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot list_flows failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: { results: j.results ?? [], paging: j.paging ?? null, total: j.total ?? null } };
  }

  // GET /automation/v4/flows/{flowId} — full flow definition (enrollment criteria,
  // actions, branches). Used to diagnose structural issues (e.g. steps not sending).
  if (tool === "hubspot/get_flow") {
    const flowId = String(args.flow_id ?? args.flowId ?? "").trim();
    if (!flowId) throw new Error("flow_id is required");
    const r = await fetchHubSpot(`/automation/v4/flows/${encodeURIComponent(flowId)}`, { headers: headers(token) }, { tool, flowId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot get_flow failed: ${r.status} ${JSON.stringify(j).slice(0, 1500)}`);
    return { structuredContent: j };
  }

  // PUT /automation/v4/flows/{flowId} — update a flow (structure/enrollment).
  // HIGH-RISK write on LIVE automation. Requires confirm:true. Read-modify-write:
  // pass full `flow` (object, replaces), or `updates` (shallow-merged onto the
  // current flow), or `set_enabled` (convenience on/off toggle).
  if (tool === "hubspot/update_flow") {
    const flowId = String(args.flow_id ?? args.flowId ?? "").trim();
    if (!flowId) throw new Error("flow_id is required");
    if (args.confirm !== true && String(args.confirm) !== "true") {
      throw new Error("confirm:true is required to update a HubSpot flow (live automation)");
    }
    let flow: any = (args.flow && typeof args.flow === "object" && !Array.isArray(args.flow)) ? args.flow : null;
    const updates = (args.updates && typeof args.updates === "object" && !Array.isArray(args.updates)) ? (args.updates as Record<string, unknown>) : null;
    const hasEnabledToggle = args.set_enabled !== undefined;
    if (!flow && (updates || hasEnabledToggle)) {
      const gr = await fetchHubSpot(`/automation/v4/flows/${encodeURIComponent(flowId)}`, { headers: headers(token) }, { tool, flowId, step: "get" });
      const gj: any = await readJsonResponse(gr);
      if (!gr.ok) throw new Error(`HubSpot update_flow(get) failed: ${gr.status} ${JSON.stringify(gj).slice(0, 1200)}`);
      flow = gj;
      if (updates) Object.assign(flow, updates);
      if (hasEnabledToggle) flow.isEnabled = (args.set_enabled === true || String(args.set_enabled) === "true");
    }
    if (!flow) throw new Error("provide `flow` (full object) or `updates`/`set_enabled` to modify");
    const r = await fetchHubSpot(`/automation/v4/flows/${encodeURIComponent(flowId)}`, {
      method: "PUT", headers: headers(token), body: JSON.stringify(flow),
    }, { tool, flowId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`HubSpot update_flow failed: ${r.status} ${JSON.stringify(j).slice(0, 1500)}`);
    return { structuredContent: j };
  }

  throw new Error(`Unknown HubSpot tool: ${tool}`);
}
