import { PrismaClient } from "@prisma/client";
import { deriveCredentialHealth } from "../src/connectors/credential_meta.js";
import { connectionCredentialData } from "../src/provider_credentials.js";

const prisma = new PrismaClient();

async function updateProviderCredentials() {
  const credentials = await prisma.providerCredential.findMany({
    select: {
      id: true,
      credentialMetadata: true,
      credentialValidatedAt: true,
      accessTokenExpiresAt: true,
    },
  });

  let updated = 0;
  for (const credential of credentials) {
    const health = deriveCredentialHealth({
      credentialMetadata: credential.credentialMetadata,
      credentialValidatedAt: credential.credentialValidatedAt,
      accessTokenExpiresAt: credential.accessTokenExpiresAt,
    });
    await prisma.providerCredential.update({
      where: { id: credential.id },
      data: health,
    });
    updated += 1;
  }
  return updated;
}

async function updateConnections() {
  const connections = await prisma.connection.findMany({
    select: {
      id: true,
      credentialMetadata: true,
      credentialValidatedAt: true,
      accessTokenExpiresAt: true,
    },
  });

  let updated = 0;
  for (const connection of connections) {
    const health = deriveCredentialHealth({
      credentialMetadata: connection.credentialMetadata,
      credentialValidatedAt: connection.credentialValidatedAt,
      accessTokenExpiresAt: connection.accessTokenExpiresAt,
    });
    await prisma.connection.update({
      where: { id: connection.id },
      data: connectionCredentialData(health),
    });
    updated += 1;
  }
  return updated;
}

try {
  const [providerCredentials, connections] = await Promise.all([
    updateProviderCredentials(),
    updateConnections(),
  ]);
  console.log(`[backfill-credential-health] complete; providerCredentials=${providerCredentials}, connections=${connections}`);
} finally {
  await prisma.$disconnect();
}
