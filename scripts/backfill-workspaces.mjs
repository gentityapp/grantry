// Backfill personal workspaces (docs/workspace-design.md, phase 2 migration).
// For every user that owns any resource (or simply exists), ensure a personal
// workspace + owner membership, then point their tenants/agents/connections
// and legacy role rows at it. Idempotent: runs on every boot via
// start-with-maintenance.mjs and only touches rows with workspaceId = null.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function slugify(base) {
  return base
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
}

try {
  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
  let createdWorkspaces = 0;
  let migratedRows = 0;

  for (const user of users) {
    // Personal workspace = the workspace this user owns a membership in.
    let membership = await prisma.workspaceMember.findFirst({
      where: { userId: user.id, role: "owner" },
      select: { workspaceId: true },
    });

    if (!membership) {
      const base = slugify(user.email || user.name || user.id);
      let slug = base;
      for (let i = 2; await prisma.workspace.findUnique({ where: { slug } }); i++) {
        slug = `${base}-${i}`;
      }
      const ws = await prisma.workspace.create({
        data: {
          slug,
          displayName: user.name ? `${user.name}'s workspace` : slug,
          members: { create: { userId: user.id, role: "owner" } },
        },
        select: { id: true },
      });
      membership = { workspaceId: ws.id };
      createdWorkspaces++;
    }

    const wsId = membership.workspaceId;
    const [t, a, r, cn] = await Promise.all([
      prisma.tenant.updateMany({ where: { ownerId: user.id, workspaceId: null }, data: { workspaceId: wsId } }),
      prisma.agent.updateMany({ where: { ownerId: user.id, workspaceId: null }, data: { workspaceId: wsId } }),
      prisma.role.updateMany({ where: { ownerId: user.id, workspaceId: null }, data: { workspaceId: wsId } }),
      prisma.connection.updateMany({ where: { ownerId: user.id, workspaceId: null }, data: { workspaceId: wsId } }),
    ]);
    migratedRows += t.count + a.count + r.count + cn.count;
  }

  console.log(`[backfill-workspaces] users=${users.length} createdWorkspaces=${createdWorkspaces} migratedRows=${migratedRows}`);
} catch (err) {
  console.error("[backfill-workspaces] failed:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
