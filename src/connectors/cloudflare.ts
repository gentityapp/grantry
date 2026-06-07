// Cloudflare connector — API Tokens.
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_TIMEOUT_MS = 10_000;

type CloudflareArgs = Record<string, unknown>;

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
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

async function fetchCloudflare(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUDFLARE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[cloudflare] request", { path, ...logContext });
    const response = await fetch(`${CLOUDFLARE_API}${path}`, { ...init, signal: controller.signal });
    console.log("[cloudflare] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[cloudflare] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CLOUDFLARE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Cloudflare request timed out after ${CLOUDFLARE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function requiredString(args: CloudflareArgs, key: string, alias?: string) {
  const value = String(args[key] ?? (alias ? args[alias] : "") ?? "").trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function boolOrUndefined(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function dnsRecordBody(args: CloudflareArgs, partial = false) {
  const body: Record<string, unknown> = {};
  for (const key of ["type", "name", "content", "ttl", "priority", "comment", "tags"]) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  const proxied = boolOrUndefined(args.proxied);
  if (proxied !== undefined) body.proxied = proxied;
  if (!partial) {
    for (const key of ["type", "name", "content"]) {
      if (body[key] === undefined || String(body[key] ?? "").trim() === "") throw new Error(`${key} is required`);
    }
  }
  return body;
}

export async function callCloudflareTool(tool: string, args: CloudflareArgs, token: string) {
  if (tool === "cloudflare/list_zones") {
    const params = new URLSearchParams();
    const name = String(args.name ?? "").trim();
    if (name) params.set("name", name);
    params.set("per_page", String(optionalNumber(args.per_page ?? args.perPage, 50, 1, 100)));
    const page = Number(args.page);
    if (Number.isFinite(page) && page > 0) params.set("page", String(Math.floor(page)));
    const r = await fetchCloudflare(`/zones?${params.toString()}`, { headers: headers(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok || j.success === false) throw new Error(`Cloudflare list_zones failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { results: j.result ?? [], result_info: j.result_info ?? null } };
  }

  if (tool === "cloudflare/get_zone") {
    const zoneId = requiredString(args, "zone_id", "zoneId");
    const r = await fetchCloudflare(`/zones/${encodeURIComponent(zoneId)}`, { headers: headers(token) }, { tool, zoneId });
    const j: any = await readJsonResponse(r);
    if (!r.ok || j.success === false) throw new Error(`Cloudflare get_zone failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j.result ?? j };
  }

  if (tool === "cloudflare/list_dns_records") {
    const zoneId = requiredString(args, "zone_id", "zoneId");
    const params = new URLSearchParams();
    for (const key of ["type", "name", "content"]) {
      const value = String(args[key] ?? "").trim();
      if (value) params.set(key, value);
    }
    params.set("per_page", String(optionalNumber(args.per_page ?? args.perPage, 100, 1, 500)));
    const page = Number(args.page);
    if (Number.isFinite(page) && page > 0) params.set("page", String(Math.floor(page)));
    const r = await fetchCloudflare(`/zones/${encodeURIComponent(zoneId)}/dns_records?${params.toString()}`, { headers: headers(token) }, { tool, zoneId });
    const j: any = await readJsonResponse(r);
    if (!r.ok || j.success === false) throw new Error(`Cloudflare list_dns_records failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { results: j.result ?? [], result_info: j.result_info ?? null } };
  }

  if (tool === "cloudflare/create_dns_record") {
    const zoneId = requiredString(args, "zone_id", "zoneId");
    const r = await fetchCloudflare(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(dnsRecordBody(args)),
    }, { tool, zoneId });
    const j: any = await readJsonResponse(r);
    if (!r.ok || j.success === false) throw new Error(`Cloudflare create_dns_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: j.result ?? j };
  }

  if (tool === "cloudflare/update_dns_record") {
    const zoneId = requiredString(args, "zone_id", "zoneId");
    const recordId = requiredString(args, "record_id", "recordId");
    const r = await fetchCloudflare(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(dnsRecordBody(args, true)),
    }, { tool, zoneId, recordId });
    const j: any = await readJsonResponse(r);
    if (!r.ok || j.success === false) throw new Error(`Cloudflare update_dns_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1200)}`);
    return { structuredContent: j.result ?? j };
  }

  if (tool === "cloudflare/delete_dns_record") {
    const zoneId = requiredString(args, "zone_id", "zoneId");
    const recordId = requiredString(args, "record_id", "recordId");
    const r = await fetchCloudflare(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, {
      method: "DELETE",
      headers: headers(token),
    }, { tool, zoneId, recordId });
    const j: any = await readJsonResponse(r);
    if (!r.ok || j.success === false) throw new Error(`Cloudflare delete_dns_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j.result ?? j };
  }

  if (tool === "cloudflare/purge_cache") {
    const zoneId = requiredString(args, "zone_id", "zoneId");
    const purgeEverything = boolOrUndefined(args.purge_everything ?? args.purgeEverything);
    const files = Array.isArray(args.files) ? args.files : undefined;
    const tags = Array.isArray(args.tags) ? args.tags : undefined;
    const hosts = Array.isArray(args.hosts) ? args.hosts : undefined;
    const prefixes = Array.isArray(args.prefixes) ? args.prefixes : undefined;
    const body: Record<string, unknown> = {};
    if (purgeEverything !== undefined) body.purge_everything = purgeEverything;
    if (files) body.files = files;
    if (tags) body.tags = tags;
    if (hosts) body.hosts = hosts;
    if (prefixes) body.prefixes = prefixes;
    if (Object.keys(body).length === 0) throw new Error("one of purge_everything, files, tags, hosts, or prefixes is required");
    const r = await fetchCloudflare(`/zones/${encodeURIComponent(zoneId)}/purge_cache`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }, { tool, zoneId });
    const j: any = await readJsonResponse(r);
    if (!r.ok || j.success === false) throw new Error(`Cloudflare purge_cache failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j.result ?? j };
  }

  throw new Error(`Unknown Cloudflare tool: ${tool}`);
}
