// Railway connector - GraphQL Public API.
const RAILWAY_API = "https://backboard.railway.app/graphql/v2";
const RAILWAY_TIMEOUT_MS = 12_000;

type RailwayArgs = Record<string, unknown>;
type RailwayTokenType = "project" | "account" | "workspace" | "oauth";

type RailwayCredential = {
  token: string;
  tokenType: RailwayTokenType;
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

export function parseRailwayCredential(credential: string): RailwayCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Railway token is empty");
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const token = String(parsed.token ?? parsed.api_token ?? parsed.apiToken ?? "").trim();
    if (!token) throw new Error("Railway credential JSON must include token");
    const tokenType = String(parsed.token_type ?? parsed.tokenType ?? "project").trim().toLowerCase();
    if (!["project", "account", "workspace", "oauth"].includes(tokenType)) {
      throw new Error("Railway token_type must be project, account, workspace, or oauth");
    }
    return { token, tokenType: tokenType as RailwayTokenType };
  }
  return { token: trimmed, tokenType: "project" };
}

function headers(credential: RailwayCredential) {
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (credential.tokenType === "project") {
    h["Project-Access-Token"] = credential.token;
  } else {
    h.Authorization = `Bearer ${credential.token}`;
  }
  return h;
}

async function graphql(credentialText: string, query: string, variables: Record<string, unknown> | undefined, operationName: string | undefined, tool: string) {
  const credential = parseRailwayCredential(credentialText);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RAILWAY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[railway] request", { tool, tokenType: credential.tokenType, operationName });
    const response = await fetch(RAILWAY_API, {
      method: "POST",
      headers: headers(credential),
      body: JSON.stringify({
        query,
        variables: variables ?? {},
        ...(operationName ? { operationName } : {}),
      }),
      signal: controller.signal,
    });
    console.log("[railway] response", {
      tool,
      tokenType: credential.tokenType,
      status: response.status,
      durationMs: Date.now() - started,
      operationName,
    });
    const body: any = await readJsonResponse(response);
    if (!response.ok) throw new Error(`Railway ${tool} failed: ${response.status} ${JSON.stringify(body).slice(0, 1000)}`);
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new Error(`Railway ${tool} GraphQL error: ${JSON.stringify(body.errors).slice(0, 1000)}`);
    }
    return body;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[railway] failed", {
      tool,
      durationMs: Date.now() - started,
      operationName,
      error: aborted ? `timeout after ${RAILWAY_TIMEOUT_MS}ms` : String(e?.message ?? e),
    });
    if (aborted) throw new Error(`Railway request timed out after ${RAILWAY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function queryArg(args: RailwayArgs) {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query is required");
  return query;
}

function variablesArg(args: RailwayArgs) {
  const variables = args.variables;
  if (variables === undefined || variables === null) return {};
  if (typeof variables !== "object" || Array.isArray(variables)) throw new Error("variables must be an object");
  return variables as Record<string, unknown>;
}

function operationNameArg(args: RailwayArgs) {
  const op = String(args.operation_name ?? args.operationName ?? "").trim();
  return op || undefined;
}

export async function callRailwayTool(tool: string, args: RailwayArgs, credential: string) {
  if (tool === "railway/graphql") {
    const result = await graphql(credential, queryArg(args), variablesArg(args), operationNameArg(args), tool);
    return { structuredContent: result };
  }

  if (tool === "railway/introspect_schema") {
    const result = await graphql(credential, `
      query IntrospectRailwaySchema {
        __schema {
          queryType { name }
          mutationType { name }
          types {
            name
            kind
            fields {
              name
              args {
                name
                type { kind name ofType { kind name ofType { kind name } } }
              }
              type { kind name ofType { kind name ofType { kind name } } }
            }
          }
        }
      }
    `, {}, "IntrospectRailwaySchema", tool);
    return { structuredContent: result };
  }

  if (tool === "railway/project_token_info") {
    const result = await graphql(credential, `
      query ProjectTokenInfo {
        projectToken {
          projectId
          environmentId
        }
      }
    `, {}, "ProjectTokenInfo", tool);
    return { structuredContent: result };
  }

  throw new Error(`Unknown Railway tool: ${tool}`);
}
