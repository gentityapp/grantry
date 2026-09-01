// Workspace-aware authorization helpers (docs/workspace-design.md).
// Who may connect as / act through which agent:
//  - the agent's owner (legacy personal model, still valid)
//  - users the agent is assigned to (AgentAssignment — the distribution path)
//  - owners/admins of the agent's workspace (management implies usage)
import { prisma } from "./db.js";

export type ConnectableAgent = {
  id: string;
  name: string;
  description: string | null;
  workspace: { slug: string; displayName: string } | null;
};

export async function connectableAgentsFor(userId: string): Promise<ConnectableAgent[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true, role: true },
  });
  const adminWs = memberships
    .filter((m) => m.role === "owner" || m.role === "admin")
    .map((m) => m.workspaceId);
  return prisma.agent.findMany({
    where: {
      enabled: true,
      OR: [
        { ownerId: userId },
        { assignments: { some: { userId } } },
        ...(adminWs.length ? [{ workspaceId: { in: adminWs } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      description: true,
      workspace: { select: { slug: true, displayName: true } },
    },
    orderBy: { name: "asc" },
  });
}

/** Workspace-scoped agent selection for personal MCP tokens and their UI. */
export async function connectableAgentsForWorkspace(userId: string, workspaceId: string): Promise<ConnectableAgent[]> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) return [];
  const where = membership.role === "owner" || membership.role === "admin"
    ? { workspaceId, enabled: true }
    : {
        workspaceId,
        enabled: true,
        OR: [{ ownerId: userId }, { assignments: { some: { userId } } }],
      };
  return prisma.agent.findMany({
    where,
    select: {
      id: true,
      name: true,
      description: true,
      workspace: { select: { slug: true, displayName: true } },
    },
    orderBy: { name: "asc" },
  });
}

/**
 * Re-checked on every OAuth token resolution so that unassigning a user or
 * removing them from a workspace revokes connector access immediately —
 * a stale OauthAgentGrant alone must never grant access.
 */
export async function userMayUseAgent(
  userId: string,
  agent: { id: string; ownerId: string; workspaceId: string | null },
): Promise<boolean> {
  if (agent.ownerId === userId) return true;
  const assigned = await prisma.agentAssignment.findUnique({
    where: { agentId_userId: { agentId: agent.id, userId } },
  });
  if (assigned) return true;
  if (agent.workspaceId) {
    const admin = await prisma.workspaceMember.findFirst({
      where: { workspaceId: agent.workspaceId, userId, role: { in: ["owner", "admin"] } },
    });
    if (admin) return true;
  }
  return false;
}

/** Workspaces where the user can manage members/invites/assignments. */
export async function adminWorkspacesFor(userId: string) {
  return prisma.workspaceMember.findMany({
    where: { userId, role: { in: ["owner", "admin"] } },
    select: { role: true, workspace: { select: { id: true, slug: true, displayName: true } } },
  });
}

// ---------- Personal workspace provisioning ----------
// Every user needs at least one workspace: tenants, agents and connections all
// carry a workspaceId, and provider credentials refuse to be created without
// one (provider_credentials.ts). scripts/backfill-workspaces.mjs covers this on
// every boot, but a user who signs up between two boots has none — and the
// failure only surfaces at the *end* of an OAuth flow, after the provider has
// already issued tokens ("workspace_id is required to share provider
// credentials"). So provision it at signup, and heal lazily on session too.
//
// Idempotent by design: an existing owner membership short-circuits, and the
// slug loop mirrors the backfill script so wire keys (/mcp/w/<slug>) match.
function slugifyWorkspace(base: string): string {
  return (
    base
      .toLowerCase()
      .replace(/@.*$/, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export async function ensurePersonalWorkspace(user: { id: string; email?: string | null; name?: string | null }): Promise<string> {
  const existing = await prisma.workspaceMember.findFirst({
    where: { userId: user.id, role: "owner" },
    select: { workspaceId: true },
  });
  if (existing) return existing.workspaceId;

  const base = slugifyWorkspace(user.email || user.name || user.id);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (await prisma.workspace.findUnique({ where: { slug }, select: { id: true } })) continue;
    try {
      const ws = await prisma.workspace.create({
        data: {
          slug,
          displayName: user.name ? `${user.name}'s workspace` : slug,
          members: { create: { userId: user.id, role: "owner" } },
        },
        select: { id: true },
      });
      return ws.id;
    } catch (e: any) {
      // Slug taken between the check and the create, or a concurrent request
      // already provisioned this user's workspace — re-read, else try the next
      // slug.
      if (e?.code !== "P2002") throw e;
      const raced = await prisma.workspaceMember.findFirst({
        where: { userId: user.id, role: "owner" },
        select: { workspaceId: true },
      });
      if (raced) return raced.workspaceId;
    }
  }
}
