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
  "meta_ads_platform",
];

// These providers require a workspace-owned OAuth app. A previous version of
// this maintenance script incorrectly disabled them as platform apps; restore
// those rows so reconnect can find the saved client_id/client_secret again.
const WORKSPACE_OAUTH_APP_PROVIDERS = [
  "moneyforward",
  "meta_ads",
];

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
