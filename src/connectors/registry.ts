// Connector registry: maps provider name to its configuration.
// Each provider knows:
//   - How to authenticate (paste PAT, or OAuth start/callback)
//   - What scopes to request
//   - What API tools it exposes (declared here, dispatched in mcp.ts)

export type ProviderDef = {
  /** Public provider key, used in connections.provider and MCP tool prefixes */
  key: string;
  /** Display name */
  label: string;
  /** Supported authentication methods. e.g. ["pat"] or ["oauth"] or ["pat", "oauth"].
   *  The wizard exposes both options when multiple are listed. */
  authTypes: ("pat" | "oauth")[];
  /** Help text shown in the wizard */
  helpText: string;
  /** Where to get a token (for pat) or register OAuth app (for oauth) */
  tokenUrl?: string;
  /** Where to register/manage an OAuth App (shown in the wizard for oauth flow) */
  oauthSetupUrl?: string;
  /** Optional server-side credential required in addition to user auth. */
  serverCredentialLabel?: string;
  serverCredentialEnv?: string;
  serverCredentialUrl?: string;
  /** OAuth scopes to request (oauth only) */
  oauthScopes?: string[];
  /** OAuth App authorize URL (oauth only) */
  authorizeUrl?: string;
  /** OAuth App token exchange URL (oauth only) */
  oauthTokenUrl?: string;
  /** Tools this provider exposes, by name */
  tools: string[];
  /** Whether this provider has an MCP dispatcher implemented in this service. */
  implemented?: boolean;
};

export const PROVIDERS: Record<string, ProviderDef> = {
  notion: {
    key: "notion",
    label: "Notion",
    authTypes: ["pat"],
    helpText: "Create an internal integration at notion.so/my-integrations. Copy the 'Internal Integration Token' (starts with ntn_ or secret_).",
    /** Where to get a new PAT (clickable link shown in the wizard) */
    tokenUrl: "https://www.notion.so/my-integrations",
    tools: [
      "notion/list_dbs",
      "notion/get_page",
      "notion/query_db",
      "notion/create_page",
      "notion/update_page",
      "notion/append_blocks",
      "notion/update_blocks",
      "notion/update_page_status",
    ],
  },
  github: {
    key: "github",
    label: "GitHub",
    // Both PAT and OAuth are supported — users pick at the wizard.
    authTypes: ["pat", "oauth"],
    helpText: "Either paste a Personal Access Token (Settings → Developer settings → Tokens) OR click Connect with OAuth to authorize this app.",
    /** Where to get a new PAT (clickable link shown in the wizard) */
    tokenUrl: "https://github.com/settings/personal-access-tokens",
    /** Where to register/manage an OAuth App (callback URL setup, etc.) */
    oauthSetupUrl: "https://github.com/settings/developers",
    oauthScopes: ["repo", "read:user"],
    authorizeUrl: "https://github.com/login/oauth/authorize",
    oauthTokenUrl: "https://github.com/login/oauth/access_token",
    tools: ["github/list_repos", "github/get_repo", "github/get_file_contents", "github/list_issues", "github/create_issue", "github/git_push_repo", "github/create_repo"],
    implemented: true,
  },
  cloudflare: {
    key: "cloudflare",
    label: "Cloudflare",
    authTypes: ["pat"],
    helpText: "Paste a Cloudflare API Token. Recommended permissions: Zone:Read, DNS:Read/Edit, and Cache Purge for the zones this tenant should manage.",
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    tools: [
      "cloudflare/list_zones",
      "cloudflare/get_zone",
      "cloudflare/list_dns_records",
      "cloudflare/create_dns_record",
      "cloudflare/update_dns_record",
      "cloudflare/delete_dns_record",
      "cloudflare/purge_cache",
    ],
    implemented: true,
  },
  clarity: {
    key: "clarity",
    label: "Microsoft Clarity",
    authTypes: ["pat"],
    helpText: "Paste a Microsoft Clarity Data Export API token from the project's Settings → Data Export page.",
    tokenUrl: "https://clarity.microsoft.com/",
    tools: ["clarity/get_live_insights"],
    implemented: true,
  },
  google_drive: {
    key: "google_drive",
    label: "Google Drive",
    authTypes: ["oauth"],
    helpText: "Connect your Google account. We'll request read-only access to Drive files you choose to share with the integration.",
    /** Where to register/manage an OAuth client (callback URL setup) */
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_drive/list_files", "google_drive/get_file", "google_drive/search"],
    implemented: true,
  },
  google_gsc: {
    key: "google_gsc",
    label: "Google Search Console",
    authTypes: ["oauth"],
    helpText: "Connect your Google account to access Search Console data for sites you own.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_gsc/list_sites", "google_gsc/search_analytics"],
    implemented: true,
  },
  google_analytics: {
    key: "google_analytics",
    label: "Google Analytics",
    authTypes: ["oauth"],
    helpText: "Connect your Google account to access GA4 properties and run read-only Analytics Data API reports.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_analytics/list_properties", "google_analytics/run_report"],
    implemented: true,
  },
  google_ads: {
    key: "google_ads",
    label: "Google Ads",
    authTypes: ["oauth"],
    helpText: "Connect the Google user who can access the Ads account. Google Ads API calls also require GOOGLE_ADS_DEVELOPER_TOKEN from the manager account API Center as a separate server setting.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    serverCredentialLabel: "Google Ads API Developer Token",
    serverCredentialEnv: "GOOGLE_ADS_DEVELOPER_TOKEN",
    serverCredentialUrl: "https://ads.google.com/aw/apicenter",
    oauthScopes: [
      "https://www.googleapis.com/auth/adwords",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_ads/list_accessible_customers", "google_ads/search", "google_ads/mutate"],
    implemented: true,
  },
  gmail: {
    key: "gmail",
    label: "Gmail",
    authTypes: ["oauth"],
    helpText: "Connect Gmail to list, read, and send messages through the Gmail API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["gmail/list_messages", "gmail/get_message", "gmail/send_message"],
    implemented: true,
  },
  hubspot: {
    key: "hubspot",
    label: "HubSpot",
    authTypes: ["pat", "oauth"],
    helpText: "Paste a HubSpot Private App access token or connect with OAuth to access CRM data.",
    tokenUrl: "https://app.hubspot.com/private-apps",
    oauthSetupUrl: "https://developers.hubspot.com/",
    oauthScopes: ["crm.objects.deals.read", "crm.objects.deals.write", "crm.objects.contacts.read", "crm.objects.contacts.write", "oauth"],
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    oauthTokenUrl: "https://api.hubapi.com/oauth/v1/token",
    tools: ["hubspot/list_deals", "hubspot/get_contact", "hubspot/create_deal"],
    implemented: true,
  },
};

export function getProvider(key: string): ProviderDef | undefined {
  return PROVIDERS[key];
}

export function listProviders(): ProviderDef[] {
  return Object.values(PROVIDERS).filter((p) => p.implemented !== false);
}

export function toolsForProvider(providerKey: string): string[] {
  const provider = PROVIDERS[providerKey];
  if (!provider || provider.implemented === false) return [];
  return provider.tools;
}
