// Policy enforcement: check if an agent can call a (tool, scope) pair
// given the role bindings the agent has.
import { prisma } from "./db.js";
import { getProvider } from "./connectors/registry.js";

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  /** The connection that will be used (if allowed) */
  connectionId?: string;
  authType?: string;
  provider: string;
  tool: string;
  scope: string;
};

/**
 * Check if `agentId` can call `tool` with optional `scope`.
 * An agent is allowed if at least one of its bound roles:
 *   - has the tool in allowedTools
 *   - has scope in allowedScopes (or allowedScopes is empty = any scope)
 * And a matching Connection exists for the (provider, scope) pair.
 */
export async function checkPolicy(args: {
  agentId: string;
  tool: string;
  scope: string;
  authType?: string;
  connectionId?: string;
}): Promise<PolicyDecision> {
  const { agentId, tool, scope } = args;
  const authType = args.authType ? String(args.authType) : "";
  const requestedConnectionId = args.connectionId ? String(args.connectionId) : "";
  const [provider, toolName] = tool.includes("/") ? tool.split("/", 2) : ["", tool];
  const providerDef = getProvider(provider);
  if (!providerDef || providerDef.implemented === false) {
    return { allowed: false, reason: `provider not implemented: ${provider || "<unknown>"}`, provider, tool, scope };
  }

  // 1) Find the agent's roles
  const agentRoles = await prisma.agentRole.findMany({
    where: { agentId },
    include: { role: true, agent: true },
  });

  if (!agentRoles.length) {
    return { allowed: false, reason: "agent has no roles bound", provider, tool, scope };
  }
  const ownerId = agentRoles[0].agent.ownerId;

  // 2) Check if any role allows this (tool, scope) pair
  const matchingRoles = agentRoles.filter((ar) => {
    const r = ar.role;
    let allowedTools: string[] = [];
    let allowedScopes: string[] = [];
    try { allowedTools = JSON.parse(r.allowedTools); } catch { allowedTools = []; }
    try { allowedScopes = JSON.parse(r.allowedScopes); } catch { allowedScopes = []; }
    if (!allowedTools.includes(tool)) return false;
    if (allowedScopes.length > 0 && !allowedScopes.includes(scope)) return false;
    return true;
  });

  if (!matchingRoles.length) {
    return {
      allowed: false,
      reason: `no role permits (tool=${tool}, scope=${scope || "<empty>"})`,
      provider, tool, scope,
    };
  }

  // 3) Find a matching connection. If authType or connectionId is supplied,
  // honor it. Otherwise keep old behavior only when the match is unambiguous.
  const connections = requestedConnectionId
    ? await prisma.connection.findMany({
        where: { id: requestedConnectionId, provider, scope, ownerId, enabled: true },
      })
    : await prisma.connection.findMany({
        where: {
          provider,
          scope,
          ownerId,
          enabled: true,
          ...(authType ? { authType } : {}),
        },
        orderBy: { createdAt: "desc" },
      });

  if (!connections.length) {
    return {
      allowed: false,
      reason: `no enabled connection for this agent owner (provider=${provider}, scope=${scope || "<empty>"}${authType ? `, authType=${authType}` : ""}${requestedConnectionId ? `, connectionId=${requestedConnectionId}` : ""})`,
      provider, tool, scope,
    };
  }
  if (!authType && !requestedConnectionId && connections.length > 1) {
    return {
      allowed: false,
      reason: `ambiguous enabled connections for (provider=${provider}, scope=${scope || "<empty>"}); pass auth_type or connection_id`,
      provider, tool, scope,
    };
  }
  const connection = connections[0];

  return {
    allowed: true,
    reason: `role=${matchingRoles[0].role.name}, connection=${connection.id.slice(0, 8)}, authType=${connection.authType}`,
    connectionId: connection.id,
    authType: connection.authType,
    provider, tool, scope,
  };
}

