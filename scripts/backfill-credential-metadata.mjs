import { PrismaClient } from "@prisma/client";
import { decrypt } from "../src/crypto.js";
import { credentialMetadataForStorage } from "../src/connectors/credential_meta.js";

const prisma = new PrismaClient();

try {
  const connections = await prisma.connection.findMany({
    where: { enabled: true },
    select: {
      id: true,
      provider: true,
      authType: true,
      encryptedCredential: true,
      credentialMetadata: true,
    },
  });

  let updated = 0;
  for (const conn of connections) {
    if (conn.credentialMetadata && conn.credentialMetadata !== "{}") continue;
    try {
      const token = decrypt(conn.encryptedCredential);
      const data = await credentialMetadataForStorage(conn.provider, conn.authType, token);
      await prisma.connection.update({ where: { id: conn.id }, data });
      updated += 1;
      console.log("[backfill-credential-metadata] updated", {
        id: conn.id,
        provider: conn.provider,
        authType: conn.authType,
      });
    } catch (e) {
      console.error("[backfill-credential-metadata] skipped", {
        id: conn.id,
        provider: conn.provider,
        authType: conn.authType,
        error: e?.message ?? String(e),
      });
    }
  }

  console.log(`[backfill-credential-metadata] complete; updated ${updated} connection(s)`);
} finally {
  await prisma.$disconnect();
}
