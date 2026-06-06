// MCP JSON-RPC gateway with auth + policy + dispatch
// Phase 2: implements real tool dispatch for notion/* and github/*
// Phase 3: scope-based policy enforcement
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { checkPolicy, connectionsForAgent } from "./policy.js";
import { PROVIDERS } from "./connectors/registry.js";
import { callNotionTool } from "./connectors/notion.js";
import { callGitHubTool } from "./connectors/github.js";
import { callGoogleGscTool } from "./connectors/google_gsc.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";

export const mcpApp = new Hono();

const TOKEN_REFRESH_TIMEOUT_MS = 8_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MCP_SESSION_TTL_MS = 60 * 60 * 1000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

type McpSession = {
  agentId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

const mcpSessions = new Map<string, McpSession>();

function cleanupExpiredMcpSessions() {
  const now = Date.now();
  for (const [id, session] of mcpSessions) {
    if (session.expiresAt <= now) mcpSessions.delete(id);
  }
}

function configuredMcpScope(c: any): string {
  return String(c.req.header("x-gentity-scope") ?? c.req.header("x-gentity-tenant") ?? "").trim();
}

function publicToolName(canonicalName: string): string {
  return canonicalName === "ping" ? canonicalName : canonicalName.replace("/", "_");
}

function canonicalToolName(name: unknown): string {
  const raw = String(name ?? "");
  if (raw === "ping") return raw;
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.tools.includes(raw)) return raw;
    const matched = provider.tools.find((tool) => publicToolName(tool) === raw);
    if (matched) return matched;
  }
  return raw;
}

function toolSpecificInputProperties(toolName: string): Record<string, any> {
  if (toolName === "notion/get_page") {
    return {
      page_id: { type: "string", description: "Notion page ID." },
      include_children: { type: "boolean", description: "When true, include the page's first-level block children." },
    };
  }
  if (toolName === "notion/query_db") {
    return {
      database_id: { type: "string", description: "Notion database ID." },
      filter: { type: "object", description: "Optional Notion database query filter object." },
      sorts: { type: "array", items: { type: "object" }, description: "Optional Notion database query sorts array." },
      page_size: { type: "number", minimum: 1, maximum: 100, description: "Rows to return, max 100." },
      start_cursor: { type: "string", description: "Pagination cursor returned as next_cursor." },
      slug: { type: "string", description: "Optional shortcut filter for a slug rich_text property." },
      slug_property: { type: "string", description: "Slug property name, default Slug." },
    };
  }
  if (toolName === "notion/create_page") {
    return {
      parent: { type: "object", description: "Notion page parent object." },
      properties: { type: "object", description: "Raw Notion properties object." },
    };
  }
  if (toolName === "notion/update_page") {
    return {
      page_id: { type: "string", description: "Notion page ID." },
      properties: { type: "object", description: "Raw Notion properties object to PATCH onto the page." },
      archived: { type: "boolean", description: "Archive or restore the page." },
      icon: { type: "object", description: "Optional raw Notion icon object." },
      cover: { type: "object", description: "Optional raw Notion cover object." },
    };
  }
  if (toolName === "notion/append_blocks") {
    return {
      page_id: { type: "string", description: "Page ID to append children to. Alias for parent_block_id." },
      parent_block_id: { type: "string", description: "Block ID whose children should receive appended blocks." },
      after: { type: "string", description: "Optional sibling block ID to insert after." },
      children: { type: "array", items: { type: "object" }, description: "Raw Notion block children array." },
    };
  }
  if (toolName === "notion/update_blocks") {
    return {
      operations: {
        type: "array",
        maxItems: 25,
        items: {
          type: "object",
          properties: {
            block_id: { type: "string" },
            patch: { type: "object", description: "Raw Notion block PATCH body." },
            archived: { type: "boolean", description: "Shortcut to archive or restore a block." },
          },
          required: ["block_id"],
        },
        description: "Batch of block PATCH operations. Each item needs block_id and either patch or archived.",
      },
    };
  }
  if (toolName === "notion/update_page_status") {
    return {
      page_id: { type: "string", description: "Notion page ID." },
      status: { type: "string", description: "Status property name." },
      status_name: { type: "string", description: "New status option name, default Done." },
    };
  }
  return {};
}

