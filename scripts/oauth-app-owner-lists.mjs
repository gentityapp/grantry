// Which providers' workspace oauth_app rows the boot script may touch.
// Kept apart from the script so tests can check them against the registry
// (src/connectors/registry.ts oauthAppOwner) without opening a database.

// Providers that use Grantry-owned OAuth clients from environment variables.
// Workspace oauth_app credentials for them are legacy/stale configuration and
// can accidentally point OAuth starts at deleted provider clients.
export const PLATFORM_OAUTH_PROVIDERS = [
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
  "hubspot",
  "meta_ads_platform",
];

// Providers that require a workspace-owned OAuth app (oauthAppOwner: "workspace").
// Earlier versions of the boot script disabled some of these as platform apps on
// every deploy; restore those rows so refresh and reconnect find the saved client.
// 2026-09-15: zoom and freee were still on the platform list, so every grantry
// deploy disabled the Zoom app the data workspace had just registered and all
// Zoom calls failed with "OAuth app for this credential is missing or disabled".
export const WORKSPACE_OAUTH_APP_PROVIDERS = [
  "zoom",
  "freee",
  "moneyforward",
  "meta_ads",
  "microsoft_teams",
  "canva",
  "figma",
  "miro",
];
