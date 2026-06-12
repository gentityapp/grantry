// WordPress connector — JSON credential {site, username, app_password}.
// Auth: Basic username:app_password (keep app_password exactly as given).
const WORDPRESS_TIMEOUT_MS = 12_000;

type WordpressArgs = Record<string, unknown>;

type WordpressCredential = {
  site: string;
  username: string;
  app_password: string;
};

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseWordpressCredential(credential: string): WordpressCredential & { base: string; authHeader: string } {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("WordPress credential is empty");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      'WordPress credential must be a JSON object like {"site":"https://blog.example.com","username":"admin","app_password":"xxxx xxxx ..."}'
    );
  }
  const site = String(parsed.site ?? "").trim().replace(/\/+$/, "");
  const username = String(parsed.username ?? "").trim();
  const app_password = String(parsed.app_password ?? parsed.appPassword ?? "").trim();
  if (!site) throw new Error('WordPress credential JSON must include "site"');
  if (!username) throw new Error('WordPress credential JSON must include "username"');
  if (!app_password) throw new Error('WordPress credential JSON must include "app_password"');
  const base = `${site}/wp-json/wp/v2`;
  // Keep app_password exactly as given (spaces included) per spec
  const authHeader = "Basic " + Buffer.from(`${username}:${app_password}`).toString("base64");
  return { site, username, app_password, base, authHeader };
}

async function fetchWordpress(
  base: string,
  authHeader: string,
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORDPRESS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[wordpress] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[wordpress] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[wordpress] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${WORDPRESS_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`WordPress request timed out after ${WORDPRESS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: WordpressArgs, snake: string) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const value = String(args[snake] ?? args[camel] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

function queryString(args: WordpressArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = args[key] ?? args[camel];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(
  base: string,
  authHeader: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {}
) {
  const hdrs: Record<string, string> = {
    Authorization: authHeader,
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const init: RequestInit = { method, headers: hdrs };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchWordpress(base, authHeader, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`WordPress ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callWordpressTool(tool: string, args: WordpressArgs, credential: string) {
  const { base, authHeader } = parseWordpressCredential(credential);

  if (tool === "wordpress/list_posts") {
    const qs = queryString(args, ["per_page", "page", "search", "status"]);
    return { structuredContent: await request(base, authHeader, "GET", `/posts${qs}`, undefined, tool) };
  }

  if (tool === "wordpress/get_post") {
    const postId = idArg(args, "post_id");
    return {
      structuredContent: await request(
        base, authHeader, "GET",
        `/posts/${encodeURIComponent(postId)}`,
        undefined, tool, { postId }
      ),
    };
  }

  if (tool === "wordpress/create_post") {
    const title = String(args.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const body: Record<string, unknown> = { title };
    const content = String(args.content ?? "").trim();
    if (content) body.content = content;
    const status = String(args.status ?? "draft").trim() || "draft";
    body.status = status;
    return {
      structuredContent: await request(base, authHeader, "POST", "/posts", body, tool),
    };
  }

  if (tool === "wordpress/update_post") {
    const postId = idArg(args, "post_id");
    const body: Record<string, unknown> = {};
    const title = String(args.title ?? "").trim();
    if (title) body.title = title;
    const content = String(args.content ?? "").trim();
    if (content) body.content = content;
    const status = String(args.status ?? "").trim();
    if (status) body.status = status;
    return {
      structuredContent: await request(
        base, authHeader, "POST",
        `/posts/${encodeURIComponent(postId)}`,
        body, tool, { postId }
      ),
    };
  }

  if (tool === "wordpress/list_pages") {
    const qs = queryString(args, ["per_page", "page", "search"]);
    return { structuredContent: await request(base, authHeader, "GET", `/pages${qs}`, undefined, tool) };
  }

  if (tool === "wordpress/list_categories") {
    const qs = queryString(args, ["per_page"]);
    return { structuredContent: await request(base, authHeader, "GET", `/categories${qs}`, undefined, tool) };
  }

  throw new Error(`Unknown WordPress tool: ${tool}`);
}