function requiredToolSpecificArgs(toolName: string): string[] {
  if (toolName === "notion/get_page") return ["page_id"];
  if (toolName === "notion/query_db") return ["database_id"];
  if (toolName === "notion/create_page") return ["parent", "properties"];
  if (toolName === "notion/update_page") return ["page_id"];
  if (toolName === "notion/append_blocks") return ["children"];
  if (toolName === "notion/update_blocks") return ["operations"];
  if (toolName === "notion/update_page_status") return ["page_id", "status"];
  return [];
}

/**
 * Tools advertised via tools/list, scoped to the calling agent.
 * - `ping` is always available (liveness, no policy).
 * - When `connections` is null (unauthenticated request), only `ping` is returned.
 * - Otherwise only tools that have an enabled, policy-usable connection are listed.
 */
function buildToolList(connections: Awaited<ReturnType<typeof connectionsForAgent>> | null) {
  const tools: any[] = [{ name: "ping", description: "Liveness check", inputSchema: { type: "object", properties: {} } }];
  if (!connections) return tools;

  const scopesByTool = new Map<string, Set<string>>();
  const authTypesByTool = new Map<string, Set<string>>();
  const connectionIdsByTool = new Map<string, Set<string>>();
  for (const conn of connections) {
    for (const tool of conn.tools) {
      if (!scopesByTool.has(tool)) scopesByTool.set(tool, new Set());
      if (!authTypesByTool.has(tool)) authTypesByTool.set(tool, new Set());
      if (!connectionIdsByTool.has(tool)) connectionIdsByTool.set(tool, new Set());
      scopesByTool.get(tool)!.add(conn.scope);
      authTypesByTool.get(tool)!.add(conn.authType);
      connectionIdsByTool.get(tool)!.add(conn.id);
    }
  }

  for (const p of Object.values(PROVIDERS)) {
    if (p.implemented === false) continue;
    for (const toolName of p.tools) {
      const scopes = Array.from(scopesByTool.get(toolName) ?? []).sort();
      if (!scopes.length) continue;
      const authTypes = Array.from(authTypesByTool.get(toolName) ?? []).sort();
      const connectionIds = Array.from(connectionIdsByTool.get(toolName) ?? []).sort();
      tools.push({
        name: publicToolName(toolName),
        description: `${p.label}: ${toolName.split("/")[1]?.replace(/_/g, " ")}`,
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: scopes, description: "Tenant scope. Use one of the scopes exposed for this agent token." },
            auth_type: { type: "string", enum: authTypes, description: "Optional auth type disambiguator." },
            connection_id: { type: "string", enum: connectionIds, description: "Optional connection id disambiguator." },
            ...toolSpecificInputProperties(toolName),
          },
          required: ["scope", ...requiredToolSpecificArgs(toolName)],
        },
      });
    }
  }
  return tools;
}

/** Resolve agent from Authorization: Bearer gn_agt_* */
async function resolveAgent(authHeader: string | null): Promise<{ id: string; name: string; enabled: boolean } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (!token.startsWith("gn_agt_")) return null;

  // Look up by token hash (hashedToken is unique but not the @id, so use findFirst)
  const crypto = await import("node:crypto");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const agent = await prisma.agent.findFirst({ where: { hashedToken: tokenHash } });
  if (!agent || !agent.enabled) return null;
  if (agent.expiresAt && agent.expiresAt < new Date()) return null;
  return { id: agent.id, name: agent.name, enabled: agent.enabled };
}

function prepareMcpSession(c: any, agent: { id: string } | null) {
  if (!agent) return { ok: true as const };

  cleanupExpiredMcpSessions();
  const now = Date.now();
  const requestedId = c.req.header("mcp-session-id") ?? c.req.header("Mcp-Session-Id") ?? "";
  if (requestedId) {
    const existing = mcpSessions.get(requestedId);
    if (!existing || existing.expiresAt <= now) {
      return { ok: false as const, status: 404, message: "Mcp-Session-Id is unknown or expired; retry without the header to create a new session" };
    }
    if (existing.agentId !== agent.id) {
      return { ok: false as const, status: 409, message: "Mcp-Session-Id belongs to a different agent token" };
    }
    existing.lastSeenAt = now;
    existing.expiresAt = now + MCP_SESSION_TTL_MS;
    c.header("Mcp-Session-Id", requestedId);
    return { ok: true as const };
  }

  const sessionId = randomUUID();
  mcpSessions.set(sessionId, {
    agentId: agent.id,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + MCP_SESSION_TTL_MS,
  });
  c.header("Mcp-Session-Id", sessionId);
  return { ok: true as const };
}

