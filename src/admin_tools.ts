// grantry self-management (control-plane) tools.
//
// These let an agent manage grantry itself over the same MCP endpoint —
// create tenants, mint sibling agents, register PAT connections, and move
// connection grants — so an "agent that creates agents" can be built without
// touching the dashboard.
//
// Gate: Agent.selfManage, a dashboard-only toggle. Every operation is bounded
// to the calling agent's workspace (or owner when workspaceless), the same
// boundary checkPolicy uses. Privilege escalation is closed by construction:
// none of these tools can create, modify, rotate, or grant to a selfManage
// agent — a manager is always human-minted.
//
// Tokens (gn_agt_) are returned exactly once in the tool result and must never
// appear in audit logs; callers of callAdminTool audit `summary`, not payload.
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { encrypt } from "./crypto.js";
import { ensureTenant } from "./tenants.js";
import { getProviderForWorkspace } from "./connectors/registry.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";
import { connectionCredentialData } from "./provider_credentials.js";

export const ADMIN_TOOLS = [
  "grantry/list_agents",
  "grantry/list_tenants",
  "grantry/list_connections",
  "grantry/create_tenant",
  "grantry/create_agent",
  "grantry/update_agent",
  "grantry/rotate_agent_token",
  "grantry/grant_scope",
  "grantry/revoke_scope",
  "grantry/create_connection",
] as const;

export type AdminToolName = (typeof ADMIN_TOOLS)[number];

export function isAdminTool(name: string): name is AdminToolName {
  return (ADMIN_TOOLS as readonly string[]).includes(name);
}

// Tools that mutate state. Reads are safe to advertise as such for clients
// that surface annotations.
export const ADMIN_WRITE_TOOLS = new Set<string>([
  "grantry/create_tenant",
  "grantry/create_agent",
  "grantry/update_agent",
  "grantry/rotate_agent_token",
  "grantry/grant_scope",
  "grantry/revoke_scope",
  "grantry/create_connection",
]);

export type AdminContext = {
  agentId: string;
  ownerId: string;
  workspaceId: string | null;
};

export type AdminToolResult = {
  /** Tool payload returned to the caller (may contain a one-time token). */
  payload: Record<string, unknown>;
  /** Token-free one-liner for the audit log's responseSummary. */
  summary: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function boundaryWhere(ctx: AdminContext): Record<string, unknown> {
  return ctx.workspaceId ? { workspaceId: ctx.workspaceId } : { ownerId: ctx.ownerId };
}

function mintAgentToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `gn_agt_${randomUUID().replace(/-/g, "")}`;
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    tokenPrefix: token.slice(0, 16),
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`'${key}' is required`);
  return v.trim();
}

/**
 * Resolve a target agent inside the caller's boundary. selfManage targets are
 * off-limits to every mutating admin tool (anti-escalation / anti-lockout).
 */
async function targetAgent(ctx: AdminContext, agentId: string) {
  const target = await prisma.agent.findFirst({
    where: { id: agentId, ...boundaryWhere(ctx) },
  });
  if (!target) throw new Error(`agent not found in your workspace: ${agentId}`);
  if (target.selfManage) {
    throw new Error("selfManage agents can only be managed from the dashboard");
  }
  return target;
}

async function agentScopes(agentId: string): Promise<string[]> {
  const grants = await prisma.agentConnectionGrant.findMany({
    where: { agentId },
    select: { connection: { select: { scope: true } } },
  });
  return Array.from(new Set(grants.map((g) => g.connection.scope))).sort();
}

