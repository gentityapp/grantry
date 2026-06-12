// Snowflake connector — Snowflake REST API v2, Programmatic Access Token (PAT) auth.
// Endpoint base: https://<account>.snowflakecomputing.com/api/v2
// Required credential fields: account (e.g. "orgname-accountname"), token.
// Optional credential fields: token_type (default "PROGRAMMATIC_ACCESS_TOKEN"), warehouse, database, schema, role.
const SNOWFLAKE_TIMEOUT_MS = 12_000;

type SnowflakeArgs = Record<string, unknown>;

type SnowflakeCredential = {
  account: string;
  token: string;
  token_type: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
};

export function parseSnowflakeCredential(credential: string): SnowflakeCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Snowflake credential is empty");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Snowflake credential must be a JSON object");
  }
  const account = String(parsed.account ?? "").trim();
  if (!account) throw new Error("Snowflake credential JSON must include account");
  const token = String(parsed.token ?? "").trim();
  if (!token) throw new Error("Snowflake credential JSON must include token");
  const token_type = String(parsed.token_type ?? "PROGRAMMATIC_ACCESS_TOKEN").trim() || "PROGRAMMATIC_ACCESS_TOKEN";
  return {
    account,
    token,
    token_type,
    warehouse: parsed.warehouse ? String(parsed.warehouse).trim() : undefined,
    database: parsed.database ? String(parsed.database).trim() : undefined,
    schema: parsed.schema ? String(parsed.schema).trim() : undefined,
    role: parsed.role ? String(parsed.role).trim() : undefined,
  };
}

function snowflakeHeaders(cred: SnowflakeCredential) {
  return {
    Authorization: `Bearer ${cred.token}`,
    "X-Snowflake-Authorization-Token-Type": cred.token_type,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchSnowflake(
  url: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SNOWFLAKE_TIMEOUT_MS);
  const started = Date.now();
  const shortUrl = url.replace(/https?:\/\/[^/]+/, "");
  try {
    console.log("[snowflake] request", { url: shortUrl, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[snowflake] response", {
      url: shortUrl,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[snowflake] failed", {
      url: shortUrl,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${SNOWFLAKE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Snowflake request timed out after ${SNOWFLAKE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
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

export async function callSnowflakeTool(tool: string, args: SnowflakeArgs, credential: string) {
  const cred = parseSnowflakeCredential(credential);
  const base = `https://${cred.account}.snowflakecomputing.com/api/v2`;
  const hdrs = snowflakeHeaders(cred);

  if (tool === "snowflake/execute_statement") {
    const statement = String(args.statement ?? "").trim();
    if (!statement) throw new Error("statement is required");
    const body: Record<string, unknown> = { statement };
    if (args.timeout !== undefined) body.timeout = args.timeout;
    // Prefer explicit args; fall back to credential defaults
    const warehouse = String(args.warehouse ?? cred.warehouse ?? "").trim();
    const database = String(args.database ?? cred.database ?? "").trim();
    const schema = String(args.schema ?? cred.schema ?? "").trim();
    const role = String(args.role ?? cred.role ?? "").trim();
    if (warehouse) body.warehouse = warehouse;
    if (database) body.database = database;
    if (schema) body.schema = schema;
    if (role) body.role = role;
    const r = await fetchSnowflake(
      `${base}/statements`,
      { method: "POST", headers: hdrs, body: JSON.stringify(body) },
      { tool },
    );
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Snowflake execute_statement failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "snowflake/get_statement") {
    const statement_handle = String(args.statement_handle ?? "").trim();
    if (!statement_handle) throw new Error("statement_handle is required");
    const r = await fetchSnowflake(
      `${base}/statements/${encodeURIComponent(statement_handle)}`,
      { method: "GET", headers: hdrs },
      { tool, statement_handle },
    );
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Snowflake get_statement failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "snowflake/cancel_statement") {
    const statement_handle = String(args.statement_handle ?? "").trim();
    if (!statement_handle) throw new Error("statement_handle is required");
    const r = await fetchSnowflake(
      `${base}/statements/${encodeURIComponent(statement_handle)}/cancel`,
      { method: "POST", headers: hdrs, body: JSON.stringify({}) },
      { tool, statement_handle },
    );
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Snowflake cancel_statement failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  throw new Error(`Unknown Snowflake tool: ${tool}`);
}
