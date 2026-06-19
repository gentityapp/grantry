// Google Tag Manager connector - OAuth access token via Authorization: Bearer.
// Targets the Tag Manager API v2 (read operations + scoped write operations:
// create_tag / create_version / publish_version). Writes require the
// tagmanager.edit.containers and tagmanager.publish OAuth scopes.
const GTM_API = "https://www.googleapis.com/tagmanager/v2";
const GTM_TIMEOUT_MS = 12_000;

type GtmArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
}

async function fetchGtm(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GTM_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_tag_manager] request", { path, ...logContext });
    const response = await fetch(`${GTM_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_tag_manager] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_tag_manager] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${GTM_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Google Tag Manager request timed out after ${GTM_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GtmArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function get(accessToken: string, path: string, tool: string, logContext: Record<string, unknown> = {}) {
  const r = await fetchGtm(path, { headers: headers(accessToken) }, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Tag Manager ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

async function post(accessToken: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = {
    method: "POST",
    headers: { ...headers(accessToken), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const r = await fetchGtm(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Tag Manager ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function objArg(args: GtmArgs, key: string): Record<string, unknown> {
  const v = args[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${key} (object) is required`);
  return v as Record<string, unknown>;
}

export async function callGoogleTagManagerTool(tool: string, args: GtmArgs, accessToken: string) {
  if (tool === "google_tag_manager/list_accounts") {
    return { structuredContent: await get(accessToken, "/accounts", tool) };
  }

  if (tool === "google_tag_manager/list_containers") {
    const accountId = idArg(args, "account_id", ["accountId"]);
    return { structuredContent: await get(accessToken, `/accounts/${encodeURIComponent(accountId)}/containers`, tool, { accountId }) };
  }

  if (tool === "google_tag_manager/get_container") {
    const accountId = idArg(args, "account_id", ["accountId"]);
    const containerId = idArg(args, "container_id", ["containerId"]);
    return { structuredContent: await get(accessToken, `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(containerId)}`, tool, { accountId, containerId }) };
  }

  if (tool === "google_tag_manager/list_workspaces") {
    const accountId = idArg(args, "account_id", ["accountId"]);
    const containerId = idArg(args, "container_id", ["containerId"]);
    return { structuredContent: await get(accessToken, `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(containerId)}/workspaces`, tool, { accountId, containerId }) };
  }

  if (tool === "google_tag_manager/list_tags") {
    const accountId = idArg(args, "account_id", ["accountId"]);
    const containerId = idArg(args, "container_id", ["containerId"]);
    const workspaceId = idArg(args, "workspace_id", ["workspaceId"]);
    return { structuredContent: await get(accessToken, `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(containerId)}/workspaces/${encodeURIComponent(workspaceId)}/tags`, tool, { accountId, containerId, workspaceId }) };
  }

  // --- write operations (require tagmanager.edit.containers / tagmanager.publish) ---

  if (tool === "google_tag_manager/create_tag") {
    const accountId = idArg(args, "account_id", ["accountId"]);
    const containerId = idArg(args, "container_id", ["containerId"]);
    const workspaceId = idArg(args, "workspace_id", ["workspaceId"]);
    const tag = objArg(args, "tag");
    const path = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(containerId)}/workspaces/${encodeURIComponent(workspaceId)}/tags`;
    return { structuredContent: await post(accessToken, path, tag, tool, { accountId, containerId, workspaceId }) };
  }

  if (tool === "google_tag_manager/create_version") {
    const accountId = idArg(args, "account_id", ["accountId"]);
    const containerId = idArg(args, "container_id", ["containerId"]);
    const workspaceId = idArg(args, "workspace_id", ["workspaceId"]);
    const body: Record<string, unknown> = {};
    const name = String(args.name ?? "").trim();
    const notes = String(args.notes ?? "").trim();
    if (name) body.name = name;
    if (notes) body.notes = notes;
    const path = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(containerId)}/workspaces/${encodeURIComponent(workspaceId)}:create_version`;
    return { structuredContent: await post(accessToken, path, body, tool, { accountId, containerId, workspaceId }) };
  }

  if (tool === "google_tag_manager/publish_version") {
    const accountId = idArg(args, "account_id", ["accountId"]);
    const containerId = idArg(args, "container_id", ["containerId"]);
    const versionId = idArg(args, "version_id", ["versionId"]);
    const path = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(containerId)}/versions/${encodeURIComponent(versionId)}:publish`;
    return { structuredContent: await post(accessToken, path, undefined, tool, { accountId, containerId, versionId }) };
  }

  throw new Error(`Unknown Google Tag Manager tool: ${tool}`);
}
