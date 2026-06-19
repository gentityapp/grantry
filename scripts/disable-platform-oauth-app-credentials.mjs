import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// These providers use Grantry-owned OAuth clients from environment variables.
// Workspace oauth_app credentials for them are legacy/stale configuration and
// can accidentally point OAuth starts at deleted provider clients.
const PLATFORM_OAUTH_PROVIDERS = [
  "github",
  "google_gsc",
  "google_analytics",
  "google_ads",
  "google_drive",
  "gmail",
  "youtube",
  "google_calendar",
  "google_sheets",
  "google_tag_manager",
  "google_cloud",
  "bigquery",
  "google_admin",
  "yahoo_ads",
  "slack",
  "reddit",
  "x",
  "zoom",
  "hubspot",
  "freee",
  "moneyforward",
  "meta_ads",
];

try {
  const result = await prisma.providerCredential.updateMany({
    where: {
      authType: "oauth_app",
      provider: { in: PLATFORM_OAUTH_PROVIDERS },
      enabled: true,
    },
    data: { enabled: false },
  });

  console.log(`[disable-platform-oauth-app-credentials] disabled ${result.count} stale platform oauth_app credential(s)`);
} catch (err) {
  console.error("[disable-platform-oauth-app-credentials] failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
