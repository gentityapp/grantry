import { prisma } from "./db.js";

type Boundary = { ownerId: string; workspaceId: string | null };
export function delegationBoundaryMatches(a: Boundary | null, b: Boundary | null): boolean {
  return !!a && !!b && a.ownerId === b.ownerId && a.workspaceId === b.workspaceId;
}

export async function consumeDelegationGrant(id: string, now = new Date()): Promise<boolean> {
  const consumed = await prisma.delegationGrant.updateMany({
    where: { id, status: "issued", expiresAt: { gt: now } },
    data: { status: "consumed", consumedAt: now },
  });
  return consumed.count === 1;
}
