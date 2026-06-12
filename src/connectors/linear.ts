// Linear connector - Personal API key via Authorization: <key> (no "Bearer" prefix).
// Targets the Linear GraphQL API.
const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_TIMEOUT_MS = 12_000;

type LinearArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(apiKey: string) {
  return {
    Authorization: apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function fetchLinear(
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINEAR_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[linear] request", { ...logContext });
    const response = await fetch(LINEAR_API, {
      ...init,
      signal: controller.signal,
    });
    console.log("[linear] response", {
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[linear] failed", {
      durationMs: Date.now() - started,
      error: aborted
        ? `timeout after ${LINEAR_TIMEOUT_MS}ms`
        : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted)
      throw new Error(`Linear request timed out after ${LINEAR_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function graphql(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  tool: string,
) {
  const r = await fetchLinear(
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ query, variables }),
    },
    { tool },
  );
  const j: any = await readJsonResponse(r);
  if (!r.ok)
    throw new Error(
      `Linear ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`,
    );
  if (j.errors && j.errors.length > 0)
    throw new Error(
      `Linear ${tool} failed: ${JSON.stringify(j.errors).slice(0, 1000)}`,
    );
  return j.data;
}

function strArg(args: LinearArgs, snake: string, aliases: string[] = []) {
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

export async function callLinearTool(
  tool: string,
  args: LinearArgs,
  credential: string,
) {
  if (tool === "linear/get_me") {
    const data = await graphql(
      credential,
      `query { viewer { id name email } }`,
      {},
      tool,
    );
    return { structuredContent: data.viewer };
  }

  if (tool === "linear/list_teams") {
    const data = await graphql(
      credential,
      `query { teams { nodes { id name key } } }`,
      {},
      tool,
    );
    return { structuredContent: { teams: data.teams.nodes } };
  }

  if (tool === "linear/list_issues") {
    const first =
      typeof args.first === "number"
        ? args.first
        : parseInt(String(args.first ?? "50"), 10) || 50;
    const data = await graphql(
      credential,
      `query ListIssues($first: Int) {
        issues(first: $first) {
          nodes {
            id
            identifier
            title
            state { name }
            assignee { name }
          }
        }
      }`,
      { first },
      tool,
    );
    return { structuredContent: { issues: data.issues.nodes } };
  }

  if (tool === "linear/get_issue") {
    const id = strArg(args, "id");
    const data = await graphql(
      credential,
      `query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          state { name }
          assignee { name }
          team { id name }
          priority
          url
          createdAt
          updatedAt
        }
      }`,
      { id },
      tool,
    );
    return { structuredContent: data.issue };
  }

  if (tool === "linear/search_issues") {
    const term = strArg(args, "query", ["term"]);
    const data = await graphql(
      credential,
      `query SearchIssues($term: String!) {
        searchIssues(term: $term) {
          nodes {
            id
            identifier
            title
            state { name }
            assignee { name }
          }
        }
      }`,
      { term },
      tool,
    );
    return { structuredContent: { issues: data.searchIssues.nodes } };
  }

  if (tool === "linear/create_issue") {
    const teamId = strArg(args, "team_id", ["teamId"]);
    const title = strArg(args, "title");
    const description =
      typeof args.description === "string" ? args.description : undefined;
    const input: Record<string, unknown> = { teamId, title };
    if (description) input.description = description;
    const data = await graphql(
      credential,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      { input },
      tool,
    );
    return { structuredContent: data.issueCreate };
  }

  if (tool === "linear/update_issue") {
    const id = strArg(args, "id");
    // Accept either a pre-built input object or individual fields
    let input: Record<string, unknown>;
    if (args.input && typeof args.input === "object" && !Array.isArray(args.input)) {
      input = args.input as Record<string, unknown>;
    } else {
      input = {};
      if (args.title) input.title = args.title;
      if (args.description) input.description = args.description;
      const stateId = args.stateId ?? args.state_id;
      if (stateId) input.stateId = stateId;
    }
    const data = await graphql(
      credential,
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      { id, input },
      tool,
    );
    return { structuredContent: data.issueUpdate };
  }

  throw new Error(`Unknown Linear tool: ${tool}`);
}
