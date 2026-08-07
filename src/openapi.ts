// OpenAPI description of grantry's machine-facing HTTP surface, rendered as an
// API reference by Scalar at GET /docs (see server.ts).
//
// Scope on purpose: only the endpoints an integrator calls from code — the MCP
// gateway, its OAuth discovery documents, the two read-only JSON console
// endpoints, and /health. The dashboard's HTML form POSTs are a UI, not an API,
// and are deliberately absent; the per-provider tools reachable *through* the
// MCP gateway are discovered at runtime via tools/list, not enumerated here.

const PUBLIC_ORIGIN =
  process.env.PUBLIC_MCP_ORIGIN ?? "https://api.grantry.ai";
const DASHBOARD_ORIGIN =
  process.env.PUBLIC_DASHBOARD_ORIGIN ?? "https://app.grantry.ai";

const jsonRpcRequest = {
  type: "object",
  required: ["jsonrpc", "method"],
  properties: {
    jsonrpc: { type: "string", const: "2.0" },
    id: {
      description: "Omit for notifications.",
      oneOf: [{ type: "string" }, { type: "number" }],
    },
    method: {
      type: "string",
      description:
        "MCP method. Supported: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.",
      examples: ["tools/list", "tools/call"],
    },
    params: { type: "object", additionalProperties: true },
  },
} as const;

const jsonRpcResponse = {
  type: "object",
  required: ["jsonrpc"],
  properties: {
    jsonrpc: { type: "string", const: "2.0" },
    id: { oneOf: [{ type: "string" }, { type: "number" }] },
    result: {
      type: "object",
      additionalProperties: true,
      description:
        "For `tools/call`: `content` (text, truncated to 8000 chars), `structuredContent` (the full provider payload — read this one), and `isError`.",
    },
    error: {
      type: "object",
      properties: {
        code: { type: "integer" },
        message: { type: "string" },
      },
    },
  },
} as const;

const mcpPost = (summary: string, description: string, parameters: unknown[] = []) => ({
  post: {
    tags: ["MCP gateway"],
    summary,
    description,
    security: [{ agentToken: [] }],
    parameters,
    requestBody: {
      required: true,
      content: { "application/json": { schema: jsonRpcRequest } },
    },
    responses: {
      "200": {
        description:
          "JSON-RPC response. Tool-level failures come back as `result.isError = true` with HTTP 200; only transport and auth problems use non-200 status codes.",
        content: { "application/json": { schema: jsonRpcResponse } },
      },
      "401": {
        description:
          "Missing, unknown, or disabled bearer token. Carries a `WWW-Authenticate` header pointing at the protected-resource metadata.",
      },
    },
  },
});

const wsParam = {
  name: "ws",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Workspace slug. Locks every call in this session to that workspace.",
};

