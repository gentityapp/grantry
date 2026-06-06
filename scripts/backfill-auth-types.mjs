import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function inferAuthType(conn) {
  if (conn.authType && conn.authType !== "pat") return conn.authType;
  if (conn.refreshToken || conn.accessTokenExpiresAt) return "oauth";
  if (conn.provider.startsWith("google_")) return "oauth";
  if (conn.provider === "hubspot") return "oauth";
  if (
    conn.provider === "github"
    && conn.label?.startsWith("github-")
    && conn.label !== `github-${conn.scope}`
    && conn.label !== `github-${conn.scope}-pat`
  ) {
    return "oauth";
  }
  return "pat";
}

try {
  const connections = await prisma.connection.findMany({
    select: {
      id: true,
      provider: true,
      authType: true,
      label: true,
      scope: true,
      refreshToken: true,
      accessTokenExpiresAt: true,
    },
  });

  let updated = 0;
  for (const conn of connections) {
    const authType = inferAuthType(conn);
    if (conn.authType === authType) continue;
    await prisma.connection.update({
      where: { id: conn.id },
      data: { authType },
    });
    updated += 1;
    console.log("[backfill-auth-types] updated", {
      id: conn.id,
      provider: conn.provider,
      authType,
    });
  }

  console.log(`[backfill-auth-types] complete; updated ${updated} connection(s)`);
} finally {
  await prisma.$disconnect();
}
