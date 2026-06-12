// Salesforce connector - REST API v60.0. OAuth Bearer token.
// Credential JSON: {"instance_url":"https://acme.my.salesforce.com","token":"<access token>"}
const SALESFORCE_TIMEOUT_MS = 12_000;

type SalesforceArgs = Record<string, unknown>;

type SalesforceCredential = {
  instance_url: string;
  token: string;
};

async function readJson(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function parseSalesforceCredential(credential: string): SalesforceCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Salesforce credential is empty");
  const parsed = JSON.parse(trimmed);
  const instance_url = String(parsed.instance_url ?? parsed.instanceUrl ?? "").trim();
  const token = String(parsed.token ?? parsed.access_token ?? parsed.accessToken ?? "").trim();
  if (!instance_url) throw new Error("Salesforce credential must include instance_url");
  if (!token) throw new Error("Salesforce credential must include token");
  return { instance_url: instance_url.replace(/\/+$/, ""), token };
}

function sfHeaders(token: string, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchSalesforce(
  base: string,
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SALESFORCE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[salesforce] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[salesforce] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[salesforce] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${SALESFORCE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Salesforce request timed out after ${SALESFORCE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  cred: SalesforceCredential,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const base = `${cred.instance_url}/services/data/v60.0`;
  const hasBody = body !== undefined;
  const init: RequestInit = { method, headers: sfHeaders(cred.token, hasBody) };
  if (hasBody) init.body = JSON.stringify(body);
  const r = await fetchSalesforce(base, path, init, { tool, ...logContext });
  // 204 No Content (PATCH/DELETE success)
  if (r.status === 204) return null;
  const j: any = await readJson(r);
  if (!r.ok) throw new Error(`Salesforce ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function idArg(args: SalesforceArgs, snake: string) {
  const value = String(args[snake] ?? args[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

export async function callSalesforceTool(tool: string, args: SalesforceArgs, credential: string) {
  const cred = parseSalesforceCredential(credential);

  if (tool === "salesforce/query") {
    const soql = String(args.soql ?? "").trim();
    if (!soql) throw new Error("soql is required");
    const params = new URLSearchParams({ q: soql });
    return {
      structuredContent: await request(cred, "GET", `/query?${params}`, undefined, tool),
    };
  }

  if (tool === "salesforce/search") {
    const sosl = String(args.sosl ?? "").trim();
    if (!sosl) throw new Error("sosl is required");
    const params = new URLSearchParams({ q: sosl });
    return {
      structuredContent: await request(cred, "GET", `/search?${params}`, undefined, tool),
    };
  }

  if (tool === "salesforce/get_record") {
    const sobject = idArg(args, "sobject");
    const recordId = idArg(args, "record_id");
    return {
      structuredContent: await request(
        cred,
        "GET",
        `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(recordId)}`,
        undefined,
        tool,
        { sobject, recordId },
      ),
    };
  }

  if (tool === "salesforce/create_record") {
    const sobject = idArg(args, "sobject");
    const fields = args.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error("fields must be an object");
    }
    return {
      structuredContent: await request(
        cred,
        "POST",
        `/sobjects/${encodeURIComponent(sobject)}`,
        fields,
        tool,
        { sobject },
      ),
    };
  }

  if (tool === "salesforce/update_record") {
    const sobject = idArg(args, "sobject");
    const recordId = idArg(args, "record_id");
    const fields = args.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error("fields must be an object");
    }
    await request(
      cred,
      "PATCH",
      `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(recordId)}`,
      fields,
      tool,
      { sobject, recordId },
    );
    return { structuredContent: { updated: true, sobject, record_id: recordId } };
  }

  if (tool === "salesforce/delete_record") {
    const sobject = idArg(args, "sobject");
    const recordId = idArg(args, "record_id");
    await request(
      cred,
      "DELETE",
      `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(recordId)}`,
      undefined,
      tool,
      { sobject, recordId },
    );
    return { structuredContent: { deleted: true, sobject, record_id: recordId } };
  }

  throw new Error(`Unknown Salesforce tool: ${tool}`);
}