const scopeParam = {
  name: "scope",
  in: "path",
  required: true,
  schema: { type: "string" },
  description:
    "Tenant scope slug (e.g. `grantry-dev`). Locks the session to connections granted under that scope.",
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "grantry API",
    version: "0.1.0",
    summary: "OAuth credential broker for AI agents, exposed over MCP.",
    description: [
      "grantry holds encrypted SaaS credentials and lends them to agents as MCP tools.",
      "An agent never sees a raw token: it presents its own grantry token, grantry decides",
      "which connection applies, and calls the provider on its behalf.",
      "",
      "**The API is the MCP gateway.** Everything an integration does — listing tools,",
      "calling a provider, administering grantry itself — is a JSON-RPC call to `/mcp`.",
      "The endpoints below describe that transport plus the discovery documents remote MCP",
      "clients fetch before connecting. The dashboard at",
      `[${DASHBOARD_ORIGIN}](${DASHBOARD_ORIGIN}) is a browser UI and is not part of this API.`,
      "",
      "### Authentication",
      "",
      "Send an agent token as `Authorization: Bearer gn_agt_…`. Tokens are issued per agent",
      "in the dashboard and can be rotated or revoked there. Admin tooling uses the same",
      "transport with a `gn_adm_…` key on a connection whose provider is `grantry`.",
      "",
      "Interactive MCP clients (claude.ai, Claude Desktop) instead run the OAuth flow",
      "advertised by the `.well-known` documents and never handle a static token.",
      "",
      "### Discovering tools",
      "",
      "Tool names are not fixed: they depend on which connections the calling agent has been",
      "granted. Call `tools/list` first — that response, not this document, is the catalogue.",
    ].join("\n"),
    contact: { name: "grantry", url: DASHBOARD_ORIGIN },
  },
  servers: [
    { url: PUBLIC_ORIGIN, description: "Production" },
    { url: "http://localhost:8080", description: "Local development" },
  ],
  tags: [
    {
      name: "MCP gateway",
      description:
        "JSON-RPC 2.0 over HTTP POST. The path variant you pick decides how much of the session is pinned up front — a bare `/mcp` can reach every connection the token is granted, while `/mcp/w/{ws}/s/{scope}` is pinned to one workspace and one scope.",
    },
    {
      name: "Discovery",
      description:
        "RFC 8414 / RFC 9728 metadata. Spec-compliant MCP clients fetch these before the authorize popup and reject a mismatch between the advertised `resource` and the URL they were handed.",
    },
    {
      name: "Console",
      description:
        "Read-only JSON views of your own workspaces, authenticated by the dashboard session cookie (not by an agent token). Intended for internal tooling and orchestration.",
    },
    { name: "Service", description: "Liveness." },
  ],
  components: {
    securitySchemes: {
      agentToken: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "gn_agt_…",
        description:
          "Agent token issued in the dashboard. One token = one agent = one set of connection grants.",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
        description: "Dashboard login session. Set by the browser sign-in flow.",
      },
    },
  },
  paths: {
    "/mcp": mcpPost(
      "JSON-RPC endpoint",
      "Unpinned entry point: the agent token alone decides what is reachable.",
    ),
    "/mcp/w/{ws}": mcpPost(
      "Workspace-locked endpoint",
      "Same transport, pinned to one workspace. Distinct URLs matter for claude.ai and Claude Desktop, which reject registering the same URL twice — give each connector its own variant.",
      [wsParam],
    ),
    "/mcp/s/{scope}": mcpPost(
      "Scope-locked endpoint",
      "Pinned to a single tenant scope.",
      [scopeParam],
    ),
    "/mcp/w/{ws}/s/{scope}": mcpPost(
      "Workspace- and scope-locked endpoint",
      "Pinned to both.",
      [wsParam, scopeParam],
    ),
    "/mcp/u": mcpPost(
      "User-mode endpoint",
      "Acts as a person rather than as one agent: the caller may act through any agent they are allowed to use, choosing per call with `agent_id` (omit it when exactly one agent qualifies). The `/u/w/{ws}`, `/u/s/{scope}`, and `/u/w/{ws}/s/{scope}` variants pin the same way as above.",
    ),
    "/.well-known/oauth-authorization-server": {
      get: {
        tags: ["Discovery"],
        summary: "Authorization server metadata (RFC 8414)",
        description: "Advertises the authorize, token, and registration endpoints.",
        security: [],
        responses: {
          "200": {
            description: "Metadata document.",
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
        },
      },
    },
    "/.well-known/oauth-protected-resource": {
      get: {
        tags: ["Discovery"],
        summary: "Protected resource metadata (RFC 9728)",
        security: [],
        responses: {
          "200": {
            description: "Metadata document.",
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
        },
      },
    },
    "/.well-known/oauth-protected-resource/mcp/{path}": {
      get: {
        tags: ["Discovery"],
        summary: "Protected resource metadata for one MCP variant",
        description:
          "Path-insertion form. For the resource `/mcp/w/acme`, a client fetches `/.well-known/oauth-protected-resource/mcp/w/acme` and checks that the returned `resource` matches exactly — so this route echoes the requested variant back rather than the root URL.",
        security: [],
        parameters: [
          {
            name: "path",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "The MCP suffix, e.g. `w/acme` or `s/grantry-dev`.",
          },
        ],
        responses: {
          "200": {
            description: "Metadata document whose `resource` is the requested MCP URL.",
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
        },
      },
    },
    "/api/scopes": {
      get: {
        tags: ["Console"],
        summary: "Tenants, connections, and agents you can see",
        description:
          "Everything the signed-in user may administer, including each agent's granted connections and the tool names those grants resolve to. Capability facts only — no credentials.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": {
            description: "Inventory for the current session.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string" } } },
                    tenants: { type: "array", items: { type: "object", additionalProperties: true } },
                    scopes: { type: "array", items: { type: "string" } },
                    connections: { type: "array", items: { type: "object", additionalProperties: true } },
                    agents: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          tokenPrefix: { type: "string" },
                          enabled: { type: "boolean" },
                          grantedConnections: { type: "array", items: { type: "object", additionalProperties: true } },
                          accessibleTools: { type: "array", items: { type: "string" } },
                          accessibleScopes: { type: "array", items: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "No dashboard session." },
        },
      },
    },
    "/api/capabilities": {
      get: {
        tags: ["Console"],
        summary: "Which agents can call this tool",
        description:
          "Inverse lookup for orchestration: given a tool, rank the agents able to call it across every workspace you belong to.",
        security: [{ sessionCookie: [] }],
        parameters: [
          {
            name: "tool",
            in: "query",
            required: true,
            schema: { type: "string" },
            example: "railway/graphql",
            description: "`provider/tool`.",
          },
          {
            name: "scope",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Restrict candidates to one tenant scope.",
          },
        ],
        responses: {
          "200": {
            description: "Candidates, highest confidence first.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tool: { type: "string" },
                    scope: { type: ["string", "null"] },
                    candidates: { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
          "400": { description: "`tool` missing or not in `provider/tool` form." },
          "401": { description: "No dashboard session." },
        },
      },
    },
    "/health": {
      get: {
        tags: ["Service"],
        summary: "Liveness probe",
        security: [],
        responses: {
          "200": {
            description: "Service is up.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    service: { type: "string" },
                    version: { type: "string" },
                    ts: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
