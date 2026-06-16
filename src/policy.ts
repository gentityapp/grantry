// Policy enforcement: check if an agent can call a (tool, scope) pair
// given the role bindings the agent has.
import { prisma } from "./db.js";
import { getProvider, PROVIDERS } from "./connectors/registry.js";

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
  return raw;
}

export type CapableAgentMatch = {
  agentId: string;
  name: string;
  /** Names of the agent's roles that grant this (tool, scope). */
  roles: string[];
  /** Scopes those roles permit for this tool; ["<any>"] if unrestricted. */
  scopes: string[];
  provider: string;
  tool: string;
  /** The enabled connection the agent would use. */
  connection: { authType: string; scope: string; enabled: boolean; label: string; validatedAt: string | null };
  /** 0..1 ranking score; see findCapableAgents for the signals. */
  confidence: number;
};

/**
 * Inverse lookup: which agents *can* call `tool` (optionally on `scope`)?
 * Mirrors checkPolicy's three conditions, but fans out across every agent in
 * the visibility boundary instead of checking one:
 *   - a bound role lists the tool, with the scope permitted (or unrestricted),
 *   - an enabled Connection exists for (provider, scope) under that agent's owner.
 *
 * Boundary: `workspaceId` (the management wall) when set, else `ownerId` for
 * legacy workspace-less agents. Returns only fully-capable agents (a live
 * connection exists), ranked by confidence. Never returns tokens.
 */
export async function findCapableAgents(args: {
  tool: string;
  scope?: string;
  workspaceId?: string | null;
  ownerId?: string;
  /** Omit the agent that just got denied, so the signpost points elsewhere. */
  excludeAgentId?: string;
}): Promise<CapableAgentMatch[]> {
  const tool = normalizeToolName(args.tool);
  const scope = args.scope === undefined || args.scope === null || args.scope === "" ? undefined : String(args.scope);
  const [provider] = tool.includes("/") ? tool.split("/", 2) : ["", tool];
  const providerDef = getProvider(provider);
  if (!provider || !providerDef || providerDef.implemented === false) return [];

  const agentWhere: any = { enabled: true };
  if (args.workspaceId) agentWhere.workspaceId = args.workspaceId;
  else if (args.ownerId) agentWhere.ownerId = args.ownerId;
  else return [];

  const agents = await prisma.agent.findMany({
    where: agentWhere,
    select: {
      id: true, name: true, ownerId: true,
      roles: { select: { role: { select: { name: true, allowedTools: true, allowedScopes: true } } } },
    },
  });

  // Per agent, find the roles that grant (tool, scope) and the scopes they allow.
  type Pre = { agentId: string; name: string; ownerId: string; roles: string[]; scopes: Set<string>; anyScope: boolean };
  const pre: Pre[] = [];
  for (const a of agents) {
    if (a.id === args.excludeAgentId) continue;
    const matchedRoles = new Set<string>();
    const scopes = new Set<string>();
    let anyScope = false;
    for (const ar of a.roles) {
      let allowedTools: string[] = [];
      let allowedScopes: string[] = [];
      try { allowedTools = JSON.parse(ar.role.allowedTools); } catch { allowedTools = []; }
      try { allowedScopes = JSON.parse(ar.role.allowedScopes); } catch { allowedScopes = []; }
      if (!allowedTools.includes(tool)) continue;
      if (allowedScopes.length === 0) {
        anyScope = true;
        matchedRoles.add(ar.role.name);
      } else {
        if (scope !== undefined && !allowedScopes.includes(scope)) continue;
        for (const s of allowedScopes) scopes.add(s);
        matchedRoles.add(ar.role.name);
      }
    }
    if (matchedRoles.size) {
      pre.push({ agentId: a.id, name: a.name, ownerId: a.ownerId, roles: Array.from(matchedRoles), scopes, anyScope });
    }
  }
  if (!pre.length) return [];

  // Enabled connections for the provider within the boundary.
  const connWhere: any = { provider, enabled: true };
  if (args.workspaceId) connWhere.workspaceId = args.workspaceId;
  else connWhere.ownerId = args.ownerId;
  if (scope !== undefined) connWhere.scope = scope;
  const conns = await prisma.connection.findMany({
    where: connWhere,
    select: { ownerId: true, scope: true, authType: true, label: true, enabled: true, credentialValidatedAt: true },
  });

  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const out: CapableAgentMatch[] = [];
  for (const p of pre) {
    const usable = conns.filter((cn) =>
      cn.ownerId === p.ownerId && (p.anyScope || p.scopes.has(cn.scope))
    );
    if (!usable.length) continue;
    usable.sort((x, y) => (y.credentialValidatedAt?.getTime() ?? 0) - (x.credentialValidatedAt?.getTime() ?? 0));
    const best = usable[0];

    let confidence = 0.5;
    // Explicit scope grant (vs allowedScopes=[] "any") is a stronger signal.
    if (!p.anyScope) confidence += 0.2;
    if (best.credentialValidatedAt && Date.now() - best.credentialValidatedAt.getTime() < FRESH_MS) confidence += 0.15;
    // Unambiguous: exactly one connection the agent could use.
    if (usable.length === 1) confidence += 0.1;
    confidence = Math.min(1, Math.round(confidence * 100) / 100);

    out.push({
      agentId: p.agentId,
      name: p.name,
      roles: p.roles,
      scopes: p.anyScope ? ["<any>"] : Array.from(p.scopes),
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
 * tool names, by keyword-matching against the provider catalog. Deterministic
 * (no LLM): the calling model can refine via grantry/route. See the design
 * doc's "NL translation home" open question.
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
