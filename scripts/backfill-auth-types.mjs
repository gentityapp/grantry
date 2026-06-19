import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function inferAuthType(conn) {
  // HubSpot is implemented as a Private App access token connector in Grantry.
  // Older rows were incorrectly inferred as oauth because HubSpot OAuth fields
  // existed in the registry; normalize those legacy rows back to pat.
  if (conn.provider === "hubspot") return "pat";
  if (conn.authType && conn.authType !== "pat") return conn.authType;
  if (conn.refreshToken || conn.accessTokenExpiresAt) return "oauth";
  if (conn.provider.startsWith("google_")) return "oauth";
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
      ownerId: true,
      refreshToken: true,
      accessTokenExpiresAt: true,
    },
  });

  let updated = 0;
  let skippedConflicts = 0;
  for (const conn of connections) {
    const authType = inferAuthType(conn);
    if (conn.authType === authType) continue;
    const conflict = await prisma.connection.findFirst({
      where: {
        id: { not: conn.id },
        ownerId: conn.ownerId,
        provider: conn.provider,
        scope: conn.scope,
        authType,
      },
      select: { id: true },
    });
    if (conflict) {
      skippedConflicts += 1;
      console.log("[backfill-auth-types] skipped conflict", { id: conn.id, conflictId: conflict.id, provider: conn.provider, scope: conn.scope, authType });
      continue;
    }
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

  const providerCredentialResult = await prisma.providerCredential.updateMany({
    where: { provider: "hubspot", authType: { not: "pat" } },
    data: { authType: "pat" },
  });

  console.log(`[backfill-auth-types] complete; updated ${updated} connection(s), skipped ${skippedConflicts} conflict(s), ${providerCredentialResult.count} provider credential(s)`);
} finally {
  await prisma.$disconnect();
}
