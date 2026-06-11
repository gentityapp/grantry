// Backfill Tenant rows from existing connection scopes, then link every
// scoped connection to its tenant via tenantId. Idempotent: runs on every
// boot (see start-with-maintenance.mjs) and heals connections created before
// the Tenant entity existed. Unscoped (scope="") connections stay tenantless.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const pairs = await prisma.connection.findMany({
    where: { scope: { not: "" } },
    select: { ownerId: true, scope: true },
    distinct: ["ownerId", "scope"],
  });

  let createdTenants = 0;
  let linkedConnections = 0;
  for (const { ownerId, scope } of pairs) {
    const existing = await prisma.tenant.findUnique({
      where: { ownerId_slug: { ownerId, slug: scope } },
      select: { id: true },
    });
    const tenant = existing ?? await prisma.tenant.create({
      data: { ownerId, slug: scope, displayName: scope },
      select: { id: true },
    });
    if (!existing) createdTenants++;

    const linked = await prisma.connection.updateMany({
      where: { ownerId, scope, tenantId: null },
      data: { tenantId: tenant.id },
    });
    linkedConnections += linked.count;
  }

  console.log(
    `[backfill-tenants] scopes seen: ${pairs.length}, tenants created: ${createdTenants}, connections linked: ${linkedConnections}`,
  );
} catch (err) {
  console.error("[backfill-tenants] failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
