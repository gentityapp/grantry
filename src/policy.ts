// Policy enforcement: Agent -> Connection grants are Grantry's source of truth.
// Full-scope managers are explicit owner/workspace-bounded exceptions that
// resolve against every enabled tenant connection in their boundary.
import { prisma } from "./db.js";
import { getProvider, getProviderForWorkspace, PROVIDERS } from "./connectors/registry.js";

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

export type AgentConnection = {
  id: string;
  provider: string;
  authType: string;
  /** The exact scope string to pass in tools/call arguments. */
  scope: string;
  label: string;
  /** Tools the agent can call against this provider connection. */
  tools: string[];
};

function toolProvider(tool: string): string {
  return tool.includes("/") ? tool.split("/", 2)[0] : "";
}

function compatibleProviderKeys(provider: string): string[] {
  if (provider === "railway") return ["railway", "railway_api"];
  return [provider];
}

async function providerTools(provider: string, workspaceId?: string | null): Promise<string[]> {
  const providerDef = await getProviderForWorkspace(provider, workspaceId);
  if (!providerDef || providerDef.implemented === false) return [];
  return providerDef.tools;
}

async function toolImplemented(provider: string, tool: string, workspaceId?: string | null): Promise<boolean> {
  return (await providerTools(provider, workspaceId)).includes(tool);
}

/**
 * Check if `agentId` can call `tool` on a connection/scope.
 *
 * Grantry gates only its own boundary:
 *   - agent exists and is enabled
 *   - provider tool is implemented
 *   - connection exists, is enabled, and matches provider/scope/authType/id
 *   - agent and connection share owner/workspace boundary
 *   - AgentConnectionGrant(agentId, connectionId) exists, unless the agent is
 *     an explicit full-scope manager
 *
 * Provider-side ACLs are intentionally not pre-modeled here. A 401/403 from
 * the provider is surfaced as a provider error by the caller, not as policy.
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
  const provider = toolProvider(tool);

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, ownerId: true, workspaceId: true, enabled: true, fullScopeManager: true, expiresAt: true },
  });
  if (!agent || !agent.enabled) return { allowed: false, reason: "agent not found or disabled", provider, tool, scope };
  if (agent.expiresAt && agent.expiresAt < new Date()) return { allowed: false, reason: "agent token expired", provider, tool, scope };
  const providerDef = await getProviderForWorkspace(provider, agent.workspaceId);
  if (!providerDef || providerDef.implemented === false) {
    return { allowed: false, reason: `provider not implemented: ${provider || "<unknown>"}`, provider, tool, scope };
  }
  if (!providerDef.tools.includes(tool)) {
    return { allowed: false, reason: `tool not implemented for provider: ${tool}`, provider, tool, scope };
  }

  const providerKeys = compatibleProviderKeys(provider);
  const where: any = {
    provider: { in: providerKeys },
    scope,
    enabled: true,
    ...(requestedConnectionId ? { id: requestedConnectionId } : {}),
    ...(authType ? { authType } : {}),
  };
  if (!agent.fullScopeManager) where.agentGrants = { some: { agentId } };
  if (agent.workspaceId) where.workspaceId = agent.workspaceId;
  else where.ownerId = agent.ownerId;

  const connections = await prisma.connection.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: { id: true, authType: true, ownerId: true, workspaceId: true },
  });

  if (!connections.length) {
    return {
      allowed: false,
      reason: `no ${agent.fullScopeManager ? "enabled" : "granted enabled"} connection for this agent (provider=${providerKeys.join("|")}, scope=${scope || "<empty>"}${authType ? `, authType=${authType}` : ""}${requestedConnectionId ? `, connectionId=${requestedConnectionId}` : ""})`,
      provider, tool, scope,
    };
  }
  if (!authType && !requestedConnectionId && connections.length > 1) {
    return {
      allowed: false,
      reason: `ambiguous granted connections for (provider=${providerKeys.join("|")}, scope=${scope || "<empty>"}); pass auth_type or connection_id`,
      provider, tool, scope,
    };
  }
  const connection = connections[0];
  return {
    allowed: true,
    reason: `grant=${agent.fullScopeManager ? "full_scope_manager" : "agent_connection"}, connection=${connection.id.slice(0, 8)}, authType=${connection.authType}`,
    connectionId: connection.id,
    authType: connection.authType,
    provider, tool, scope,
  };
}

export async function allowedToolsForAgent(agentId: string): Promise<Set<string>> {
  const conns = await connectionsForAgent(agentId);
  return new Set(conns.flatMap((conn) => conn.tools));
}

/**
 * Enumerate the exact granted connections the calling agent can use.
 */
