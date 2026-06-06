// Policy enforcement: check if an agent can call a (tool, scope) pair
// given the role bindings the agent has.
import { prisma } from "./db.js";
import { getProvider } from "./connectors/registry.js";

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  /** The connection that will be used (if allowed) */
  connectionId?: string;
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
}): Promise<PolicyDecision> {
  const { agentId, tool, scope } = args;
  const [provider, toolName] = tool.includes("/") ? tool.split("/", 2) : ["", tool];

  // 1) Find the agent's roles
  const agentRoles = await prisma.agentRole.findMany({
    where: { agentId },
    include: { role: true, agent: true },
  });

  if (!agentRoles.length) {
    return { allowed: false, reason: "agent has no roles bound", provider, tool, scope };
  }

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

  // 3) Find a matching connection: (provider, scope) where enabled=true
  const connection = await prisma.connection.findFirst({
    where: { provider, scope, enabled: true },
    orderBy: { createdAt: "desc" },
  });

  if (!connection) {
    return {
      allowed: false,
      reason: `no enabled connection for (provider=${provider}, scope=${scope || "<empty>"})`,
      provider, tool, scope,
    };
  }

  return {
    allowed: true,
    reason: `role=${matchingRoles[0].role.name}, connection=${connection.id.slice(0, 8)}`,
    connectionId: connection.id,
    provider, tool, scope,
  };
}
