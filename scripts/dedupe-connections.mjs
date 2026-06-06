import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const connections = await prisma.connection.findMany({
    orderBy: [{ ownerId: "asc" }, { provider: "asc" }, { scope: "asc" }, { updatedAt: "desc" }],
  });

  const groups = new Map();
  for (const conn of connections) {
    const key = `${conn.ownerId}\u0000${conn.provider}\u0000${conn.scope}`;
    const group = groups.get(key) ?? [];
    group.push(conn);
    groups.set(key, group);
  }

  let deleted = 0;
  for (const [key, group] of groups) {
    if (group.length <= 1) continue;
    group.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    const [keep, ...remove] = group;
    await prisma.connection.deleteMany({ where: { id: { in: remove.map((conn) => conn.id) } } });
    deleted += remove.length;
    const [ownerId, provider, scope] = key.split("\u0000");
    console.log("[dedupe-connections] kept", {
      ownerId,
      provider,
      scope,
      keptId: keep.id,
      deletedIds: remove.map((conn) => conn.id),
    });
  }

  console.log(`[dedupe-connections] complete; deleted ${deleted} duplicate connection(s)`);
} finally {
  await prisma.$disconnect();
}