export async function connectionsForAgent(agentId: string): Promise<AgentConnection[]> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, ownerId: true, workspaceId: true, enabled: true, fullScopeManager: true, expiresAt: true },
  });
  if (!agent || !agent.enabled) return [];
  if (agent.expiresAt && agent.expiresAt < new Date()) return [];

  const where: any = {
    enabled: true,
    ...(agent.fullScopeManager ? { scope: { not: "" } } : { agentGrants: { some: { agentId } } }),
  };
  if (agent.workspaceId) where.workspaceId = agent.workspaceId;
  else where.ownerId = agent.ownerId;

  const conns = await prisma.connection.findMany({
    where,
    select: { id: true, provider: true, authType: true, scope: true, label: true },
    orderBy: [{ scope: "asc" }, { provider: "asc" }, { authType: "asc" }],
  });

  const out: AgentConnection[] = [];
  for (const cn of conns) {
    const tools = await providerTools(cn.provider, agent.workspaceId);
    if (!tools.length) continue;
    out.push({ ...cn, tools });
  }
  return out;
}

/**
 * Tools the calling agent cannot run directly, but could run via a same-owner
 * peer agent that has a grant to a live connection.
 */
export async function delegatableToolsForAgent(agentId: string): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  const self = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, ownerId: true, workspaceId: true },
  });
  if (!self) return result;

  const own = await connectionsForAgent(agentId);
  const ownPairs = new Set<string>();
  for (const c of own) for (const t of c.tools) ownPairs.add(`${t}\0${c.scope}`);

  const peerWhere: any = { enabled: true, id: { not: agentId } };
  if (self.workspaceId) peerWhere.workspaceId = self.workspaceId;
  else peerWhere.ownerId = self.ownerId;

  const peers = await prisma.agent.findMany({
    where: peerWhere,
    select: {
      connectionGrants: {
        select: {
          connection: {
            select: { provider: true, scope: true, enabled: true, ownerId: true, workspaceId: true },
          },
        },
      },
    },
  });

  for (const peer of peers) {
    for (const grant of peer.connectionGrants) {
      const cn = grant.connection;
      if (!cn.enabled) continue;
      if (self.workspaceId ? cn.workspaceId !== self.workspaceId : cn.ownerId !== self.ownerId) continue;
      for (const tool of await providerTools(cn.provider, self.workspaceId)) {
        if (ownPairs.has(`${tool}\0${cn.scope}`)) continue;
        if (!result.has(tool)) result.set(tool, new Set());
        result.get(tool)!.add(cn.scope);
      }
    }
  }
  return result;
}

// ---------- Capability discovery & routing (docs/agent-orchestration.md) ----------

/**
 * Accept either the canonical "provider/tool" form or the public "provider_tool"
 * form (as advertised in tools/list) and return the canonical name.
 */
export function normalizeToolName(name: unknown): string {
  const raw = String(name ?? "");
  if (!raw || raw.includes("/")) return raw;
  for (const p of Object.values(PROVIDERS)) {
    const matched = p.tools.find((t) => t.replace("/", "_") === raw);
    if (matched) return matched;
  }
  const customMatch = raw.match(/^([a-z0-9_-]+)_(request|check_connection|list_capabilities)$/);
  if (customMatch) return `${customMatch[1]}/${customMatch[2]}`;
  return raw;
}

export type CapableAgentMatch = {
  agentId: string;
  name: string;
  charter: string | null;
  grants: string[];
  scopes: string[];
  provider: string;
  tool: string;
  connection: { authType: string; scope: string; enabled: boolean; label: string; validatedAt: string | null };
  confidence: number;
};

/**
 * Inverse lookup: which agents have a grant to a live connection that can run
 * `tool` (optionally on `scope`) inside the caller's workspace/owner boundary?
 */
