// Vercel connector - Access token authentication via Authorization: Bearer <token>.
// Targets the Vercel REST API.
const VERCEL_API = "https://api.vercel.com";
const VERCEL_TIMEOUT_MS = 12_000;

type VercelArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function fetchVercel(
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERCEL_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[vercel] request", { path, ...logContext });
    const response = await fetch(`${VERCEL_API}${path}`, {
      ...init,
      signal: controller.signal,
    });
    console.log("[vercel] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[vercel] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted
        ? `timeout after ${VERCEL_TIMEOUT_MS}ms`
        : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted)
      throw new Error(`Vercel request timed out after ${VERCEL_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: VercelArgs, snake: string, aliases: string[] = []) {
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

function queryString(
  args: VercelArgs,
  keys: Array<string | [string, string]>,
) {
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
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const init: RequestInit = { method, headers: headers(token) };
  const r = await fetchVercel(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok)
    throw new Error(
      `Vercel ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`,
    );
  return j;
}

export async function callVercelTool(
  tool: string,
  args: VercelArgs,
  credential: string,
) {
  if (tool === "vercel/get_user") {
    return {
      structuredContent: await request(credential, "GET", "/v2/user", tool),
    };
  }

  if (tool === "vercel/list_projects") {
    const qs = queryString(args, [
      "limit",
      ["team_id", "teamId"],
    ]);
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/v9/projects${qs}`,
        tool,
      ),
    };
  }

  if (tool === "vercel/get_project") {
    const projectId = idArg(args, "project_id");
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/v9/projects/${encodeURIComponent(projectId)}`,
        tool,
        { projectId },
      ),
    };
  }

  if (tool === "vercel/list_deployments") {
    const qs = queryString(args, [
      "limit",
      ["project_id", "projectId"],
      "app",
      ["team_id", "teamId"],
    ]);
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/v6/deployments${qs}`,
        tool,
      ),
    };
  }

  if (tool === "vercel/get_deployment") {
    const deploymentId = idArg(args, "deployment_id");
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/v13/deployments/${encodeURIComponent(deploymentId)}`,
        tool,
        { deploymentId },
      ),
    };
  }

  if (tool === "vercel/list_domains") {
    const qs = queryString(args, [
      "limit",
      ["team_id", "teamId"],
    ]);
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/v5/domains${qs}`,
        tool,
      ),
    };
  }

  throw new Error(`Unknown Vercel tool: ${tool}`);
}
