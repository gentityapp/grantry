// Airtable connector - Personal Access Token via Authorization: Bearer <token>.
// Targets the Airtable REST API (metadata + data endpoints).
const AIRTABLE_API = "https://api.airtable.com/v0";
const AIRTABLE_TIMEOUT_MS = 12_000;

type AirtableArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(token: string, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchAirtable(
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AIRTABLE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[airtable] request", { path, ...logContext });
    const response = await fetch(`${AIRTABLE_API}${path}`, {
      ...init,
      signal: controller.signal,
    });
    console.log("[airtable] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[airtable] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted
        ? `timeout after ${AIRTABLE_TIMEOUT_MS}ms`
        : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted)
      throw new Error(`Airtable request timed out after ${AIRTABLE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: AirtableArgs, snake: string, aliases: string[] = []) {
  const candidates = [
    snake,
    snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
    ...aliases,
  ];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(args: AirtableArgs, keys: Array<string | [string, string]>) {
  const params = new URLSearchParams();
  for (const entry of keys) {
    const [argKey, paramKey] = Array.isArray(entry) ? entry : [entry, entry];
    const value =
      args[argKey] ??
      args[argKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(paramKey, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(
  token: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const init: RequestInit = {
    method,
    headers: headers(token, body !== undefined),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchAirtable(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok)
    throw new Error(
      `Airtable ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`,
    );
  return j;
}

export async function callAirtableTool(
  tool: string,
  args: AirtableArgs,
  credential: string,
) {
  if (tool === "airtable/list_bases") {
    return {
      structuredContent: await request(
        credential,
        "GET",
        "/meta/bases",
        undefined,
        tool,
      ),
    };
  }

  if (tool === "airtable/list_tables") {
    const baseId = idArg(args, "base_id");
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/meta/bases/${encodeURIComponent(baseId)}/tables`,
        undefined,
        tool,
        { baseId },
      ),
    };
  }

  if (tool === "airtable/list_records") {
    const baseId = idArg(args, "base_id");
    const table = idArg(args, "table");
    const qs = queryString(args, [
      ["max_records", "maxRecords"],
      "view",
      ["page_size", "pageSize"],
      "offset",
      ["filter_by_formula", "filterByFormula"],
    ]);
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}${qs}`,
        undefined,
        tool,
        { baseId, table },
      ),
    };
  }

  if (tool === "airtable/get_record") {
    const baseId = idArg(args, "base_id");
    const table = idArg(args, "table");
    const recordId = idArg(args, "record_id");
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`,
        undefined,
        tool,
        { baseId, table, recordId },
      ),
    };
  }

  if (tool === "airtable/create_record") {
    const baseId = idArg(args, "base_id");
    const table = idArg(args, "table");
    let records: unknown[];
    if (Array.isArray(args.records)) {
      records = args.records;
    } else if (args.fields && typeof args.fields === "object") {
      records = [{ fields: args.fields }];
    } else {
      throw new Error("either records (array) or fields (object) is required");
    }
    return {
      structuredContent: await request(
        credential,
        "POST",
        `/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`,
        { records },
        tool,
        { baseId, table },
      ),
    };
  }

  if (tool === "airtable/update_record") {
    const baseId = idArg(args, "base_id");
    const table = idArg(args, "table");
    const recordId = idArg(args, "record_id");
    if (!args.fields || typeof args.fields !== "object") {
      throw new Error("fields is required");
    }
    return {
      structuredContent: await request(
        credential,
        "PATCH",
        `/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`,
        { fields: args.fields },
        tool,
        { baseId, table, recordId },
      ),
    };
  }

  if (tool === "airtable/delete_record") {
    const baseId = idArg(args, "base_id");
    const table = idArg(args, "table");
    const recordId = idArg(args, "record_id");
    return {
      structuredContent: await request(
        credential,
        "DELETE",
        `/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`,
        undefined,
        tool,
        { baseId, table, recordId },
      ),
    };
  }

  throw new Error(`Unknown Airtable tool: ${tool}`);
}
