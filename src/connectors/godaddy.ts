// GoDaddy connector — Production API Key + Secret.
// Credential format: the pasted token is "KEY:SECRET". It is sent as
// Authorization: sso-key KEY:SECRET to the GoDaddy v1 API.
const GODADDY_API = "https://api.godaddy.com";
const GODADDY_TIMEOUT_MS = 10_000;

type GodaddyArgs = Record<string, unknown>;

function headers(credential: string) {
  return {
    Authorization: `sso-key ${credential}`,
    Accept: "application/json",
    "Content-Type": "application/json",
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

async function fetchGodaddy(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GODADDY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[godaddy] request", { path, ...logContext });
    const response = await fetch(`${GODADDY_API}${path}`, { ...init, signal: controller.signal });
    console.log("[godaddy] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[godaddy] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${GODADDY_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`GoDaddy request timed out after ${GODADDY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function requiredString(args: GodaddyArgs, key: string, alias?: string) {
  const value = String(args[key] ?? (alias ? args[alias] : "") ?? "").trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** Build a DNS record body from args, validating required fields per the GoDaddy schema. */
function recordFromArgs(args: GodaddyArgs): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of ["type", "name", "data", "ttl", "priority", "service", "protocol", "port", "weight"]) {
    if (args[key] !== undefined) record[key] = args[key];
  }
  return record;
}

/** Records to PATCH (add): each must carry type/name/data. */
function recordsForAdd(args: GodaddyArgs): Array<Record<string, unknown>> {
  if (Array.isArray(args.records)) return args.records as Array<Record<string, unknown>>;
  const record = recordFromArgs(args);
  for (const key of ["type", "name", "data"]) {
    if (record[key] === undefined || String(record[key] ?? "").trim() === "") throw new Error(`${key} is required (or pass a records array)`);
  }
  return [record];
}

/** Records to PUT (replace) for a given type+name: each carries data (type/name come from the path). */
function recordsForReplace(args: GodaddyArgs): Array<Record<string, unknown>> {
  if (Array.isArray(args.records)) return args.records as Array<Record<string, unknown>>;
  const data = String(args.data ?? "").trim();
  if (!data) throw new Error("data is required (or pass a records array)");
  const record: Record<string, unknown> = { data };
  for (const key of ["ttl", "priority", "service", "protocol", "port", "weight"]) {
    if (args[key] !== undefined) record[key] = args[key];
  }
  return [record];
}

export async function callGodaddyTool(tool: string, args: GodaddyArgs, credential: string) {
  if (tool === "godaddy/list_domains") {
    const params = new URLSearchParams();
    params.set("limit", String(optionalNumber(args.limit, 100, 1, 1000)));
    const marker = String(args.marker ?? "").trim();
    if (marker) params.set("marker", marker);
    const statuses = String(args.statuses ?? args.status ?? "").trim();
    if (statuses) params.set("statuses", statuses);
    const r = await fetchGodaddy(`/v1/domains?${params.toString()}`, { headers: headers(credential) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`GoDaddy list_domains failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { results: Array.isArray(j) ? j : (j.domains ?? j) } };
  }

  if (tool === "godaddy/get_domain") {
    const domain = requiredString(args, "domain");
    const r = await fetchGodaddy(`/v1/domains/${encodeURIComponent(domain)}`, { headers: headers(credential) }, { tool, domain });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`GoDaddy get_domain failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "godaddy/check_availability") {
    const domain = requiredString(args, "domain");
    const params = new URLSearchParams({ domain });
    const checkType = String(args.check_type ?? args.checkType ?? "").trim();
    if (checkType) params.set("checkType", checkType);
    const r = await fetchGodaddy(`/v1/domains/available?${params.toString()}`, { headers: headers(credential) }, { tool, domain });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`GoDaddy check_availability failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "godaddy/list_dns_records") {
    const domain = requiredString(args, "domain");
    const type = String(args.type ?? "").trim();
    const name = String(args.name ?? "").trim();
    let path = `/v1/domains/${encodeURIComponent(domain)}/records`;
    if (type) {
      path += `/${encodeURIComponent(type)}`;
      if (name) path += `/${encodeURIComponent(name)}`;
    }
    const params = new URLSearchParams();
    params.set("limit", String(optionalNumber(args.limit, 100, 1, 500)));
    const offset = Number(args.offset);
    if (Number.isFinite(offset) && offset > 0) params.set("offset", String(Math.floor(offset)));
    const r = await fetchGodaddy(`${path}?${params.toString()}`, { headers: headers(credential) }, { tool, domain });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`GoDaddy list_dns_records failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { results: Array.isArray(j) ? j : (j.records ?? j) } };
  }

  if (tool === "godaddy/add_dns_records") {
    const domain = requiredString(args, "domain");
    const records = recordsForAdd(args);
    const r = await fetchGodaddy(`/v1/domains/${encodeURIComponent(domain)}/records`, {
      method: "PATCH",
      headers: headers(credential),
      body: JSON.stringify(records),
    }, { tool, domain });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`GoDaddy add_dns_records failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: { ok: true, added: records.length } };
  }

  if (tool === "godaddy/replace_dns_records") {
    const domain = requiredString(args, "domain");
    const type = requiredString(args, "type");
    const name = requiredString(args, "name");
    const records = recordsForReplace(args);
    const r = await fetchGodaddy(`/v1/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(type)}/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: headers(credential),
      body: JSON.stringify(records),
    }, { tool, domain, type, name });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`GoDaddy replace_dns_records failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: { ok: true, type, name, replaced: records.length } };
  }

  if (tool === "godaddy/delete_dns_record") {
    const domain = requiredString(args, "domain");
    const type = requiredString(args, "type");
    const name = requiredString(args, "name");
    const r = await fetchGodaddy(`/v1/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(type)}/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: headers(credential),
    }, { tool, domain, type, name });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`GoDaddy delete_dns_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { ok: true, type, name } };
  }

  throw new Error(`Unknown GoDaddy tool: ${tool}`);
}
