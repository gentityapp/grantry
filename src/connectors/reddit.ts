// Reddit connector - OAuth 2.0 bearer token (access token issued via the
// generic OAuth flow). All authed calls go to oauth.reddit.com and require a
// descriptive User-Agent header.
const REDDIT_API = "https://oauth.reddit.com";
const REDDIT_TIMEOUT_MS = 12_000;
// Reddit asks for a unique, descriptive User-Agent on every request.
const REDDIT_USER_AGENT = "grantry/1.0 (MCP connector)";

type RedditArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchReddit(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REDDIT_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[reddit] request", { path, ...logContext });
    const response = await fetch(`${REDDIT_API}${path}`, { ...init, signal: controller.signal });
    console.log("[reddit] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[reddit] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${REDDIT_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Reddit request timed out after ${REDDIT_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": REDDIT_USER_AGENT,
  };
}

function strArg(args: RedditArgs, key: string, aliases: string[] = []): string {
  for (const candidate of [key, ...aliases]) {
    const value = String(args[candidate] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function requireArg(args: RedditArgs, key: string, aliases: string[] = []): string {
  const value = strArg(args, key, aliases);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function buildQuery(pairs: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function getJson(token: string, path: string, tool: string) {
  const r = await fetchReddit(path, { method: "GET", headers: authHeaders(token) }, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Reddit ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

async function postForm(token: string, path: string, form: Record<string, unknown>, tool: string) {
  const body = new URLSearchParams();
  body.set("api_type", "json");
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || value === null || value === "") continue;
    body.set(key, String(value));
  }
  const r = await fetchReddit(path, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Reddit ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  // Reddit returns a 200 with an errors array inside json for many write failures.
  const errors = j?.json?.errors;
  if (Array.isArray(errors) && errors.length) {
    throw new Error(`Reddit ${tool} failed: ${JSON.stringify(errors).slice(0, 1000)}`);
  }
  return j;
}

export async function callRedditTool(tool: string, args: RedditArgs, token: string) {
  if (tool === "reddit/get_me") {
    return { structuredContent: await getJson(token, "/api/v1/me", tool) };
  }

  if (tool === "reddit/get_subreddit") {
    const subreddit = requireArg(args, "subreddit", ["sr"]);
    return { structuredContent: await getJson(token, `/r/${encodeURIComponent(subreddit)}/about`, tool) };
  }

  if (tool === "reddit/list_posts") {
    const subreddit = requireArg(args, "subreddit", ["sr"]);
    const sort = strArg(args, "sort") || "hot";
    const qs = buildQuery({
      limit: args.limit,
      after: args.after,
      t: args.time ?? args.t,
    });
    return { structuredContent: await getJson(token, `/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}${qs}`, tool) };
  }

  if (tool === "reddit/search") {
    const query = requireArg(args, "query", ["q"]);
    const subreddit = strArg(args, "subreddit", ["sr"]);
    const qs = buildQuery({
      q: query,
      sort: args.sort,
      t: args.time ?? args.t,
      limit: args.limit,
      after: args.after,
      restrict_sr: subreddit ? "1" : undefined,
    });
    const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search${qs}` : `/search${qs}`;
    return { structuredContent: await getJson(token, path, tool) };
  }

  if (tool === "reddit/get_comments") {
    const article = requireArg(args, "article", ["post_id", "id"]).replace(/^t3_/, "");
    const subreddit = strArg(args, "subreddit", ["sr"]);
    const qs = buildQuery({ limit: args.limit, sort: args.sort });
    const path = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(article)}${qs}`
      : `/comments/${encodeURIComponent(article)}${qs}`;
    return { structuredContent: await getJson(token, path, tool) };
  }

  if (tool === "reddit/submit_post") {
    const subreddit = requireArg(args, "subreddit", ["sr"]);
    const title = requireArg(args, "title");
    const kind = strArg(args, "kind") || (strArg(args, "url") ? "link" : "self");
    const form: Record<string, unknown> = { sr: subreddit, title, kind };
    if (kind === "link") {
      form.url = requireArg(args, "url");
    } else {
      form.text = strArg(args, "text");
    }
    if (strArg(args, "flair_id")) form.flair_id = strArg(args, "flair_id");
    return { structuredContent: await postForm(token, "/api/submit", form, tool) };
  }

  if (tool === "reddit/submit_comment") {
    const parent = requireArg(args, "parent", ["thing_id", "parent_id"]);
    const text = requireArg(args, "text");
    return { structuredContent: await postForm(token, "/api/comment", { thing_id: parent, text }, tool) };
  }

  if (tool === "reddit/vote") {
    const id = requireArg(args, "id", ["thing_id"]);
    const dir = String(args.dir ?? args.direction ?? "1");
    if (!["1", "0", "-1"].includes(dir)) throw new Error("dir must be 1 (up), 0 (clear), or -1 (down)");
    return { structuredContent: await postForm(token, "/api/vote", { id, dir }, tool) };
  }

  throw new Error(`Unknown Reddit tool: ${tool}`);
}
