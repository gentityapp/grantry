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
    helpText: "Paste a fine-grained Personal Access Token and manage which repositories it can access from GitHub's token settings, or click Connect with OAuth to authorize this app.",
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
  yahoo_ads: {
    key: "yahoo_ads",
    label: "LINE Yahoo Ads",
    authTypes: ["oauth"],
    helpText: "Connect the LINE Yahoo Business ID that can access Search Ads / Display Ads accounts. Access tokens expire after one hour; grantry stores the refresh token and refreshes automatically.",
    oauthSetupUrl: "https://connect-business.yahoo.co.jp/",
    oauthScopes: ["yahooads"],
    authorizeUrl: "https://biz-oauth.yahoo.co.jp/oauth/v1/authorize",
    oauthTokenUrl: "https://biz-oauth.yahoo.co.jp/oauth/v1/token",
    tools: ["yahoo_ads/list_base_accounts", "yahoo_ads/get", "yahoo_ads/mutate"],
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
  youtube: {
    key: "youtube",
    label: "YouTube",
    authTypes: ["oauth"],
    helpText: "Connect the Google account that owns the YouTube channel. Read access lists channels, videos, playlists and runs searches; management access updates videos and manages playlists. Requires the youtube.force-ssl scope.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: [
      "youtube/list_channels",
      "youtube/list_videos",
      "youtube/search",
      "youtube/list_playlists",
      "youtube/list_playlist_items",
      "youtube/update_video",
      "youtube/create_playlist",
      "youtube/update_playlist",
      "youtube/delete_playlist",
      "youtube/add_playlist_item",
      "youtube/delete_playlist_item",
    ],
    implemented: true,
  },
  hubspot: {
    key: "hubspot",
    label: "HubSpot",
    authTypes: ["pat"],
    helpText: "Paste a HubSpot Private App access token to access CRM data.",
    tokenUrl: "https://app.hubspot.com/private-apps",
    oauthScopes: ["crm.objects.deals.read", "crm.objects.deals.write", "crm.objects.contacts.read", "crm.objects.contacts.write", "oauth"],
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    oauthTokenUrl: "https://api.hubapi.com/oauth/v1/token",
    tools: ["hubspot/list_deals", "hubspot/get_contact", "hubspot/create_deal"],
    implemented: true,
  },
  attio: {
    key: "attio",
    label: "Attio",
    authTypes: ["pat"],
    helpText: "Paste an Attio workspace access token from Settings > Developers > Access tokens. Required scopes depend on the tools: object_configuration:read plus record_permission:read/read-write, comment:read/read-write, note:read/read-write, task:read/read-write, meeting:read, and user_management:read.",
    tokenUrl: "https://app.attio.com/settings/developers/access-tokens",
    tools: [
      "attio/search_records",
      "attio/list_records",
      "attio/get_record",
      "attio/create_record",
      "attio/upsert_record",
      "attio/update_record",
      "attio/list_notes",
      "attio/get_note",
      "attio/create_note",
      "attio/delete_note",
      "attio/list_tasks",
      "attio/get_task",
      "attio/create_task",
      "attio/update_task",
      "attio/delete_task",
      "attio/list_threads",
      "attio/get_thread",
      "attio/create_comment",
      "attio/get_comment",
      "attio/delete_comment",
      "attio/list_meetings",
      "attio/get_meeting",
    ],
    implemented: true,
  },
  clay: {
    key: "clay",
    label: "Clay",
    authTypes: ["pat"],
    helpText: "Paste your Clay API key from Settings > Account > API key. It is sent as a Bearer token to the Clay API.",
    tokenUrl: "https://app.clay.com/settings/account",
    tools: [
      "clay/raw_request",
      "clay/lookup_row",
      "clay/create_row",
      "clay/update_row",
      "clay/enrich_person",
      "clay/enrich_company",
    ],
    implemented: true,
  },
  heyreach: {
    key: "heyreach",
    label: "HeyReach",
    authTypes: ["pat"],
    helpText: "Paste a HeyReach Public API key. It is sent as the X-API-KEY header to the HeyReach Public API.",
    tokenUrl: "https://app.heyreach.io/",
    tools: [
      "heyreach/check_api_key",
      "heyreach/list_campaigns",
      "heyreach/get_campaign",
      "heyreach/pause_campaign",
      "heyreach/resume_campaign",
      "heyreach/add_leads_to_campaign",
      "heyreach/list_leads",
      "heyreach/list_conversations",
      "heyreach/list_lead_lists",
      "heyreach/create_empty_list",
      "heyreach/get_overall_stats",
    ],
    implemented: true,
  },
  chatwork: {
    key: "chatwork",
    label: "Chatwork",
    authTypes: ["pat"],
    helpText: "Paste a Chatwork API token. It is sent as the x-chatworktoken header to the Chatwork API v2.",
    tokenUrl: "https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php",
    tools: [
      "chatwork/get_me",
      "chatwork/list_contacts",
      "chatwork/list_rooms",
      "chatwork/create_room",
      "chatwork/get_room",
      "chatwork/list_room_members",
      "chatwork/update_room_members",
      "chatwork/list_messages",
      "chatwork/get_message",
      "chatwork/send_message",
      "chatwork/list_my_tasks",
      "chatwork/list_room_tasks",
      "chatwork/get_room_task",
      "chatwork/create_room_task",
      "chatwork/list_room_files",
      "chatwork/get_room_file",
    ],
    implemented: true,
  },
  railway: {
    key: "railway",
    label: "Railway",
    authTypes: ["pat"],
    helpText: "Paste a Railway Project Token from Project Settings > Tokens. Plain tokens are treated as project tokens. For account/workspace tokens, paste JSON like {\"token\":\"...\",\"token_type\":\"account\"}.",
    tokenUrl: "https://railway.com",
    tools: [
      "railway/graphql",
      "railway/project_token_info",
      "railway/introspect_schema",
    ],
    implemented: true,
  },
  resend: {
    key: "resend",
    label: "Resend",
    authTypes: ["pat"],
    helpText: "Paste a Resend API key from the Resend API Keys dashboard. Sending email requires a key with sending_access or full_access and a verified sending domain.",
    tokenUrl: "https://resend.com/api-keys",
    tools: [
      "resend/send_email",
      "resend/list_emails",
      "resend/get_email",
      "resend/list_domains",
      "resend/get_domain",
      "resend/list_api_keys",
    ],
    implemented: true,
  },
  reddit: {
    key: "reddit",
    label: "Reddit",
    authTypes: ["oauth"],
    helpText: "Register a 'web app' at reddit.com/prefs/apps with the redirect URI set to this app's /oauth/reddit/callback. Connect grants read access plus posting, commenting, and voting as the authorized account.",
    oauthSetupUrl: "https://www.reddit.com/prefs/apps",
    oauthScopes: ["identity", "read", "mysubreddits", "history", "submit", "edit", "vote"],
    authorizeUrl: "https://www.reddit.com/api/v1/authorize",
    oauthTokenUrl: "https://www.reddit.com/api/v1/access_token",
    tools: [
      "reddit/get_me",
      "reddit/get_subreddit",
      "reddit/list_posts",
      "reddit/search",
      "reddit/get_comments",
      "reddit/submit_post",
      "reddit/submit_comment",
      "reddit/vote",
    ],
    implemented: true,
  },
  x: {
    key: "x",
    label: "X",
    authTypes: ["oauth"],
    helpText: "Create an OAuth 2.0 app in the X developer portal (Confidential client, type Web App) with the callback URL set to this app's /oauth/x/callback. Connect grants read access plus posting and deleting tweets as the authorized account.",
    oauthSetupUrl: "https://developer.x.com/en/portal/dashboard",
    oauthScopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    oauthTokenUrl: "https://api.x.com/2/oauth2/token",
    tools: [
      "x/get_me",
      "x/get_user",
      "x/get_user_tweets",
      "x/search_recent",
      "x/get_tweet",
      "x/post_tweet",
      "x/delete_tweet",
    ],
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