async function refreshOAuthToken(provider: string, refreshToken: string) {
  const providerDef = PROVIDERS[provider];
  if (!providerDef?.oauthTokenUrl) throw new Error(`OAuth refresh is not configured for provider: ${provider}`);

  const envPrefix = provider.toUpperCase();
  const legacyAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_ID", "GENTITY_GITHUB_CLIENT_ID"],
  };
  const legacySecretAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_SECRET", "GENTITY_GITHUB_CLIENT_SECRET"],
  };
  const clientId = process.env[`${envPrefix}_CLIENT_ID`]
    || (legacyAliases[provider] || []).map((k) => process.env[k]).find(Boolean);
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`]
    || (legacySecretAliases[provider] || []).map((k) => process.env[k]).find(Boolean);
  if (!clientId || !clientSecret) {
    throw new Error(`${provider} OAuth refresh credentials missing: set ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);
  try {
    const resp = await fetch(providerDef.oauthTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!resp.ok || json.error || !json.access_token) {
      throw new Error(`${provider} OAuth refresh failed: ${resp.status} ${JSON.stringify(json).slice(0, 500)}`);
    }
    return json as { access_token: string; expires_in?: number; refresh_token?: string };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`${provider} OAuth refresh timed out after ${TOKEN_REFRESH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function credentialForConnection(conn: {
  id: string;
  provider: string;
  encryptedCredential: string;
  authType: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}) {
  const currentToken = decrypt(conn.encryptedCredential);
  if (!conn.refreshToken || !conn.accessTokenExpiresAt) return currentToken;
  if (conn.accessTokenExpiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) return currentToken;

  console.log("[oauth] refreshing access token", {
    provider: conn.provider,
    connectionId: conn.id,
    expiresAt: conn.accessTokenExpiresAt.toISOString(),
  });
  const refreshed = await refreshOAuthToken(conn.provider, decrypt(conn.refreshToken));
  await prisma.connection.update({
    where: { id: conn.id },
    data: {
      encryptedCredential: encrypt(refreshed.access_token),
      accessTokenExpiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
      ...(await credentialMetadataForStorage(conn.provider, conn.authType, refreshed.access_token)),
      ...(refreshed.refresh_token ? { refreshToken: encrypt(refreshed.refresh_token) } : {}),
    },
  });
  return refreshed.access_token;
}

mcpApp.post("/", async (c) => {
  const started = Date.now();
  const auth = c.req.header("authorization") ?? null;
  const agent = await resolveAgent(auth);
  const configuredScope = configuredMcpScope(c);
  c.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  const session = prepareMcpSession(c, agent);
  if (!session.ok) {
    return c.json({
      jsonrpc: "2.0", id: null,
      error: { code: -32002, message: session.message },
    }, session.status as any);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const { method, params, id } = body ?? {};

  // --- MCP handshake ---
  // Remote MCP clients (Claude Desktop via mcp-remote, Claude Code, Codex) call
  // initialize before listing/calling tools. Keep this lightweight; auth still
  // gates tenant-specific tools and calls below.
  if (method === "initialize") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: String(params?.protocolVersion ?? MCP_PROTOCOL_VERSION),
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "gentity-auth",
          version: "0.1.0",
        },
      },
    });
  }

  if (method === "notifications/initialized") {
    return c.body(null, 204);
  }

  if (method === "ping") {
    return c.json({ jsonrpc: "2.0", id, result: {} });
  }

  // --- tools/list: scoped to the calling agent's permitted tools ---
  // Unauthenticated requests only see `ping`; an authenticated agent only sees
  // tools backed by enabled connections it can actually call.
  if (method === "tools/list") {
    const connections = agent
      ? (await connectionsForAgent(agent.id)).filter((conn) => !configuredScope || conn.scope === configuredScope)
      : null;
    return c.json({ jsonrpc: "2.0", id, result: { tools: buildToolList(connections) } });
  }

  // --- connections/list: requires auth; returns the exact (provider, scope)
  // pairs the agent can use, so it never has to guess `scope` for tools/call. ---
  if (method === "connections/list") {
    if (!agent) {
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32001, message: "authentication required: pass 'Authorization: Bearer gn_agt_...'" },
      }, 401);
    }
    const connections = (await connectionsForAgent(agent.id)).filter((conn) => !configuredScope || conn.scope === configuredScope);
    return c.json({ jsonrpc: "2.0", id, result: { connections } });
  }

  // --- tools/call: requires auth ---
  if (method === "tools/call") {
    if (!agent) {
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32001, message: "authentication required: pass 'Authorization: Bearer gn_agt_...'" },
      }, 401);
    }

    const requestedToolName = String(params?.name ?? "");
    const toolName = canonicalToolName(requestedToolName);
    const args = params?.arguments ?? {};
    const requestedScope = args.scope === undefined || args.scope === null ? "" : String(args.scope);
    const scope = requestedScope || configuredScope;
    const authType = args.auth_type !== undefined ? String(args.auth_type) : (args.authType !== undefined ? String(args.authType) : "");
    const connectionId = args.connection_id !== undefined ? String(args.connection_id) : (args.connectionId !== undefined ? String(args.connectionId) : "");

    await prisma.agent.update({
      where: { id: agent.id },
      data: { lastUsedAt: new Date() },
    });

    // 1) Special case: ping
    if (toolName === "ping") {
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: "system",
          tool: "ping",
          status: "ok",
          durationMs: Date.now() - started,
        },
      });
      return c.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `pong from ${agent.name}` }] } });
    }

    if (configuredScope && requestedScope && requestedScope !== configuredScope) {
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: toolName.includes("/") ? toolName.split("/", 1)[0] : "unknown",
          tool: String(toolName ?? ""),
          scope: requestedScope,
          status: "denied",
          errorMessage: `MCP server is locked to scope=${configuredScope}`,
          requestArgs: JSON.stringify(args).slice(0, 4000),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        },
      });
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32010, message: `policy denied: ${requestedToolName} (MCP server is locked to scope=${configuredScope})` },
      }, 403);
    }

    // 2) Policy check
    const decision = await checkPolicy({ agentId: agent.id, tool: toolName, scope, authType, connectionId });
    if (!decision.allowed) {
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "denied",
          errorMessage: decision.reason,
          requestArgs: JSON.stringify(args).slice(0, 4000),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        },
      });
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32010, message: `policy denied: ${toolName} (${decision.reason})` },
      }, 403);
    }

    // 3) Look up connection, decrypt credential
    const conn = await prisma.connection.findUnique({ where: { id: decision.connectionId! } });
    if (!conn) {
      return c.json({ jsonrpc: "2.0", id, error: { code: -32011, message: "connection vanished" } }, 500);
    }
    const token = await credentialForConnection(conn);

    // 4) Dispatch to provider-specific tool
    try {
      let result: any;
      if (decision.provider === "notion") {
        result = await callNotionTool(toolName, args, token);
      } else if (decision.provider === "github") {
        result = await callGitHubTool(toolName, args, token);
      } else if (decision.provider === "google_gsc") {
        result = await callGoogleGscTool(toolName, args, token);
      } else {
        throw new Error(`no dispatcher for provider: ${decision.provider}`);
      }

      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "ok",
          responseSummary: JSON.stringify({ authType: decision.authType, connectionId: conn.id, result }).slice(0, 500),
          requestArgs: JSON.stringify(args).slice(0, 4000),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        },
      });

      return c.json({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result.structuredContent ?? result).slice(0, 8000) }],
          structuredContent: result.structuredContent,
          isError: false,
        },
      });
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "error",
          errorMessage: errMsg.slice(0, 2000),
          requestArgs: JSON.stringify(args).slice(0, 4000),
          durationMs: Date.now() - started,
        },
      });
      return c.json({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
        },
      });
    }
  }

  return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
});
