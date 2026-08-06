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
