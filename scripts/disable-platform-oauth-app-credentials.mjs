import { PrismaClient } from "@prisma/client";
import { PLATFORM_OAUTH_PROVIDERS, WORKSPACE_OAUTH_APP_PROVIDERS } from "./oauth-app-owner-lists.mjs";

const prisma = new PrismaClient();

try {
  const restored = await prisma.providerCredential.updateMany({
    where: {
      authType: "oauth_app",
      provider: { in: WORKSPACE_OAUTH_APP_PROVIDERS },
      enabled: false,
    },
    data: { enabled: true },
  });

  const result = await prisma.providerCredential.updateMany({
    where: {
      authType: "oauth_app",
      provider: { in: PLATFORM_OAUTH_PROVIDERS },
      enabled: true,
    },
    data: { enabled: false },
  });

  console.log(`[disable-platform-oauth-app-credentials] restored ${restored.count} workspace oauth_app credential(s); disabled ${result.count} stale platform oauth_app credential(s)`);
} catch (err) {
  console.error("[disable-platform-oauth-app-credentials] failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
