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

  let fullScopeManagers = 0;
  const agents = await prisma.agent.findMany({
    where: { enabled: true, fullScopeManager: false },
    select: {
      id: true,
      name: true,
      description: true,
      ownerId: true,
      workspaceId: true,
      connectionGrants: { select: { connectionId: true } },
    },
  });
  for (const agent of agents) {
    const marker = `${agent.name} ${agent.description ?? ""}`.toLowerCase();
    const hasFullMarker = /\bfull\b/.test(marker) || marker.includes("full-scope");
    const hasManagerMarker = /\b(manager|admin)\b/.test(marker);
    if (!hasFullMarker && !hasManagerMarker) continue;

    const where = { ownerId: agent.ownerId, enabled: true, scope: { not: "" } };
    if (agent.workspaceId) where.workspaceId = agent.workspaceId;
    const allConnections = await prisma.connection.findMany({ where, select: { id: true } });
    if (!allConnections.length) continue;
    const grantedIds = new Set(agent.connectionGrants.map((g) => g.connectionId));
    if (hasFullMarker || allConnections.every((conn) => grantedIds.has(conn.id))) {
      await prisma.agent.update({ where: { id: agent.id }, data: { fullScopeManager: true } });
      fullScopeManagers++;
    }
  }

  console.log(`[backfill-agent-connection-grants] candidate grants: ${rows.length}, created: ${result.count}, full-scope managers marked: ${fullScopeManagers}`);
} catch (err) {
  console.error("[backfill-agent-connection-grants] failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