export async function findCapableAgents(args: {
  tool: string;
  scope?: string;
  workspaceId?: string | null;
  ownerId?: string;
  excludeAgentId?: string;
}): Promise<CapableAgentMatch[]> {
  const tool = normalizeToolName(args.tool);
  const scope = args.scope === undefined || args.scope === null || args.scope === "" ? undefined : String(args.scope);
  const provider = toolProvider(tool);
  if (!provider || !await toolImplemented(provider, tool, args.workspaceId)) return [];

  const agentWhere: any = { enabled: true };
  if (args.workspaceId) agentWhere.workspaceId = args.workspaceId;
  else if (args.ownerId) agentWhere.ownerId = args.ownerId;
  else return [];
  if (args.excludeAgentId) agentWhere.id = { not: args.excludeAgentId };

  const agents = await prisma.agent.findMany({
    where: agentWhere,
    select: {
      id: true,
      name: true,
      description: true,
      fullScopeManager: true,
      connectionGrants: {
        where: { connection: { provider: { in: compatibleProviderKeys(provider) }, enabled: true, ...(scope !== undefined ? { scope } : {}) } },
        select: {
          connection: {
            select: {
              ownerId: true,
              workspaceId: true,
              scope: true,
              authType: true,
              label: true,
              enabled: true,
              credentialValidatedAt: true,
            },
          },
        },
      },
    },
  });

  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const out: CapableAgentMatch[] = [];
  for (const a of agents) {
    const usable = a.fullScopeManager
      ? await prisma.connection.findMany({
          where: {
            provider: { in: compatibleProviderKeys(provider) },
            enabled: true,
            scope: { not: "" },
            ...(scope !== undefined ? { scope } : {}),
            ...(args.workspaceId ? { workspaceId: args.workspaceId } : { ownerId: args.ownerId }),
          },
          select: {
            ownerId: true,
            workspaceId: true,
            scope: true,
            authType: true,
            label: true,
            enabled: true,
            credentialValidatedAt: true,
          },
        })
      : a.connectionGrants
          .map((g) => g.connection)
          .filter((cn) => args.workspaceId ? cn.workspaceId === args.workspaceId : cn.ownerId === args.ownerId);
    if (!usable.length) continue;
    usable.sort((x, y) => (y.credentialValidatedAt?.getTime() ?? 0) - (x.credentialValidatedAt?.getTime() ?? 0));
    const best = usable[0];
    let confidence = 0.6;
    if (scope !== undefined) confidence += 0.15;
    if (best.credentialValidatedAt && Date.now() - best.credentialValidatedAt.getTime() < FRESH_MS) confidence += 0.15;
    if (usable.length === 1) confidence += 0.1;
    confidence = Math.min(1, Math.round(confidence * 100) / 100);

    out.push({
      agentId: a.id,
      name: a.name,
      charter: a.description ?? null,
      grants: [a.fullScopeManager ? "full-scope-manager" : "agent-connection"],
      scopes: Array.from(new Set(usable.map((cn) => cn.scope))).sort(),
      provider,
      tool,
      connection: {
        authType: best.authType,
        scope: best.scope,
        enabled: best.enabled,
        label: best.label,
        validatedAt: best.credentialValidatedAt?.toISOString() ?? null,
      },
      confidence,
    });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

/**
 * Best-effort translation of a natural-language task to candidate canonical
 * tool names, by keyword-matching against the provider catalog.
 */
export function guessToolsFromTask(task: string): string[] {
  const t = String(task ?? "").toLowerCase();
  if (!t.trim()) return [];
  const scored: { tool: string; score: number }[] = [];
  for (const p of Object.values(PROVIDERS)) {
    if (p.implemented === false) continue;
    const providerHit = t.includes(p.key.replace(/_/g, " ")) || t.includes(p.key) ||
      (p.label ? t.includes(p.label.toLowerCase()) : false);
    for (const tool of p.tools) {
      const action = tool.split("/")[1] ?? "";
      let score = providerHit ? 2 : 0;
      for (const w of action.split("_")) {
        if (w.length > 2 && t.includes(w)) score += 1;
      }
      if (score > 0) scored.push({ tool, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.tool);
}
