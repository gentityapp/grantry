// Google Admin connector - OAuth access token via Authorization: Bearer.
// Targets the Admin SDK Directory API v1 (users, groups, members, org units).
// The connecting Google account must be a Workspace administrator.
const GADMIN_API = "https://admin.googleapis.com/admin/directory/v1";
const GADMIN_TIMEOUT_MS = 12_000;

type GAdminArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(accessToken: string, json = false) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchGAdmin(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GADMIN_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_admin] request", { path, ...logContext });
    const response = await fetch(`${GADMIN_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_admin] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_admin] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${GADMIN_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Google Admin request timed out after ${GADMIN_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GAdminArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function optArg(args: GAdminArgs, snake: string, aliases: string[] = []): string | undefined {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  return undefined;
}

function queryString(args: GAdminArgs, keys: string[], defaults: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(defaults)) params.set(k, v);
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function jsonBody(args: GAdminArgs, requiredKeys: string[], optionalKeys: string[] = []) {
  const body: Record<string, unknown> = {};
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") {
      if (requiredKeys.includes(key)) throw new Error(`${key} is required`);
      continue;
    }
    body[key] = value;
  }
  return body;
}

// Org unit paths carry slashes (e.g. "Sales/Engineering"). The API expects the
// path appended raw after orgunits/, with no leading slash and slashes intact —
// so encode each segment but keep the separators.
function encodeOrgUnitPath(path: string): string {
  return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

async function request(accessToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchGAdmin(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Admin ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callGoogleAdminTool(tool: string, args: GAdminArgs, accessToken: string) {
  // ---------- Users ----------
  if (tool === "google_admin/list_users") {
    // customer defaults to my_customer unless an explicit domain is given.
    const hasDomain = !!optArg(args, "domain");
    const defaults: Record<string, string> = hasDomain ? {} : { customer: optArg(args, "customer") ?? "my_customer" };
    const qs = queryString(args, ["customer", "domain", "query", "max_results", "maxResults", "order_by", "orderBy", "page_token", "pageToken", "show_deleted", "showDeleted", "view_type", "viewType", "projection", "sort_order", "sortOrder"], defaults);
    return { structuredContent: await request(accessToken, "GET", `/users${qs}`, undefined, tool) };
  }

  if (tool === "google_admin/get_user") {
    const userKey = idArg(args, "user_key", ["userKey", "user_id", "email"]);
    const qs = queryString(args, ["projection", "view_type", "viewType"]);
    return { structuredContent: await request(accessToken, "GET", `/users/${encodeURIComponent(userKey)}${qs}`, undefined, tool, { userKey }) };
  }

  if (tool === "google_admin/create_user") {
    const body = jsonBody(args, ["primaryEmail", "name", "password"], ["suspended", "orgUnitPath", "changePasswordAtNextLogin", "emails", "phones", "recoveryEmail", "recoveryPhone", "externalIds", "organizations"]);
    return { structuredContent: await request(accessToken, "POST", "/users", body, tool) };
  }

  if (tool === "google_admin/update_user") {
    const userKey = idArg(args, "user_key", ["userKey", "user_id", "email"]);
    const body = jsonBody(args, [], ["primaryEmail", "name", "password", "suspended", "orgUnitPath", "changePasswordAtNextLogin", "emails", "phones", "recoveryEmail", "recoveryPhone", "externalIds", "organizations", "archived"]);
    return { structuredContent: await request(accessToken, "PUT", `/users/${encodeURIComponent(userKey)}`, body, tool, { userKey }) };
  }

  if (tool === "google_admin/delete_user") {
    const userKey = idArg(args, "user_key", ["userKey", "user_id", "email"]);
    await request(accessToken, "DELETE", `/users/${encodeURIComponent(userKey)}`, undefined, tool, { userKey });
    return { structuredContent: { deleted: true, user_key: userKey } };
  }

  // ---------- Groups ----------
  if (tool === "google_admin/list_groups") {
    // Filter by customer (default my_customer), domain, or userKey (member's groups).
    const hasDomain = !!optArg(args, "domain");
    const hasUserKey = !!optArg(args, "user_key", ["userKey"]);
    const defaults: Record<string, string> = hasDomain || hasUserKey ? {} : { customer: optArg(args, "customer") ?? "my_customer" };
    const qs = queryString(args, ["customer", "domain", "user_key", "userKey", "query", "max_results", "maxResults", "page_token", "pageToken", "order_by", "orderBy", "sort_order", "sortOrder"], defaults);
    return { structuredContent: await request(accessToken, "GET", `/groups${qs}`, undefined, tool) };
  }

  if (tool === "google_admin/get_group") {
    const groupKey = idArg(args, "group_key", ["groupKey", "group_id", "email"]);
    return { structuredContent: await request(accessToken, "GET", `/groups/${encodeURIComponent(groupKey)}`, undefined, tool, { groupKey }) };
  }

  if (tool === "google_admin/create_group") {
    const body = jsonBody(args, ["email"], ["name", "description"]);
    return { structuredContent: await request(accessToken, "POST", "/groups", body, tool) };
  }

  if (tool === "google_admin/update_group") {
    const groupKey = idArg(args, "group_key", ["groupKey", "group_id", "email"]);
    const body = jsonBody(args, [], ["email", "name", "description"]);
    return { structuredContent: await request(accessToken, "PUT", `/groups/${encodeURIComponent(groupKey)}`, body, tool, { groupKey }) };
  }

  if (tool === "google_admin/delete_group") {
    const groupKey = idArg(args, "group_key", ["groupKey", "group_id", "email"]);
    await request(accessToken, "DELETE", `/groups/${encodeURIComponent(groupKey)}`, undefined, tool, { groupKey });
    return { structuredContent: { deleted: true, group_key: groupKey } };
  }

  // ---------- Members ----------
  if (tool === "google_admin/list_members") {
    const groupKey = idArg(args, "group_key", ["groupKey", "group_id", "email"]);
    const qs = queryString(args, ["roles", "max_results", "maxResults", "page_token", "pageToken", "include_derived_membership", "includeDerivedMembership"]);
    return { structuredContent: await request(accessToken, "GET", `/groups/${encodeURIComponent(groupKey)}/members${qs}`, undefined, tool, { groupKey }) };
  }

  if (tool === "google_admin/add_member") {
    const groupKey = idArg(args, "group_key", ["groupKey", "group_id"]);
    const body = jsonBody(args, ["email"], ["role", "type", "delivery_settings", "deliverySettings"]);
    return { structuredContent: await request(accessToken, "POST", `/groups/${encodeURIComponent(groupKey)}/members`, body, tool, { groupKey }) };
  }

  if (tool === "google_admin/update_member") {
    const groupKey = idArg(args, "group_key", ["groupKey", "group_id"]);
    const memberKey = idArg(args, "member_key", ["memberKey", "member_id", "email"]);
    const body = jsonBody(args, [], ["role", "type", "delivery_settings", "deliverySettings"]);
    return { structuredContent: await request(accessToken, "PUT", `/groups/${encodeURIComponent(groupKey)}/members/${encodeURIComponent(memberKey)}`, body, tool, { groupKey, memberKey }) };
  }

  if (tool === "google_admin/remove_member") {
    const groupKey = idArg(args, "group_key", ["groupKey", "group_id"]);
    const memberKey = idArg(args, "member_key", ["memberKey", "member_id", "email"]);
    await request(accessToken, "DELETE", `/groups/${encodeURIComponent(groupKey)}/members/${encodeURIComponent(memberKey)}`, undefined, tool, { groupKey, memberKey });
    return { structuredContent: { removed: true, group_key: groupKey, member_key: memberKey } };
  }

  // ---------- Org units ----------
  // All org-unit calls live under /customer/{customerId}/orgunits.
  if (tool === "google_admin/list_org_units") {
    const customer = optArg(args, "customer") ?? "my_customer";
    const qs = queryString(args, ["org_unit_path", "orgUnitPath", "type"]);
    return { structuredContent: await request(accessToken, "GET", `/customer/${encodeURIComponent(customer)}/orgunits${qs}`, undefined, tool, { customer }) };
  }

  if (tool === "google_admin/get_org_unit") {
    const customer = optArg(args, "customer") ?? "my_customer";
    const orgUnitPath = idArg(args, "org_unit_path", ["orgUnitPath"]);
    return { structuredContent: await request(accessToken, "GET", `/customer/${encodeURIComponent(customer)}/orgunits/${encodeOrgUnitPath(orgUnitPath)}`, undefined, tool, { customer, orgUnitPath }) };
  }

  if (tool === "google_admin/create_org_unit") {
    const customer = optArg(args, "customer") ?? "my_customer";
    const body = jsonBody(args, ["name", "parentOrgUnitPath"], ["description", "blockInheritance"]);
    return { structuredContent: await request(accessToken, "POST", `/customer/${encodeURIComponent(customer)}/orgunits`, body, tool, { customer }) };
  }

  if (tool === "google_admin/update_org_unit") {
    const customer = optArg(args, "customer") ?? "my_customer";
    const orgUnitPath = idArg(args, "org_unit_path", ["orgUnitPath"]);
    const body = jsonBody(args, [], ["name", "description", "parentOrgUnitPath", "blockInheritance"]);
    return { structuredContent: await request(accessToken, "PUT", `/customer/${encodeURIComponent(customer)}/orgunits/${encodeOrgUnitPath(orgUnitPath)}`, body, tool, { customer, orgUnitPath }) };
  }

  if (tool === "google_admin/delete_org_unit") {
    const customer = optArg(args, "customer") ?? "my_customer";
    const orgUnitPath = idArg(args, "org_unit_path", ["orgUnitPath"]);
    await request(accessToken, "DELETE", `/customer/${encodeURIComponent(customer)}/orgunits/${encodeOrgUnitPath(orgUnitPath)}`, undefined, tool, { customer, orgUnitPath });
    return { structuredContent: { deleted: true, customer, org_unit_path: orgUnitPath } };
  }

  throw new Error(`Unknown Google Admin tool: ${tool}`);
}
