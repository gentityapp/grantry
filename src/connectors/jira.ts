// Jira connector - Atlassian REST API v3. Basic auth via email:token.
// Credential JSON: {"site":"https://acme.atlassian.net","email":"you@x.com","token":"<api token>"}
const JIRA_TIMEOUT_MS = 12_000;

type JiraArgs = Record<string, unknown>;

type JiraCredential = {
  site: string;
  email: string;
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

export function parseJiraCredential(credential: string): JiraCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Jira credential is empty");
  const parsed = JSON.parse(trimmed);
  const site = String(parsed.site ?? "").trim();
  const email = String(parsed.email ?? "").trim();
  const token = String(parsed.token ?? "").trim();
  if (!site) throw new Error("Jira credential must include site");
  if (!email) throw new Error("Jira credential must include email");
  if (!token) throw new Error("Jira credential must include token");
  return { site: site.replace(/\/+$/, ""), email, token };
}

function jiraHeaders(cred: JiraCredential, json = false) {
  const encoded = Buffer.from(`${cred.email}:${cred.token}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchJira(
  base: string,
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JIRA_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[jira] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[jira] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[jira] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${JIRA_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Jira request timed out after ${JIRA_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  cred: JiraCredential,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const base = `${cred.site}/rest/api/3`;
  const hasBody = body !== undefined;
  const init: RequestInit = { method, headers: jiraHeaders(cred, hasBody) };
  if (hasBody) init.body = JSON.stringify(body);
  const r = await fetchJira(base, path, init, { tool, ...logContext });
  const j: any = await readJson(r);
  if (!r.ok) throw new Error(`Jira ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function idArg(args: JiraArgs, snake: string) {
  const value = String(args[snake] ?? args[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

function queryString(args: JiraArgs, mapping: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [argKey, paramKey] of Object.entries(mapping)) {
    const value = args[argKey] ?? args[argKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(paramKey, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Build a minimal Atlassian Document Format (ADF) doc from plain text. */
function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

export async function callJiraTool(tool: string, args: JiraArgs, credential: string) {
  const cred = parseJiraCredential(credential);

  if (tool === "jira/search") {
    const jql = String(args.jql ?? "").trim();
    if (!jql) throw new Error("jql is required");
    const qs = queryString(args, { jql: "jql", max_results: "maxResults", fields: "fields" });
    return { structuredContent: await request(cred, "GET", `/search/jql${qs}`, undefined, tool) };
  }

  if (tool === "jira/get_issue") {
    const issueKey = idArg(args, "issue_key");
    return {
      structuredContent: await request(cred, "GET", `/issue/${encodeURIComponent(issueKey)}`, undefined, tool, { issueKey }),
    };
  }

  if (tool === "jira/create_issue") {
    const projectKey = idArg(args, "project_key");
    const summary = String(args.summary ?? "").trim();
    if (!summary) throw new Error("summary is required");
    const issueType = String(args.issue_type ?? args.issueType ?? "").trim();
    if (!issueType) throw new Error("issue_type is required");
    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      summary,
      issuetype: { name: issueType },
    };
    const description = String(args.description ?? "").trim();
    if (description) fields.description = adf(description);
    return {
      structuredContent: await request(cred, "POST", "/issue", { fields }, tool, { projectKey }),
    };
  }

  if (tool === "jira/update_issue") {
    const issueKey = idArg(args, "issue_key");
    const fields = args.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error("fields must be an object");
    }
    await request(cred, "PUT", `/issue/${encodeURIComponent(issueKey)}`, { fields }, tool, { issueKey });
    return { structuredContent: { updated: true, issue_key: issueKey } };
  }

  if (tool === "jira/add_comment") {
    const issueKey = idArg(args, "issue_key");
    const bodyText = String(args.body ?? "").trim();
    if (!bodyText) throw new Error("body is required");
    return {
      structuredContent: await request(
        cred,
        "POST",
        `/issue/${encodeURIComponent(issueKey)}/comment`,
        { body: adf(bodyText) },
        tool,
        { issueKey },
      ),
    };
  }

  if (tool === "jira/list_projects") {
    const qs = queryString(args, { max_results: "maxResults", query: "query" });
    return { structuredContent: await request(cred, "GET", `/project/search${qs}`, undefined, tool) };
  }

  if (tool === "jira/transition_issue") {
    const issueKey = idArg(args, "issue_key");
    const transitionId = String(args.transition_id ?? args.transitionId ?? "").trim();
    if (!transitionId) throw new Error("transition_id is required");
    await request(
      cred,
      "POST",
      `/issue/${encodeURIComponent(issueKey)}/transitions`,
      { transition: { id: transitionId } },
      tool,
      { issueKey, transitionId },
    );
    return { structuredContent: { transitioned: true, issue_key: issueKey, transition_id: transitionId } };
  }

  throw new Error(`Unknown Jira tool: ${tool}`);
}
