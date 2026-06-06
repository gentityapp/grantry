import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function inferScope(roleName, ownerScopes) {
  if (roleName.includes("-dev-")) return roleName.split("-dev-")[0];
  if (roleName.endsWith("-dev")) return roleName.slice(0, -4);
  if (ownerScopes.has(roleName)) return roleName;
  return null;
}

try {
  const [roles, connections] = await Promise.all([
    prisma.role.findMany({ orderBy: [{ ownerId: "asc" }, { name: "asc" }] }),
    prisma.connection.findMany({ select: { ownerId: true, scope: true } }),
  ]);

  const scopesByOwner = new Map();
  for (const conn of connections) {
    if (!conn.scope) continue;
    const scopes = scopesByOwner.get(conn.ownerId) ?? new Set();
    scopes.add(conn.scope);
    scopesByOwner.set(conn.ownerId, scopes);
  }

  let updated = 0;
  for (const role of roles) {
    let allowedScopes = [];
    try {
      const parsed = JSON.parse(role.allowedScopes || "[]");
      allowedScopes = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch {
      allowedScopes = [];
    }
    if (allowedScopes.length > 0) continue;

    const ownerScopes = scopesByOwner.get(role.ownerId) ?? new Set();
    const scope = inferScope(role.name, ownerScopes);
    if (!scope || !ownerScopes.has(scope)) {
      console.log("[harden-roles] skipped legacy-any role; scope could not be inferred", {
        roleId: role.id,
        ownerId: role.ownerId,
        name: role.name,
      });
      continue;
    }

    await prisma.role.update({
      where: { id: role.id },
      data: { allowedScopes: JSON.stringify([scope]) },
    });
    updated += 1;
    console.log("[harden-roles] pinned legacy-any role", {
      roleId: role.id,
      ownerId: role.ownerId,
      name: role.name,
      scope,
    });
  }

  console.log(`[harden-roles] complete; updated ${updated} role(s)`);
} finally {
  await prisma.$disconnect();
}