/**
 * Return the set of tool names an agent is permitted to call, aggregated
 * across all of its bound roles' allowedTools. Used by tools/list to scope
 * the advertised tools to what the agent can actually invoke.
 *
 * Note: this is scope-agnostic (it does not check allowedScopes or whether a
 * matching Connection currently exists) — those are enforced at tools/call.
 */
export async function allowedToolsForAgent(agentId: string): Promise<Set<string>> {
  const agentRoles = await prisma.agentRole.findMany({
    where: { agentId },
    include: { role: true },
  });

  const allowed = new Set<string>();
  for (const ar of agentRoles) {
    let tools: string[] = [];
    try { tools = JSON.parse(ar.role.allowedTools); } catch { tools = []; }
    for (const t of tools) {
      const provider = t.includes("/") ? t.split("/", 1)[0] : "";
      const providerDef = getProvider(provider);
      if (!providerDef || providerDef.implemented === false) continue;
      allowed.add(t);
    }
  }
  return allowed;
}

export type AgentConnection = {
  id: string;
  provider: string;
  authType: string;
  /** The exact scope string to pass in tools/call arguments. */
  scope: string;
  label: string;
  /** Tools the agent can actually call against this (provider, scope). */
  tools: string[];
};

/**
 * Enumerate the (provider, scope) connections the calling agent can actually
 * use, mirroring checkPolicy's three conditions:
 *   - the agent has a bound role,
 *   - a role lists a tool for the connection's provider, with the connection's
 *     scope permitted (allowedScopes empty = any scope),
 *   - the connection is enabled.
 *
 * This lets an agent discover the exact `scope` strings to pass to tools/call
 * from its token alone, instead of brute-forcing scopes and collecting -32010s.
 */
export async function connectionsForAgent(agentId: string): Promise<AgentConnection[]> {
  const agentRoles = await prisma.agentRole.findMany({
    where: { agentId },
    include: { role: true, agent: true },
  });
  if (!agentRoles.length) return [];
  const ownerId = agentRoles[0].agent.ownerId;

  const roles = agentRoles.map((ar) => {
    let allowedTools: string[] = [];
    let allowedScopes: string[] = [];
    try { allowedTools = JSON.parse(ar.role.allowedTools); } catch { allowedTools = []; }
    try { allowedScopes = JSON.parse(ar.role.allowedScopes); } catch { allowedScopes = []; }
    return { allowedTools, allowedScopes };
  });

  // Providers the agent can touch at all (derived from allowedTools).
  const providers = new Set<string>();
  for (const r of roles) {
    for (const t of r.allowedTools) {
      const p = t.includes("/") ? t.split("/", 1)[0] : "";
      const providerDef = getProvider(p);
      if (p && providerDef && providerDef.implemented !== false) providers.add(p);
    }
  }
  if (!providers.size) return [];

  const conns = await prisma.connection.findMany({
    where: { provider: { in: Array.from(providers) }, ownerId, enabled: true },
    select: { id: true, provider: true, authType: true, scope: true, label: true },
    orderBy: [{ scope: "asc" }, { provider: "asc" }, { authType: "asc" }],
  });

  const out: AgentConnection[] = [];
  const seen = new Set<string>();
  for (const cn of conns) {
    const key = `${cn.provider} ${cn.scope} ${cn.authType}`;
    if (seen.has(key)) continue; // collapse duplicate (provider, scope) connections
    seen.add(key);

    // Tools callable against this exact (provider, scope) per the agent's roles.
    const tools = new Set<string>();
    for (const r of roles) {
      const scopeOk = r.allowedScopes.length === 0 || r.allowedScopes.includes(cn.scope);
      if (!scopeOk) continue;
      for (const t of r.allowedTools) {
        if (t.startsWith(`${cn.provider}/`)) tools.add(t);
      }
    }
    if (!tools.size) continue;

    out.push({ id: cn.id, provider: cn.provider, authType: cn.authType, scope: cn.scope, label: cn.label, tools: Array.from(tools).sort() });
  }
  return out;
}
