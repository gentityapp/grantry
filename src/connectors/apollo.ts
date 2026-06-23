// Apollo.io connector — REST API authenticated with an API key.
// Talks to https://api.apollo.io/api/v1. Apollo expects the key in the
// `X-Api-Key` header. Errors come back with HTTP status codes plus a JSON
// body, so success is keyed off r.ok.
const APOLLO_API = "https://api.apollo.io/api/v1";
const APOLLO_TIMEOUT_MS = 15_000;

type ApolloArgs = Record<string, unknown>;

function headers(apiKey: string, json = false) {
  return {
    "X-Api-Key": apiKey,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
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

function requireId(args: ApolloArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

/** Build a request body from a raw `data` object, falling back to picked args. */
function bodyFrom(args: ApolloArgs, pick: string[]): Record<string, unknown> {
  if (args.data && typeof args.data === "object") return { ...(args.data as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  for (const key of pick) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

async function fetchApollo(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APOLLO_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[apollo] request", { path, ...logContext });
    const response = await fetch(`${APOLLO_API}${path}`, { ...init, signal: controller.signal });
    console.log("[apollo] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[apollo] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${APOLLO_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Apollo request timed out after ${APOLLO_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  apiKey: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const init: RequestInit = { method, headers: headers(apiKey, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchApollo(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Apollo ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

/** Build a `?a=b` query string from defined entries. */
function query(params: Record<string, unknown>) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) if (String(item) !== "") usp.append(k, String(item));
    } else if (v !== undefined && v !== null && String(v) !== "") {
      usp.set(k, String(v));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export async function callApolloTool(tool: string, args: ApolloArgs, apiKey: string) {
  // Validate the API key / check account health.
  if (tool === "apollo/health") {
    return { structuredContent: await request(apiKey, "GET", "/auth/health", undefined, tool) };
  }

  // People search (prospecting). Accepts a raw `data` body or convenience params.
  // Apollo's public, API-key-accessible search lives at /mixed_people/api_search;
  // /mixed_people/search is UI-internal and returns API_INACCESSIBLE for API keys.
  if (tool === "apollo/search_people") {
    const body = bodyFrom(args, [
      "q_keywords",
      "person_titles",
      "person_seniorities",
      "person_locations",
      "organization_locations",
      "organization_domains",
      "organization_num_employees_ranges",
      "contact_email_status",
      "page",
      "per_page",
    ]);
    return { structuredContent: await request(apiKey, "POST", "/mixed_people/api_search", body, tool) };
  }

  // Person enrichment (match a single person by email/name/domain/linkedin_url).
  if (tool === "apollo/enrich_person") {
    const body = bodyFrom(args, [
      "first_name",
      "last_name",
      "name",
      "email",
      "organization_name",
      "domain",
      "linkedin_url",
      "reveal_personal_emails",
      "reveal_phone_number",
    ]);
    return { structuredContent: await request(apiKey, "POST", "/people/match", body, tool) };
  }

  // Organization / account search.
  // Same UI-vs-API split as people search: /mixed_companies/api_search is the
  // API-key-accessible endpoint; /mixed_companies/search is UI-internal.
  if (tool === "apollo/search_organizations") {
    const body = bodyFrom(args, [
      "q_organization_name",
      "organization_locations",
      "organization_num_employees_ranges",
      "organization_industry_tag_ids",
      "q_organization_keyword_tags",
      "page",
      "per_page",
    ]);
    return { structuredContent: await request(apiKey, "POST", "/mixed_companies/api_search", body, tool) };
  }

  // Organization enrichment by domain.
  if (tool === "apollo/enrich_organization") {
    const domain = requireId(args, "domain");
    return { structuredContent: await request(apiKey, "GET", `/organizations/enrich${query({ domain })}`, undefined, tool, { domain }) };
  }

  // Search contacts already in the Apollo account.
  if (tool === "apollo/search_contacts") {
    const body = bodyFrom(args, ["q_keywords", "contact_stage_id", "sort_by_field", "sort_ascending", "page", "per_page"]);
    return { structuredContent: await request(apiKey, "POST", "/contacts/search", body, tool) };
  }

  // Create a contact in the Apollo account.
  if (tool === "apollo/create_contact") {
    const body = bodyFrom(args, [
      "first_name",
      "last_name",
      "email",
      "title",
      "organization_name",
      "website_url",
      "label_names",
      "present_raw_address",
      "direct_phone",
      "mobile_phone",
    ]);
    if (!Object.keys(body).length) throw new Error("create_contact requires contact fields (e.g. email or first_name/last_name) or a data object");
    return { structuredContent: await request(apiKey, "POST", "/contacts", body, tool) };
  }

  // Update an existing contact.
  if (tool === "apollo/update_contact") {
    const contactId = requireId(args, "contact_id", ["contactId", "id"]);
    const body = bodyFrom(args, [
      "first_name",
      "last_name",
      "email",
      "title",
      "organization_name",
      "website_url",
      "label_names",
      "present_raw_address",
      "direct_phone",
      "mobile_phone",
    ]);
    return { structuredContent: await request(apiKey, "PUT", `/contacts/${encodeURIComponent(contactId)}`, body, tool, { contactId }) };
  }

  // Search email sequences (campaigns).
  if (tool === "apollo/search_sequences") {
    const body = bodyFrom(args, ["q_name", "page", "per_page"]);
    return { structuredContent: await request(apiKey, "POST", "/emailer_campaigns/search", body, tool) };
  }

  // Add contacts to an email sequence.
  if (tool === "apollo/add_contacts_to_sequence") {
    const sequenceId = requireId(args, "sequence_id", ["sequenceId", "emailer_campaign_id", "campaign_id"]);
    const body = bodyFrom(args, ["contact_ids", "emailer_campaign_id", "send_email_from_email_account_id", "sequence_active_in_other_campaigns"]);
    if (!body.contact_ids && Array.isArray(args.contact_ids)) body.contact_ids = args.contact_ids;
    if (!body.contact_ids) throw new Error("contact_ids (array) is required");
    return {
      structuredContent: await request(
        apiKey,
        "POST",
        `/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids`,
        body,
        tool,
        { sequenceId },
      ),
    };
  }

  throw new Error(`Unknown Apollo tool: ${tool}`);
}
