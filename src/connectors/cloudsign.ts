// CloudSign (クラウドサイン) Web API connector.
// Auth is non-standard: the pasted credential is a CloudSign *client_id*, which
// this connector exchanges for a short-lived (default 3600s) Bearer access token
// via POST /token (form-urlencoded client_id). grantry does NOT run an OAuth flow
// for CloudSign, so the exchange + caching happens here.
//
// Credential is EITHER a plain client_id string OR JSON
//   {"client_id":"...","environment":"production"|"sandbox"}
// environment defaults to "production".
const CLOUDSIGN_TIMEOUT_MS = 12_000;
const CLOUDSIGN_BASE_URLS: Record<string, string> = {
  production: "https://api.cloudsign.jp",
  sandbox: "https://api-sandbox.cloudsign.jp",
};

type CloudSignArgs = Record<string, unknown>;

type CloudSignCredential = {
  clientId: string;
  environment: "production" | "sandbox";
};

// In-memory access-token cache keyed by `${environment}:${clientId}`. Tokens live
// ~1h; we refresh 60s early. Cache survives across tool calls in the same process.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function parseCloudSignCredential(credential: string): CloudSignCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("CloudSign client_id is empty");
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const clientId = String(parsed.client_id ?? parsed.clientId ?? "").trim();
    if (!clientId) throw new Error("CloudSign credential JSON must include client_id");
    const environment = String(parsed.environment ?? parsed.env ?? "production").trim().toLowerCase();
    if (environment !== "production" && environment !== "sandbox") {
      throw new Error("CloudSign environment must be 'production' or 'sandbox'");
    }
    return { clientId, environment: environment as "production" | "sandbox" };
  }
  return { clientId: trimmed, environment: "production" };
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

async function fetchCloudSign(baseUrl: string, path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUDSIGN_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[cloudsign] request", { path, ...logContext });
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    console.log("[cloudsign] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[cloudsign] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CLOUDSIGN_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`CloudSign request timed out after ${CLOUDSIGN_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Exchange client_id -> access_token (POST /token), with a small process-level cache.
export async function getAccessToken(cred: CloudSignCredential): Promise<string> {
  const key = `${cred.environment}:${cred.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const baseUrl = CLOUDSIGN_BASE_URLS[cred.environment];
  const body = new URLSearchParams({ client_id: cred.clientId });
  const r = await fetchCloudSign(
    baseUrl,
    "/token",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { tool: "token" },
  );
  const j: any = await readJsonResponse(r);
  if (!r.ok || !j.access_token) {
    throw new Error(`CloudSign token exchange failed: ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
  }
  const expiresInMs = (Number(j.expires_in) || 3600) * 1000;
  tokenCache.set(key, { token: j.access_token, expiresAt: Date.now() + expiresInMs - 60_000 });
  return j.access_token;
}

async function requestJson(
  cred: CloudSignCredential,
  method: string,
  path: string,
  body: unknown,
  tool: string,
) {
  const accessToken = await getAccessToken(cred);
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchCloudSign(CLOUDSIGN_BASE_URLS[cred.environment], path, init, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`CloudSign ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function stringArg(args: CloudSignArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function documentId(args: CloudSignArgs) {
  return stringArg(args, "document_id", ["documentId", "id"]);
}

function participantId(args: CloudSignArgs) {
  return stringArg(args, "participant_id", ["participantId"]);
}

function queryString(args: CloudSignArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key] ?? args[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function objArg(args: CloudSignArgs, key: string) {
  const value = args[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export async function callCloudSignTool(tool: string, args: CloudSignArgs, credential: string) {
  const cred = parseCloudSignCredential(credential);

  if (tool === "cloudsign/list_documents") {
    const qs = queryString(args, ["status", "offset", "limit"]);
    return { structuredContent: await requestJson(cred, "GET", `/documents${qs}`, undefined, tool) };
  }

  if (tool === "cloudsign/get_document") {
    return { structuredContent: await requestJson(cred, "GET", `/documents/${encodeURIComponent(documentId(args))}`, undefined, tool) };
  }

  if (tool === "cloudsign/create_document") {
    // Accept a raw `document` object, or assemble from top-level fields.
    const body = objArg(args, "document") ?? {
      title: stringArg(args, "title"),
      ...(args.message !== undefined ? { message: args.message } : {}),
      ...(args.can_transfer !== undefined ? { can_transfer: args.can_transfer } : {}),
      ...(args.is_private !== undefined ? { is_private: args.is_private } : {}),
    };
    return { structuredContent: await requestJson(cred, "POST", "/documents", body, tool) };
  }

  if (tool === "cloudsign/update_document") {
    const body = objArg(args, "document") ?? {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.message !== undefined ? { message: args.message } : {}),
      ...(args.can_transfer !== undefined ? { can_transfer: args.can_transfer } : {}),
      ...(args.is_private !== undefined ? { is_private: args.is_private } : {}),
    };
    return { structuredContent: await requestJson(cred, "PUT", `/documents/${encodeURIComponent(documentId(args))}`, body, tool) };
  }

  if (tool === "cloudsign/send_document") {
    // POST /documents/{id} sends a draft (or a reminder on a pending document).
    const body = objArg(args, "body") ?? {};
    return { structuredContent: await requestJson(cred, "POST", `/documents/${encodeURIComponent(documentId(args))}`, body, tool) };
  }

  if (tool === "cloudsign/delete_document") {
    // DELETE only works on drafts.
    return { structuredContent: await requestJson(cred, "DELETE", `/documents/${encodeURIComponent(documentId(args))}`, undefined, tool) };
  }

  if (tool === "cloudsign/add_participant") {
    const docId = documentId(args);
    const body = objArg(args, "participant") ?? {
      email: stringArg(args, "email"),
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.order !== undefined ? { order: args.order } : {}),
      ...(args.organization !== undefined ? { organization: args.organization } : {}),
    };
    return { structuredContent: await requestJson(cred, "POST", `/documents/${encodeURIComponent(docId)}/participants`, body, tool) };
  }

  if (tool === "cloudsign/update_participant") {
    const docId = documentId(args);
    const pid = participantId(args);
    const body = objArg(args, "participant") ?? {
      ...(args.email !== undefined ? { email: args.email } : {}),
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.order !== undefined ? { order: args.order } : {}),
      ...(args.organization !== undefined ? { organization: args.organization } : {}),
    };
    return { structuredContent: await requestJson(cred, "PUT", `/documents/${encodeURIComponent(docId)}/participants/${encodeURIComponent(pid)}`, body, tool) };
  }

  if (tool === "cloudsign/delete_participant") {
    const docId = documentId(args);
    const pid = participantId(args);
    return { structuredContent: await requestJson(cred, "DELETE", `/documents/${encodeURIComponent(docId)}/participants/${encodeURIComponent(pid)}`, undefined, tool) };
  }

  throw new Error(`Unknown cloudsign tool: ${tool}`);
}