export async function callAdminTool(
  toolName: AdminToolName,
  args: Record<string, unknown>,
  ctx: AdminContext,
): Promise<AdminToolResult> {
  if (toolName === "grantry/list_agents") {
    const agents = await prisma.agent.findMany({
      where: boundaryWhere(ctx),
      orderBy: { createdAt: "asc" },
      select: {
        id: true, name: true, description: true, enabled: true,
        fullScopeManager: true, selfManage: true, tokenPrefix: true,
        expiresAt: true, lastUsedAt: true, createdAt: true,
        connectionGrants: { select: { connection: { select: { scope: true } } } },
      },
    });
    const payload = {
      agents: agents.map((a) => ({
        agent_id: a.id,
        name: a.name,
        charter: a.description,
        enabled: a.enabled,
        full_scope_manager: a.fullScopeManager,
        self_manage: a.selfManage,
        token_prefix: a.tokenPrefix,
        expires_at: a.expiresAt?.toISOString() ?? null,
        last_used_at: a.lastUsedAt?.toISOString() ?? null,
        created_at: a.createdAt.toISOString(),
        scopes: Array.from(new Set(a.connectionGrants.map((g) => g.connection.scope))).sort(),
      })),
      count: agents.length,
    };
    return { payload, summary: `listed ${agents.length} agent(s)` };
  }

  if (toolName === "grantry/list_tenants") {
    const tenants = await prisma.tenant.findMany({
      where: boundaryWhere(ctx),
      orderBy: { slug: "asc" },
      select: {
        slug: true, displayName: true, description: true, createdAt: true,
        connections: { select: { provider: true, enabled: true } },
      },
    });
    const payload = {
      tenants: tenants.map((t) => ({
        scope: t.slug,
        display_name: t.displayName,
        description: t.description,
        created_at: t.createdAt.toISOString(),
        providers: Array.from(new Set(t.connections.filter((c) => c.enabled).map((c) => c.provider))).sort(),
        connection_count: t.connections.length,
      })),
      count: tenants.length,
    };
    return { payload, summary: `listed ${tenants.length} tenant(s)` };
  }

  if (toolName === "grantry/list_connections") {
    const scope = args.scope == null ? "" : String(args.scope).trim();
    const connections = await prisma.connection.findMany({
      where: { ...boundaryWhere(ctx), ...(scope ? { scope } : {}) },
      orderBy: [{ scope: "asc" }, { provider: "asc" }],
      select: {
        id: true, provider: true, authType: true, scope: true, label: true,
        enabled: true, credentialValidatedAt: true, createdAt: true,
      },
    });
    const payload = {
      connections: connections.map((cn) => ({
        connection_id: cn.id,
        provider: cn.provider,
        auth_type: cn.authType,
        scope: cn.scope,
        label: cn.label,
        enabled: cn.enabled,
        credential_validated_at: cn.credentialValidatedAt?.toISOString() ?? null,
        created_at: cn.createdAt.toISOString(),
      })),
      count: connections.length,
    };
    return { payload, summary: `listed ${connections.length} connection(s)${scope ? ` for scope ${scope}` : ""}` };
  }

  if (toolName === "grantry/create_tenant") {
    const slug = requireString(args, "scope").toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error(`invalid scope: must match ${SLUG_RE} (lowercase letters, digits, '-', '_')`);
    const displayName = args.display_name == null ? undefined : String(args.display_name).trim() || undefined;
    const existing = await prisma.tenant.findUnique({
      where: { ownerId_slug: { ownerId: ctx.ownerId, slug } },
      select: { id: true },
    });
    const tenant = await ensureTenant(ctx.ownerId, slug, displayName, ctx.workspaceId);
    const payload = {
      scope: tenant.slug,
      display_name: tenant.displayName,
      created: !existing,
      note: existing
        ? "tenant already existed; left untouched"
        : "tenant created. Add a connection with grantry_create_connection (PAT providers) or the dashboard (OAuth providers), then grant it with grantry_grant_scope.",
    };
    return { payload, summary: `${existing ? "found existing" : "created"} tenant ${tenant.slug}` };
  }

  if (toolName === "grantry/create_agent") {
    const name = requireString(args, "name");
    if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid name: must match ${AGENT_NAME_RE}`);
    const charter = args.charter == null ? null : String(args.charter).trim() || null;
    const scopes = Array.isArray(args.scopes) ? args.scopes.map((s) => String(s)) : [];
    if ((args as any).full_scope_manager || (args as any).self_manage || (args as any).selfManage) {
      throw new Error("full_scope_manager / self_manage agents can only be created from the dashboard");
    }
    const existing = await prisma.agent.findUnique({ where: { name }, select: { id: true } });
    if (existing) throw new Error(`agent name already exists: ${name} — pick another name`);

    const { token, tokenHash, tokenPrefix } = mintAgentToken();
    const agentRow = await prisma.agent.create({
      data: {
        name,
        description: charter,
        hashedToken: tokenHash,
        tokenPrefix,
        ownerId: ctx.ownerId,
        workspaceId: ctx.workspaceId,
      },
    });
    let granted = 0;
    if (scopes.length) {
      const conns = await prisma.connection.findMany({
        where: { ...boundaryWhere(ctx), enabled: true, scope: { in: scopes } },
        select: { id: true },
      });
      if (conns.length) {
        const res = await prisma.agentConnectionGrant.createMany({
          data: conns.map((cn) => ({ agentId: agentRow.id, connectionId: cn.id })),
          skipDuplicates: true,
        });
        granted = res.count;
      }
    }
    const grantedScopes = await agentScopes(agentRow.id);
    const missing = scopes.filter((s) => !grantedScopes.includes(s));
    const payload = {
      agent_id: agentRow.id,
      name: agentRow.name,
      charter: agentRow.description,
      token,
      token_note: "shown once — store it now; only its hash is persisted",
      granted_connections: granted,
      scopes: grantedScopes,
      ...(missing.length ? { scopes_without_connections: missing.sort() } : {}),
    };
    return { payload, summary: `created agent ${agentRow.name} (${granted} connection grant(s), scopes: ${grantedScopes.join(", ") || "none"})` };
  }

  if (toolName === "grantry/update_agent") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    if (target.id === ctx.agentId) throw new Error("cannot update yourself");
    const data: Record<string, unknown> = {};
    if (typeof args.enabled === "boolean") data.enabled = args.enabled;
    if (args.charter !== undefined) {
      data.description = args.charter == null ? null : String(args.charter).trim() || null;
    }
    if ((args as any).self_manage !== undefined || (args as any).full_scope_manager !== undefined) {
      throw new Error("self_manage / full_scope_manager can only be changed from the dashboard");
    }
    if (!Object.keys(data).length) throw new Error("nothing to update: pass 'enabled' and/or 'charter'");
    const updated = await prisma.agent.update({ where: { id: target.id }, data });
    const payload = {
      agent_id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      charter: updated.description,
    };
    return { payload, summary: `updated agent ${updated.name} (${Object.keys(data).join(", ")})` };
  }

  if (toolName === "grantry/rotate_agent_token") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    if (target.id === ctx.agentId) throw new Error("cannot rotate your own token (you would lose access mid-flight); rotate from the dashboard");
    const { token, tokenHash, tokenPrefix } = mintAgentToken();
    await prisma.agent.update({
      where: { id: target.id },
      data: { hashedToken: tokenHash, tokenPrefix, lastUsedAt: null },
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      token,
      token_note: "shown once — the previous token is now invalid",
    };
    return { payload, summary: `rotated token for agent ${target.name}` };
  }

  if (toolName === "grantry/grant_scope") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const scope = requireString(args, "scope");
    const conns = await prisma.connection.findMany({
      where: { ...boundaryWhere(ctx), enabled: true, scope },
      select: { id: true },
    });
    if (!conns.length) throw new Error(`no enabled connection at scope ${scope} — create one first (grantry_create_connection or dashboard)`);
    const res = await prisma.agentConnectionGrant.createMany({
      data: conns.map((cn) => ({ agentId: target.id, connectionId: cn.id })),
      skipDuplicates: true,
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      scope,
      granted_connections: res.count,
      already_granted: conns.length - res.count,
      scopes: await agentScopes(target.id),
    };
    return { payload, summary: `granted scope ${scope} to agent ${target.name} (${res.count} new grant(s))` };
  }

  if (toolName === "grantry/revoke_scope") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const scope = requireString(args, "scope");
    const res = await prisma.agentConnectionGrant.deleteMany({
      where: { agentId: target.id, connection: { scope, ...boundaryWhere(ctx) } },
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      scope,
      revoked_connections: res.count,
      scopes: await agentScopes(target.id),
    };
    return { payload, summary: `revoked scope ${scope} from agent ${target.name} (${res.count} grant(s) removed)` };
  }

  if (toolName === "grantry/create_connection") {
    const provider = requireString(args, "provider").toLowerCase();
    const scope = requireString(args, "scope").toLowerCase();
    const credential = requireString(args, "credential");
    if (!SLUG_RE.test(scope)) throw new Error(`invalid scope: must match ${SLUG_RE}`);
    const providerDef = await getProviderForWorkspace(provider, ctx.workspaceId);
    if (!providerDef || providerDef.implemented === false) throw new Error(`provider not implemented: ${provider}`);
    const authType = args.auth_type ? String(args.auth_type) : (providerDef.authTypes.find((t) => t !== "oauth") ?? "pat");
    if (authType === "oauth") {
      throw new Error(`oauth connections require a browser consent flow — use the dashboard (/tenants/${scope}/edit). Pass a PAT/API key here instead${providerDef.tokenUrl ? ` (get one at ${providerDef.tokenUrl})` : ""}.`);
    }
    if (!providerDef.authTypes.includes(authType as any)) {
      throw new Error(`provider ${provider} does not support auth_type=${authType} (supported: ${providerDef.authTypes.join(", ")})`);
    }
    const label = args.label ? String(args.label).trim() : `${provider}-${scope}-${authType}`;

    const tenant = await ensureTenant(ctx.ownerId, scope, undefined, ctx.workspaceId);
    // Multiple connections per (provider, scope) are allowed since 0f90feb,
    // but an agent-driven create refuses duplicates unless it labels them —
    // unlabeled duplicates just make every call ambiguous (checkPolicy would
    // demand connection_id).
    const existing = await prisma.connection.findFirst({
      where: { ...boundaryWhere(ctx), provider, scope, authType, enabled: true },
      select: { id: true, label: true },
    });
    if (existing && !args.label) {
      throw new Error(`a ${provider} (${authType}) connection already exists at scope ${scope} (connection_id=${existing.id}, label=${existing.label}) — pass a distinct 'label' to add another, or rotate the existing one from the dashboard`);
    }
    const credentialMeta = await credentialMetadataForStorage(provider, authType, credential);
    const conn = await prisma.connection.create({
      data: {
        provider,
        authType,
        label,
        scope,
        tenantId: tenant.id,
        ownerId: ctx.ownerId,
        workspaceId: tenant.workspaceId ?? ctx.workspaceId,
        encryptedCredential: encrypt(credential),
        ...connectionCredentialData(credentialMeta),
      },
    });
    const payload = {
      connection_id: conn.id,
      provider: conn.provider,
      auth_type: conn.authType,
      scope: conn.scope,
      label: conn.label,
      credential_status: (credentialMeta as any)?.status ?? "unknown",
      note: "credential stored encrypted. Grant it to an agent with grantry_grant_scope.",
    };
    return { payload, summary: `created ${provider} (${authType}) connection at scope ${scope}` };
  }

  throw new Error(`Unknown admin tool: ${toolName}`);
}

// ---------- tools/list metadata ----------

export function adminToolDescriptor(toolName: AdminToolName): { description: string; properties: Record<string, unknown>; required: string[] } {
  switch (toolName) {
    case "grantry/list_agents":
      return {
        description: "grantry admin: list every agent in your workspace with its charter, status, and granted scopes. Requires the selfManage flag on your agent.",
        properties: {},
        required: [],
      };
    case "grantry/list_tenants":
      return {
        description: "grantry admin: list every tenant (scope) in your workspace with its connected providers.",
        properties: {},
        required: [],
      };
    case "grantry/list_connections":
      return {
        description: "grantry admin: list connections in your workspace (id, provider, scope, enabled). Credentials are never returned.",
        properties: {
          scope: { type: "string", description: "Optional: only list connections at this scope." },
        },
        required: [],
      };
    case "grantry/create_tenant":
      return {
        description: "grantry admin: create a tenant (scope). Idempotent — an existing tenant is returned untouched. The scope string is the immutable wire key agents pass in tools/call.",
        properties: {
          scope: { type: "string", description: "Immutable tenant slug, e.g. 'acme-prod' (lowercase letters, digits, '-', '_')." },
          display_name: { type: "string", description: "Optional human-readable name (renameable later). Defaults to the scope." },
        },
        required: ["scope"],
      };
    case "grantry/create_agent":
      return {
        description: "grantry admin: create a new agent and mint its gn_agt_ token (returned once — store it immediately). Optionally grant it every enabled connection at the given scopes. Cannot create manager (full_scope_manager / self_manage) agents.",
        properties: {
          name: { type: "string", description: "Globally unique agent name, e.g. 'acme-support-bot'." },
          charter: { type: "string", description: "What this agent is for, in plain language. Surfaced to grantry_find_agent for routing." },
          scopes: { type: "array", items: { type: "string" }, description: "Tenant scopes to grant: the agent gets every enabled connection at each scope. Omit to create with no grants." },
        },
        required: ["name"],
      };
    case "grantry/update_agent":
      return {
        description: "grantry admin: enable/disable an agent or update its charter. Cannot target selfManage agents or yourself.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          enabled: { type: "boolean", description: "Enable or disable the agent's token." },
          charter: { type: "string", description: "New charter text (empty string clears it)." },
        },
        required: ["agent_id"],
      };
    case "grantry/rotate_agent_token":
      return {
        description: "grantry admin: rotate an agent's token. The new gn_agt_ token is returned once; the old token stops working immediately. Cannot target selfManage agents or yourself.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
        },
        required: ["agent_id"],
      };
    case "grantry/grant_scope":
      return {
        description: "grantry admin: grant an agent every enabled connection at a scope. Idempotent. Cannot target selfManage agents.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          scope: { type: "string", description: "Tenant scope whose connections to grant." },
        },
        required: ["agent_id", "scope"],
      };
    case "grantry/revoke_scope":
      return {
        description: "grantry admin: remove an agent's connection grants at a scope. Cannot target selfManage agents.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          scope: { type: "string", description: "Tenant scope whose grants to remove." },
        },
        required: ["agent_id", "scope"],
      };
    case "grantry/create_connection":
      return {
        description: "grantry admin: register a PAT/API-key credential as a connection at a scope (creates the tenant if needed). The credential is encrypted at rest and never returned. OAuth providers must be connected via the dashboard.",
        properties: {
          provider: { type: "string", description: "Provider key, e.g. 'github', 'notion', 'attio' (see grantry_get_providers)." },
          scope: { type: "string", description: "Tenant scope for the connection. Tenant is created if missing." },
          credential: { type: "string", description: "The PAT / API key / token. Redacted from audit logs." },
          auth_type: { type: "string", description: "Optional auth type. Defaults to the provider's non-OAuth auth type (usually 'pat')." },
          label: { type: "string", description: "Optional display label." },
        },
        required: ["provider", "scope", "credential"],
      };
  }
}
