import { PrismaClient } from "@prisma/client";
import { deriveCredentialHealth } from "../src/connectors/credential_meta.js";

const prisma = new PrismaClient();

try {
  const connections = await prisma.connection.findMany({
    where: { credentialId: null, workspaceId: { not: null } },
    orderBy: [{ workspaceId: "asc" }, { provider: "asc" }, { authType: "asc" }, { createdAt: "asc" }],
  });

  let created = 0;
  let linked = 0;
  for (const conn of connections) {
    if (!conn.workspaceId) continue;
    const credential = await prisma.providerCredential.create({
      data: {
        workspaceId: conn.workspaceId,
        ownerId: conn.ownerId,
        provider: conn.provider,
        authType: conn.authType,
        label: conn.label,
        encryptedCredential: conn.encryptedCredential,
        encryptedServerCredential: conn.encryptedServerCredential,
        credentialMetadata: conn.credentialMetadata,
        credentialValidatedAt: conn.credentialValidatedAt,
        ...deriveCredentialHealth({
          credentialMetadata: conn.credentialMetadata,
          credentialValidatedAt: conn.credentialValidatedAt,
          accessTokenExpiresAt: conn.accessTokenExpiresAt,
        }),
        refreshToken: conn.refreshToken,
        accessTokenExpiresAt: conn.accessTokenExpiresAt,
      },
    });
    created++;
    await prisma.connection.update({
      where: { id: conn.id },
      data: { credentialId: credential.id },
    });
    linked++;
  }

  console.log(`[backfill-provider-credentials] scanned ${connections.length}, credentials created: ${created}, connections linked: ${linked}`);
} catch (err) {
  console.error("[backfill-provider-credentials] failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
