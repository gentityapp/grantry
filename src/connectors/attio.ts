// Attio CRM connector - workspace access token.
const ATTIO_API = "https://api.attio.com/v2";
const ATTIO_TIMEOUT_MS = 10_000;

type AttioArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchAttio(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ATTIO_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[attio] request", { path, ...logContext });
    const response = await fetch(`${ATTIO_API}${path}`, { ...init, signal: controller.signal });
    console.log("[attio] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[attio] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${ATTIO_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Attio request timed out after ${ATTIO_TIMEOUT_MS}ms`);
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

function stringArray(value: unknown, fallback: string[] = []) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value ?? "").trim();
  return s ? s.split(",").map((v) => v.trim()).filter(Boolean) : fallback;
}

function objectSlug(args: AttioArgs) {
  const object = String(args.object ?? args.object_slug ?? args.objectSlug ?? "").trim();
  if (!object) throw new Error("object is required");
  return object;
}

function recordId(args: AttioArgs) {
  const id = String(args.record_id ?? args.recordId ?? "").trim();
  if (!id) throw new Error("record_id is required");
  return id;
}

function valuesBody(args: AttioArgs) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) {
    return { data: args.data };
  }
  const values = args.values && typeof args.values === "object" && !Array.isArray(args.values) ? args.values : null;
  if (!values) throw new Error("values object is required");
  return { data: { values } };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export async function callAttioTool(tool: string, args: AttioArgs, token: string) {
  if (tool === "attio/search_records") {
    const query = String(args.query ?? "");
    const objects = stringArray(args.objects);
    if (!objects.length) throw new Error("objects array is required");
    const body: Record<string, unknown> = {
      query,
      objects,
      request_as: args.request_as && typeof args.request_as === "object" ? args.request_as : { type: "workspace" },
      limit: boundedInteger(args.limit, 25, 1, 25),
    };
    const r = await fetchAttio("/objects/records/search", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Attio search_records failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { data: j.data ?? [] } };
  }

  if (tool === "attio/list_records") {
    const object = objectSlug(args);
    const body: Record<string, unknown> = {
      limit: boundedInteger(args.limit, 100, 1, 500),
      offset: boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    };
    if (args.filter && typeof args.filter === "object") body.filter = args.filter;
    if (args.filter_view_id) body.filter_view_id = String(args.filter_view_id);
    if (Array.isArray(args.sorts)) body.sorts = args.sorts;
    const r = await fetchAttio(`/objects/${encodeURIComponent(object)}/records/query`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }, { tool, object });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Attio list_records failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { data: j.data ?? [] } };
  }

  if (tool === "attio/get_record") {
    const object = objectSlug(args);
    const id = recordId(args);
    const r = await fetchAttio(`/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(id)}`, {
      headers: headers(token),
    }, { tool, object, recordId: id });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Attio get_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "attio/create_record") {
    const object = objectSlug(args);
    const r = await fetchAttio(`/objects/${encodeURIComponent(object)}/records`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(valuesBody(args)),
    }, { tool, object });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Attio create_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "attio/upsert_record") {
    const object = objectSlug(args);
    const matchingAttribute = String(args.matching_attribute ?? args.matchingAttribute ?? "").trim();
    if (!matchingAttribute) throw new Error("matching_attribute is required");
    const params = new URLSearchParams({ matching_attribute: matchingAttribute });
    const r = await fetchAttio(`/objects/${encodeURIComponent(object)}/records?${params.toString()}`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify(valuesBody(args)),
    }, { tool, object, matchingAttribute });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Attio upsert_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "attio/update_record") {
    const object = objectSlug(args);
    const id = recordId(args);
    const r = await fetchAttio(`/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(valuesBody(args)),
    }, { tool, object, recordId: id });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Attio update_record failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  throw new Error(`Unknown Attio tool: ${tool}`);
}
