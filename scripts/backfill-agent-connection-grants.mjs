import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function providerOf(tool) {
  return String(tool || "").includes("/") ? String(tool).split("/", 1)[0] : "";
}

try {
  const agentRoles = await prisma.agentRole.findMany({
    include: {
      agent: { select: { id: true, ownerId: true, workspaceId: true } },
      role: { select: { allowedTools: true, allowedScopes: true } },
    },
    orderBy: [{ agentId: "asc" }, { roleId: "asc" }],
  });

  const rowsByKey = new Map();
  for (const ar of agentRoles) {
    const providers = Array.from(new Set(safeJsonArray(ar.role.allowedTools).map(providerOf).filter(Boolean)));
    if (!providers.length) continue;

    const allowedScopes = safeJsonArray(ar.role.allowedScopes);
    const where = {
      ownerId: ar.agent.ownerId,
      provider: { in: providers },
      enabled: true,
      ...(allowedScopes.length ? { scope: { in: allowedScopes } } : {}),
    };
    if (ar.agent.workspaceId) where.workspaceId = ar.agent.workspaceId;

    const connections = await prisma.connection.findMany({
      where,
      select: { id: true },
    });

    for (const cn of connections) {
      const key = `${ar.agent.id}\0${cn.id}`;
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, {
          agentId: ar.agent.id,
          connectionId: cn.id,
          createdById: ar.agent.ownerId,
        });
      }
    }
  }

  const rows = Array.from(rowsByKey.values());
  const result = rows.length
    ? await prisma.agentConnectionGrant.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 };

  console.log(`[backfill-agent-connection-grants] candidate grants: ${rows.length}, created: ${result.count}`);
} catch (err) {
  console.error("[backfill-agent-connection-grants] failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
