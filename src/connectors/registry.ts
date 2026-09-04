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
   *  The wizard exposes both options when multiple are listed.
   *  "service_account" = Google Workspace Domain-Wide Delegation (SA key + impersonated admin). */
  authTypes: ("pat" | "oauth" | "service_account")[];
  /** Help text shown in the wizard */
  helpText: string;
  /** Where to get a token (for pat) or register OAuth app (for oauth) */
  tokenUrl?: string;
  /** Where to register/manage an OAuth App (shown in the wizard for oauth flow) */
  oauthSetupUrl?: string;
  /** Who owns the OAuth app client credentials. Defaults to platform/env credentials. */
  oauthAppOwner?: "workspace" | "platform";
  /** Default OAuth client authentication method for token exchange. */
  oauthClientAuthMethod?: "CLIENT_SECRET_BASIC" | "CLIENT_SECRET_POST";
  /** Optional server-side credential required in addition to user auth. */
  serverCredentialLabel?: string;
  serverCredentialEnv?: string;
  serverCredentialUrl?: string;
  /** OAuth scopes to request (oauth only) */
  oauthScopes?: string[];
  /** OAuth optional scopes to request when the provider supports optional_scope. */
  oauthOptionalScopes?: string[];
  /** Google API scopes to mint when using Domain-Wide Delegation (service_account only).
   *  These are the exact scopes the customer's Workspace admin must authorize for the
   *  service account's client_id in Admin console → Security → API controls →
   *  Domain-wide delegation. Typically oauthScopes minus userinfo.email. */
  dwdScopes?: string[];
  /** OAuth App authorize URL (oauth only) */
  authorizeUrl?: string;
  /** OAuth App token exchange URL (oauth only) */
  oauthTokenUrl?: string;
  /** OAuth refresh URL, when the provider refreshes at a different endpoint than
   *  token exchange (e.g. Figma: /v1/oauth/refresh vs /v1/oauth/token). Falls
   *  back to oauthTokenUrl when unset. */
  oauthRefreshUrl?: string;
  /** Tools this provider exposes, by name */
  tools: string[];
  /** Provider permission scopes required for specific tools before dispatch. */
  toolScopeRequirements?: Record<string, string[]>;
  /** Generic provider API request manifest. Built-ins default to provider-token authority; custom providers may restrict methods as an explicit workspace policy. */
  genericRequest?: {
    baseUrl: string;
    baseUrls?: Record<string, string>;
    defaultMethods: string[];
    /**
     * Per-provider request timeout in ms, for APIs whose normal responses are
     * slower than the shared default. Clamped by the generic request layer.
     */
    timeoutMs?: number;
    allowedPathPrefixes: string[];
    blockedPathPrefixes?: string[];
    authScheme?: "bearer" | "api_key" | "api_key_query";
    apiKeyHeader?: string;
    /** Query parameter name for the credential when authScheme is "api_key_query" (e.g. Smartlead's `api_key`). */
    apiKeyQueryParam?: string;
    smokeTests?: Array<{
      id: string;
      method: "GET";
      path: string;
      query?: Record<string, string | number | boolean>;
      baseUrlKey?: string;
      base_url_key?: string;
      requiredScopes?: string[];
    }>;
    operations?: Array<{
      id: string;
      tools?: string[];
      method: string;
      path: string;
      description: string;
      baseUrlKey?: string;
      base_url_key?: string;
      requiredScopes?: string[];
      risk: "read" | "write" | "destructive";
      /**
       * Query params to send when this operation is exercised as a connection
       * smoke test. Defaults to `{ limit: 1 }`. Set to `{}` for APIs that
       * reject unknown query params (e.g. the Search Console Webmasters API,
       * which returns 400 on an unexpected `limit`).
       */
      probeQuery?: Record<string, string | number | boolean>;
    }>;
  };
  /** Whether this provider has an MCP dispatcher implemented in this service. */
  implemented?: boolean;
  /** Structured credential fields for PAT providers whose credential is a JSON
   *  object. When set, the wizard renders one labelled input per field instead of
   *  a raw JSON textarea, and assembles them into the JSON string the connector
   *  expects. Each `key` MUST match the exact JSON key the connector parses. */
  credentialFields?: Array<{
    key: string;
    label: string;
    required?: boolean;
    /** Render as a password input (masked) for secret values. */
    secret?: boolean;
    placeholder?: string;
    hint?: string;
  }>;
};

const META_ADS_READ_TOOLS = [
  "meta_ads/list_ad_accounts",
  "meta_ads/get_ad_account",
  "meta_ads/list_campaigns",
  "meta_ads/get_campaign",
  "meta_ads/list_ad_sets",
  "meta_ads/list_ads",
  "meta_ads/get_insights",
];

const META_ADS_PLATFORM_READ_TOOLS = META_ADS_READ_TOOLS.map((tool) =>
  tool.replace("meta_ads/", "meta_ads_platform/"),
);

export const PROVIDERS: Record<string, ProviderDef> = {
  // grantry itself as a provider (dogfooding): agent permission management is
  // granted exactly like any external SaaS — a human mints a gn_adm_ API key
  // on the dashboard, pastes it into a connection, and grants it to an agent.
  // The key is the capability; issuance is dashboard-only and agents never see
  // the plaintext, so admin access cannot self-replicate through these tools.
  grantry: {
    key: "grantry",
    label: "grantry (admin)",
    authTypes: ["pat"],
    helpText: "Paste a grantry admin API key (gn_adm_…) minted on the /api-keys page. It lets the granted agent manage this workspace's tenants, agents, connections, and grants over MCP.",
    tokenUrl: "https://app.grantry.ai/api-keys",
    tools: [
      "grantry/list_agents",
      "grantry/list_tenants",
      "grantry/list_connections",
      "grantry/create_tenant",
      "grantry/create_agent",
      "grantry/update_agent",
      "grantry/delete_agent",
      "grantry/assign_agent",
      "grantry/unassign_agent",
      "grantry/set_runbook",
      "grantry/rotate_agent_token",
      "grantry/grant_scope",
      "grantry/revoke_scope",
      "grantry/grant_connection",
      "grantry/revoke_connection",
      "grantry/create_connection",
      "grantry/set_connection_enabled",
      "grantry/get_connect_url",
    ],
  },
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
  zoom: {
    key: "zoom",
    label: "Zoom",
    authTypes: ["oauth"],
    helpText: "Register your own Zoom OAuth app and paste its Client ID and Client Secret here — each workspace connects its own app, because Zoom account-level (:admin) data is only reachable through an app owned by that Zoom account. At marketplace.zoom.us create a General app, choose ADMIN-MANAGED (this is fixed at creation and cannot be changed later; a user-managed app can never be granted the :admin scopes), set its redirect URL to this server's /oauth/zoom/callback, and declare the same scopes listed here — Zoom silently drops scopes the app does not declare. The Zoom Phone scopes are read-only and need a Zoom Phone license.",
    oauthSetupUrl: "https://marketplace.zoom.us/develop/create",
    oauthAppOwner: "workspace",
    oauthClientAuthMethod: "CLIENT_SECRET_BASIC",
    // Account-level (:admin) scopes throughout: this provider expects an
    // admin-managed Zoom app, whose Marketplace scope picker only offers the
    // :admin/:master variants — the user-scoped variants are not selectable
    // there, so requesting them would just get them dropped.
    oauthScopes: [
      "user:read:user:admin",
      "user:read:list_users:admin",
      "cloud_recording:read:list_user_recordings:admin",
      "cloud_recording:read:list_recording_files:admin",
      "meeting:read:list_meetings:admin",
      "meeting:read:meeting:admin",
      "meeting:write:meeting:admin",
      "report:read:list_meeting_participants:admin",
      // Zoom Phone (read-only): phone users + account call history.
      "phone:read:list_users:admin",
      "phone:read:user:admin",
      "phone:read:list_call_logs:admin",
      "phone:read:call_log:admin",
    ],
    authorizeUrl: "https://zoom.us/oauth/authorize",
    oauthTokenUrl: "https://zoom.us/oauth/token",
    tools: [
      "zoom/get_me",
      "zoom/list_users",
      "zoom/list_recordings",
      "zoom/get_meeting_recordings",
      "zoom/list_meetings",
      "zoom/get_meeting",
      "zoom/create_meeting",
      "zoom/get_meeting_participants",
    ],
    toolScopeRequirements: {
      "zoom/create_meeting": ["meeting:write:meeting:admin"],
    },
    implemented: true,
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
    tools: ["github/list_repos", "github/get_repo", "github/get_file_contents", "github/list_issues", "github/create_issue", "github/git_push_repo", "github/create_pull_request", "github/create_repo"],
    toolScopeRequirements: {
      "github/create_issue": ["repo"],
      "github/git_push_repo": ["repo"],
      "github/create_pull_request": ["repo"],
      "github/create_repo": ["repo"],
    },
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
    authTypes: ["oauth", "service_account"],
    helpText: "Connect your Google account for read-only Drive access. (Temporarily disabled: every useful Drive read scope — drive.readonly and drive.metadata.readonly — is a *restricted* scope that forces the annual CASA security assessment. Disabled for launch to stay CASA-free. Sheets data is still available via the Google Sheets connector.)",
    /** Where to register/manage an OAuth client (callback URL setup) */
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    // Drive read scopes (drive, drive.readonly, drive.metadata.readonly) are ALL
    // *restricted* (Google's current classification) → would force CASA. Disabled for
    // launch via implemented:false. drive.file below is the only non-restricted Drive
    // scope (app-created/picked files only) — the safe default if this is ever re-enabled
    // without taking on CASA. To restore full read access, switch to drive.readonly and
    // budget for restricted-scope verification + CASA.
    oauthScopes: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    dwdScopes: ["https://www.googleapis.com/auth/drive.file"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_drive/list_files", "google_drive/get_file", "google_drive/search"],
    implemented: false,
  },
  google_gsc: {
    key: "google_gsc",
    label: "Google Search Console",
    authTypes: ["oauth"],
    helpText: "Connect your Google account to access Search Console data for sites you own.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    // webmasters は readonly の上位互換。プロパティの追加・削除に要る。
    // 読むだけの用途では readonly で足りるが、両方を要求しても
    // Google 側の同意画面は「Search Console のデータの表示と管理」1項目にまとまる。
    oauthScopes: [
      "https://www.googleapis.com/auth/webmasters",
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
    helpText: "Connect your Google account to access GA4 properties, run Analytics Data API reports, and (with edit access) provision new properties and web data streams.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/analytics.edit",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_analytics/list_properties", "google_analytics/run_report", "google_analytics/list_data_streams", "google_analytics/create_property", "google_analytics/create_data_stream"],
    toolScopeRequirements: {
      "google_analytics/create_property": ["https://www.googleapis.com/auth/analytics.edit"],
      "google_analytics/create_data_stream": ["https://www.googleapis.com/auth/analytics.edit"],
    },
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
    tools: ["google_ads/list_accessible_customers", "google_ads/search", "google_ads/mutate", "google_ads/generate_keyword_ideas"],
    toolScopeRequirements: {
      "google_ads/mutate": ["https://www.googleapis.com/auth/adwords"],
    },
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
    toolScopeRequirements: {
      "yahoo_ads/mutate": ["yahooads"],
    },
    implemented: true,
  },
  meta_ads: {
    key: "meta_ads",
    label: "Meta Ads",
    authTypes: ["oauth"],
    helpText: "Connect a Facebook user with access to the Meta Ads account via Business Manager. grantry exchanges the login for a long-lived (~60 day) access token; reconnect when it expires. Requires a Meta app with the Marketing API and the ads_read / ads_management permissions.",
    oauthSetupUrl: "https://developers.facebook.com/apps",
    oauthAppOwner: "workspace",
    oauthClientAuthMethod: "CLIENT_SECRET_POST",
    oauthScopes: ["ads_read", "ads_management", "business_management"],
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    oauthTokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    tools: [
      "meta_ads/list_ad_accounts",
      "meta_ads/get_ad_account",
      "meta_ads/list_campaigns",
      "meta_ads/get_campaign",
      "meta_ads/list_ad_sets",
      "meta_ads/list_ads",
      "meta_ads/get_insights",
      "meta_ads/create_campaign",
      "meta_ads/update_campaign",
    ],
    toolScopeRequirements: {
      "meta_ads/create_campaign": ["ads_management"],
      "meta_ads/update_campaign": ["ads_management"],
    },
    implemented: true,
  },
  meta_ads_platform: {
    key: "meta_ads_platform",
    label: "Meta Ads (Grantry OAuth)",
    authTypes: ["oauth"],
    helpText: "Connect a Facebook user with access to the Meta Ads account via Business Manager using Grantry's reviewed Meta app. This read-only connection is for ad performance analysis; it does not create, edit, pause, or delete ads.",
    oauthAppOwner: "platform",
    oauthClientAuthMethod: "CLIENT_SECRET_POST",
    oauthScopes: ["ads_read"],
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    oauthTokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    tools: META_ADS_PLATFORM_READ_TOOLS,
    implemented: true,
  },
  gmail: {
    key: "gmail",
    label: "Gmail",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect Gmail to list, read, and send messages through the Gmail API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    // Send-only, CASA-free: gmail.send is a *sensitive* scope (verification, no CASA).
    // gmail.readonly AND gmail.metadata are both *restricted* scopes (Google's current
    // classification — confirmed in the Data Access console) that would force the annual
    // CASA security assessment, so both are omitted. Effect: send works; the list/get
    // tools below have no read scope and return 403.
    oauthScopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    dwdScopes: [
      "https://www.googleapis.com/auth/gmail.send",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["gmail/list_messages", "gmail/get_message", "gmail/send_message"],
    toolScopeRequirements: {
      "gmail/send_message": ["https://www.googleapis.com/auth/gmail.send"],
    },
    implemented: true,
  },
  youtube: {
    key: "youtube",
    label: "YouTube",
    authTypes: ["oauth"],
    helpText: "Connect the Google account that owns the YouTube channel. Read access lists channels, videos, playlists and runs searches; management access updates videos, manages playlists and starts resumable video uploads. Requires the youtube.force-ssl scope.",
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
      "youtube/create_upload_session",
      "youtube/create_playlist",
      "youtube/update_playlist",
      "youtube/delete_playlist",
      "youtube/add_playlist_item",
      "youtube/delete_playlist_item",
    ],
    toolScopeRequirements: {
      "youtube/update_video": ["https://www.googleapis.com/auth/youtube.force-ssl"],
      "youtube/create_upload_session": ["https://www.googleapis.com/auth/youtube.force-ssl"],
      "youtube/create_playlist": ["https://www.googleapis.com/auth/youtube.force-ssl"],
      "youtube/update_playlist": ["https://www.googleapis.com/auth/youtube.force-ssl"],
      "youtube/delete_playlist": ["https://www.googleapis.com/auth/youtube.force-ssl"],
      "youtube/add_playlist_item": ["https://www.googleapis.com/auth/youtube.force-ssl"],
      "youtube/delete_playlist_item": ["https://www.googleapis.com/auth/youtube.force-ssl"],
    },
    implemented: true,
  },
  hubspot: {
    key: "hubspot",
    label: "HubSpot",
    authTypes: ["pat", "oauth"],
    helpText: "Connect via OAuth, or paste a HubSpot Private App access token to access CRM and marketing email data. Marketing email APIs require HubSpot's content scope. For OAuth apps, configure content as an optional scope in HubSpot.",
    tokenUrl: "https://app.hubspot.com/private-apps",
    oauthSetupUrl: "https://app.hubspot.com/developer",
    // Must be a superset of the scopes marked "required" on the HubSpot OAuth
    // app (developer account) — HubSpot rejects the authorize request when any
    // app-required scope is missing from the `scope` param.
    oauthScopes: [
      "crm.objects.deals.read",
      "crm.objects.deals.write",
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "oauth",
      "crm.lists.read",
      "crm.lists.write",
      "crm.export",
      "crm.objects.marketing_events.read",
      "crm.objects.marketing_events.write",
      "automation",
      "automation.sequences.read",
      "automation.sequences.enrollments.write",
      "external_integrations.forms.access",
      "forms",
      "forms-uploaded-files",
    ],
    oauthOptionalScopes: ["content"],
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    oauthTokenUrl: "https://api.hubapi.com/oauth/v1/token",
    tools: [
      "hubspot/list_deals",
      "hubspot/get_contact",
      "hubspot/create_deal",
      "hubspot/list_marketing_emails",
      "hubspot/get_marketing_email",
      "hubspot/get_marketing_email_statistics",
      "hubspot/update_marketing_email",
      "hubspot/publish_marketing_email",
      "hubspot/list_flows",
      "hubspot/get_flow",
      "hubspot/update_flow",
    ],
    toolScopeRequirements: {
      "hubspot/create_deal": ["crm.objects.deals.write"],
      "hubspot/update_flow": ["automation"],
    },
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
  twenty: {
    key: "twenty",
    label: "Twenty CRM",
    authTypes: ["pat"],
    helpText: "Create an API key in Twenty under Settings > API & Webhooks and paste it here. It is sent as Authorization: Bearer to the Twenty Core REST API. Cloud workspaces use https://api.twenty.com; self-hosted instances enter their own server URL.",
    tokenUrl: "https://twenty.com/developers/section/api-and-webhooks/api",
    tools: ["twenty/list_objects", "twenty/metadata_request", "twenty/list_records", "twenty/get_record", "twenty/create_record", "twenty/update_record"],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, placeholder: "eyJhbGciOi..." },
      { key: "base_url", label: "Server URL", required: false, placeholder: "https://api.twenty.com" },
    ],
    implemented: true,
  },
  monid: {
    key: "monid",
    label: "Monid",
    authTypes: ["pat"],
    helpText: "Create an API key at https://app.monid.ai/access/api-keys and paste it here (starts with monid_live_). It is sent as Authorization: Bearer to the Monid API. Monid is pay-per-use: discover -> inspect -> run against hundreds of data endpoints. monid/run spends wallet balance.",
    tokenUrl: "https://app.monid.ai/access/api-keys",
    tools: ["monid/whoami", "monid/list_workspaces", "monid/discover", "monid/inspect", "monid/run", "monid/list_runs", "monid/get_run", "monid/stop_run", "monid/get_balance", "monid/list_activities"],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, placeholder: "monid_live_..." },
      { key: "base_url", label: "Base URL", required: false, placeholder: "https://api.monid.ai" },
    ],
    implemented: true,
  },
  calendly: {
    key: "calendly",
    label: "Calendly",
    authTypes: ["pat"],
    helpText: "Create a Personal Access Token at Calendly > Integrations & apps > API & webhooks and paste it here. It is sent as Authorization: Bearer to the Calendly v2 API. List tools auto-resolve your user URI from /users/me; pass organization to query org-wide events.",
    tokenUrl: "https://calendly.com/integrations/api_webhooks",
    tools: [
      "calendly/get_me",
      "calendly/list_event_types",
      "calendly/list_events",
      "calendly/get_event",
      "calendly/list_invitees",
      "calendly/cancel_event",
    ],
    implemented: true,
  },
  jicoo: {
    key: "jicoo",
    label: "Jicoo",
    authTypes: ["pat"],
    helpText: "Create an API key in the Jicoo dashboard (developer settings) and paste it here. It is sent as the x-jicoo-api-key header to the Jicoo REST API v1. Covers teams, event types, availability, and bookings (list/get/update/cancel). Available on all plans.",
    tokenUrl: "https://www.jicoo.com/dashboard",
    tools: [
      "jicoo/get_me",
      "jicoo/list_teams",
      "jicoo/list_event_types",
      "jicoo/get_event_type",
      "jicoo/list_available_schedules",
      "jicoo/list_bookings",
      "jicoo/get_booking",
      "jicoo/update_booking",
      "jicoo/cancel_booking",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true },
    ],
    implemented: true,
  },
  firecrawl: {
    key: "firecrawl",
    label: "Firecrawl",
    authTypes: ["pat"],
    helpText: "Create an API key in the Firecrawl dashboard (https://www.firecrawl.dev/app/api-keys) and paste it here (starts with fc-). It is sent as Authorization: Bearer to the Firecrawl REST API v2. Covers scrape, crawl (start/status/cancel), map, search, extract (start/status), and team credit usage.",
    tokenUrl: "https://www.firecrawl.dev/app/api-keys",
    tools: [
      "firecrawl/scrape",
      "firecrawl/crawl",
      "firecrawl/get_crawl_status",
      "firecrawl/cancel_crawl",
      "firecrawl/map",
      "firecrawl/search",
      "firecrawl/extract",
      "firecrawl/get_extract_status",
      "firecrawl/get_credit_usage",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true },
    ],
    implemented: true,
  },
  dataforseo: {
    key: "dataforseo",
    label: "DataForSEO",
    authTypes: ["pat"],
    helpText: "Create API credentials at https://app.dataforseo.com/api-access and paste the API login (email) plus the API password. They are sent as HTTP Basic auth to the DataForSEO v3 API. Covers Google SERP, keyword search volume and ideas, DataForSEO Labs (ranked keywords, domain rank overview, competitors), backlinks, and OnPage instant checks. Calls are billed per request against your DataForSEO balance; dataforseo/get_user_data reports the balance and rate limits.",
    tokenUrl: "https://app.dataforseo.com/api-access",
    tools: [
      "dataforseo/get_user_data",
      "dataforseo/list_locations",
      "dataforseo/serp_google_organic",
      "dataforseo/keyword_search_volume",
      "dataforseo/keyword_ideas",
      "dataforseo/ranked_keywords",
      "dataforseo/domain_rank_overview",
      "dataforseo/competitors_domain",
      "dataforseo/backlinks_summary",
      "dataforseo/backlinks_list",
      "dataforseo/referring_domains",
      "dataforseo/on_page_instant",
    ],
    credentialFields: [
      { key: "login", label: "API login", required: true, placeholder: "you@example.com", hint: "The API login shown at app.dataforseo.com/api-access (Basic auth username)." },
      { key: "password", label: "API password", required: true, secret: true, hint: "The API password from the same page - not your dashboard password." },
    ],
    implemented: true,
  },
  timerex: {
    key: "timerex",
    label: "TimeRex",
    authTypes: ["pat"],
    helpText: "Create a team API key in TimeRex at ダッシュボード > チーム設定 > デベロッパーツール > TimeRex 日程調整API and paste it here (64 characters). It is sent as the x-api-key header. API-key access is scoped to the issuing team: teams, calendars, confirmed events, cancellation, and one-time scheduling URLs.",
    tokenUrl: "https://timerex.net/",
    tools: [
      "timerex/get_primary_team",
      "timerex/list_teams",
      "timerex/get_team",
      "timerex/list_calendars",
      "timerex/get_calendar",
      "timerex/list_calendar_events",
      "timerex/get_event",
      "timerex/cancel_event",
      "timerex/create_one_time_url",
      "timerex/get_one_time_url",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, hint: "64桁の半角英数字。チーム設定 > デベロッパーツール で発行。" },
    ],
    implemented: true,
  },
  acuity: {
    key: "acuity",
    label: "Acuity Scheduling",
    authTypes: ["pat"],
    helpText: "Find your numeric User ID and API key in Acuity (Squarespace Scheduling) under Integrations > API, and enter both. The API uses Basic auth (User ID + API key). Covers appointments, appointment types, calendars, and availability.",
    tokenUrl: "https://secure.acuityscheduling.com/app.php?action=settings&key=api",
    tools: [
      "acuity/get_me",
      "acuity/list_calendars",
      "acuity/list_appointment_types",
      "acuity/list_appointments",
      "acuity/get_appointment",
      "acuity/list_availability_times",
      "acuity/cancel_appointment",
    ],
    credentialFields: [
      { key: "user_id", label: "User ID", required: true, placeholder: "12345678", hint: "Numeric User ID from Integrations > API (Basic auth username)." },
      { key: "api_key", label: "API key", required: true, secret: true },
    ],
    implemented: true,
  },
  calcom: {
    key: "calcom",
    label: "Cal.com",
    authTypes: ["pat"],
    helpText: "Create an API key at Cal.com Settings > Security > API keys (cal_live_...) and paste it here. It is sent as Authorization: Bearer to the Cal.com v2 API; the connector adds the required cal-api-version header per endpoint.",
    tokenUrl: "https://app.cal.com/settings/developer/api-keys",
    tools: [
      "calcom/get_me",
      "calcom/list_event_types",
      "calcom/list_schedules",
      "calcom/list_bookings",
      "calcom/get_booking",
      "calcom/cancel_booking",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, placeholder: "cal_live_..." },
    ],
    implemented: true,
  },
  youcanbookme: {
    key: "youcanbookme",
    label: "YouCanBook.me",
    authTypes: ["pat"],
    helpText: "Generate your account API key at My Account > Security in the YouCanBook.me dashboard, and enter it with the account owner's email. The API uses Basic auth (email + API key). If you sign in to YouCanBook.me via Google/SSO, also enter your Account ID (shown at My Account) — SSO accounts need it for account-level endpoints. Covers booking pages (profiles), bookings query/cancel, and a generic /v1 passthrough.",
    tokenUrl: "https://app.youcanbook.me/",
    tools: [
      "youcanbookme/get_account",
      "youcanbookme/list_profiles",
      "youcanbookme/get_profile",
      "youcanbookme/query_bookings",
      "youcanbookme/get_booking",
      "youcanbookme/update_booking",
      "youcanbookme/cancel_booking",
    ],
    credentialFields: [
      { key: "account_email", label: "Account email", required: true, placeholder: "you@example.com", hint: "Email of the YouCanBook.me account owner (Basic auth username)." },
      { key: "api_key", label: "API key", required: true, secret: true, placeholder: "ak_..." },
      { key: "account_id", label: "Account ID", required: false, placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", hint: "Shown at https://app.youcanbook.me/#/account. Required for Google/SSO logins (their /v1/account lookup 404s); lets query_bookings resolve the account automatically." },
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
  apollo: {
    key: "apollo",
    label: "Apollo",
    authTypes: ["pat"],
    helpText: "Create an API key in Apollo at Settings > Integrations > API. Paste it here — it is sent in the X-Api-Key header to the Apollo REST API. People/organization search and enrichment consume credits; check your plan's API access.",
    tokenUrl: "https://app.apollo.io/#/settings/integrations/api",
    tools: [
      "apollo/health",
      "apollo/search_people",
      "apollo/enrich_person",
      "apollo/search_organizations",
      "apollo/enrich_organization",
      "apollo/search_contacts",
      "apollo/create_contact",
      "apollo/update_contact",
      "apollo/search_sequences",
      "apollo/add_contacts_to_sequence",
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
  smartlead: {
    key: "smartlead",
    label: "Smartlead",
    authTypes: ["pat"],
    helpText: "Paste a Smartlead API key from Settings > API key. It is sent as the api_key query parameter to the Smartlead API.",
    tokenUrl: "https://app.smartlead.ai/app/settings/profile",
    tools: [
      "smartlead/check_connection",
      "smartlead/list_campaigns",
      "smartlead/get_campaign",
      "smartlead/create_campaign",
      "smartlead/update_campaign_status",
      "smartlead/save_sequence",
      "smartlead/add_leads_to_campaign",
      "smartlead/list_campaign_leads",
      "smartlead/get_campaign_analytics",
      "smartlead/get_campaign_statistics",
      "smartlead/get_message_history",
      "smartlead/list_email_accounts",
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
  channel_talk: {
    key: "channel_talk",
    label: "Channel Talk",
    authTypes: ["pat"],
    helpText: "Create Open API credentials in the Channel desk under Settings > Security > API, then enter the Access Key and Access Secret. They are sent as the x-access-key and x-access-secret headers.",
    tokenUrl: "https://developers.channel.io/docs/open-api-keys",
    tools: [
      "channel_talk/list_managers",
      "channel_talk/get_manager",
      "channel_talk/list_user_chats",
      "channel_talk/get_user_chat",
      "channel_talk/list_messages",
      "channel_talk/send_message",
      "channel_talk/get_user",
    ],
    credentialFields: [
      { key: "accessKey", label: "Access Key", required: true, placeholder: "e.g. 6a43c75f02b923b300c4" },
      { key: "accessSecret", label: "Access Secret", required: true, secret: true },
    ],
    implemented: true,
  },
  channel_talk_documents: {
    key: "channel_talk_documents",
    label: "Channel Talk Documents",
    authTypes: ["pat"],
    helpText: "Manage Channel Talk Documents (help-center articles). This uses a SEPARATE credential from the chat Open API: create a Documents space, then issue its API key in the space settings and enter the Access Key + Access Secret. They are sent as HTTP Basic auth to document-api.channel.io. Note: v1 supports create/list/get/delete of articles and read of topics — there is no update endpoint.",
    tokenUrl: "https://developers.channel.io/docs/documents-open-api-welcome",
    tools: [
      "channel_talk_documents/list_articles",
      "channel_talk_documents/get_article",
      "channel_talk_documents/create_article",
      "channel_talk_documents/delete_article",
      "channel_talk_documents/list_topics",
      "channel_talk_documents/get_topic",
    ],
    credentialFields: [
      { key: "accessKey", label: "Access Key", required: true, placeholder: "Documents space API key" },
      { key: "accessSecret", label: "Access Secret", required: true, secret: true },
    ],
    implemented: true,
  },
  railway: {
    key: "railway",
    label: "Railway Project Token",
    authTypes: ["pat"],
    helpText: "Paste a Railway Project Token from Project Settings > Tokens. Project tokens are scoped to one project environment.",
    tokenUrl: "https://railway.com",
    tools: [
      "railway/graphql",
      "railway/project_token_info",
      "railway/introspect_schema",
    ],
    implemented: true,
  },
  railway_api: {
    key: "railway_api",
    label: "Railway API Token",
    authTypes: ["pat"],
    helpText: "Paste a Railway Account or Workspace API Token from Account Settings > Tokens. It is sent as Authorization: Bearer and can call Railway GraphQL APIs allowed by that token.",
    tokenUrl: "https://railway.com/account/tokens",
    tools: [
      "railway/graphql",
      "railway/introspect_schema",
    ],
    implemented: true,
  },
  freee: {
    key: "freee",
    label: "freee会計",
    authTypes: ["oauth"],
    helpText: "Connect your freee account via a workspace-owned OAuth app. Register an application in the freee developers console, paste its client_id/client_secret here, then connect. grantry requests read/write access to the accounting data (deals, partners, account items, trial balances) for the companies this user can access. Access tokens expire after a few hours; grantry refreshes them with the stored refresh token.",
    oauthSetupUrl: "https://app.secure.freee.co.jp/developers/applications",
    oauthAppOwner: "workspace",
    oauthScopes: ["read", "write"],
    authorizeUrl: "https://accounts.secure.freee.co.jp/public_api/authorize",
    oauthTokenUrl: "https://accounts.secure.freee.co.jp/public_api/token",
    tools: [
      "freee/get_me",
      "freee/list_companies",
      "freee/list_deals",
      "freee/get_deal",
      "freee/create_deal",
      "freee/list_account_items",
      "freee/list_partners",
      "freee/create_partner",
      "freee/trial_pl",
      "freee/trial_bs",
    ],
    toolScopeRequirements: {
      "freee/create_deal": ["write"],
      "freee/create_partner": ["write"],
    },
    implemented: true,
  },
  moneyforward: {
    key: "moneyforward",
    label: "マネーフォワード クラウド会計",
    authTypes: ["oauth"],
    helpText: "Connect Money Forward Cloud Accounting via a workspace-owned OAuth app. Cloud Accounting API uses OAuth 2.0; API key authentication is not supported for this provider.",
    oauthSetupUrl: "https://app-portal.moneyforward.com/",
    oauthAppOwner: "workspace",
    oauthClientAuthMethod: "CLIENT_SECRET_BASIC",
    oauthScopes: [
      "mfc/accounting/offices.read",
      "mfc/accounting/accounts.read",
      "mfc/accounting/departments.read",
      "mfc/accounting/taxes.read",
      "mfc/accounting/journal.read",
      "mfc/accounting/report.read",
      "mfc/accounting/trade_partners.read",
      "mfc/accounting/connected_account.read",
    ],
    authorizeUrl: "https://api.biz.moneyforward.com/authorize",
    oauthTokenUrl: "https://api.biz.moneyforward.com/token",
    tools: [
      "moneyforward/accounting_get_office",
      "moneyforward/accounting_list_accounts",
      "moneyforward/accounting_list_departments",
      "moneyforward/accounting_list_taxes",
      "moneyforward/accounting_list_sub_accounts",
      "moneyforward/accounting_list_journals",
      "moneyforward/accounting_get_journal",
      "moneyforward/accounting_list_trade_partners",
      "moneyforward/accounting_trial_balance_bs",
      "moneyforward/accounting_trial_balance_pl",
      "moneyforward/accounting_transition_bs",
      "moneyforward/accounting_transition_pl",
      "moneyforward/accounting_list_term_settings",
      "moneyforward/accounting_request",
    ],
    implemented: true,
  },
  google_maps: {
    key: "google_maps",
    label: "Google Maps",
    authTypes: ["pat"],
    helpText: "Paste a Google Maps Platform API key from Google Cloud Console > APIs & Services > Credentials. Enable the Geocoding, Places, Directions, and Distance Matrix APIs for the key. The key is sent as the `key` query parameter.",
    tokenUrl: "https://console.cloud.google.com/google/maps-apis/credentials",
    tools: [
      "google_maps/geocode",
      "google_maps/reverse_geocode",
      "google_maps/place_search",
      "google_maps/place_details",
      "google_maps/directions",
      "google_maps/distance_matrix",
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
  cloudsign: {
    key: "cloudsign",
    label: "CloudSign",
    authTypes: ["pat"],
    helpText: "Paste your CloudSign Web API client_id (issued by CloudSign to your organization). grantry exchanges it for a short-lived access token automatically — you do not paste an access token. To target the sandbox, paste JSON like {\"client_id\":\"...\",\"environment\":\"sandbox\"} instead.",
    tokenUrl: "https://help.cloudsign.jp/ja/articles/936884",
    tools: [
      "cloudsign/list_documents",
      "cloudsign/get_document",
      "cloudsign/create_document",
      "cloudsign/update_document",
      "cloudsign/send_document",
      "cloudsign/delete_document",
      "cloudsign/add_participant",
      "cloudsign/update_participant",
      "cloudsign/delete_participant",
    ],
    implemented: true,
  },
  slack: {
    key: "slack",
    label: "Slack",
    // Both PAT (paste a Bot User OAuth Token) and OAuth (authorize an installed
    // Slack app) are supported — users pick at the wizard.
    authTypes: ["pat", "oauth"],
    helpText: "Paste a Bot User OAuth Token (starts with xoxb-) from your Slack app's OAuth & Permissions page, or click Connect with OAuth to install the app and authorize it. Required Bot Token Scopes: channels:read, groups:read, channels:history, groups:history, chat:write, users:read. For channel creation and inviting members add channels:manage, channels:write.invites, mpim:write, and (for Slack Connect external invites) conversations.connect:manage. The token is sent as Authorization: Bearer to the Slack Web API.",
    tokenUrl: "https://api.slack.com/apps",
    // OAuth uses Slack's v2 flow. The redirect/callback URL to register in the
    // app's OAuth & Permissions page is https://app.grantry.ai/oauth/slack/callback.
    oauthSetupUrl: "https://api.slack.com/apps",
    oauthScopes: ["channels:read", "groups:read", "channels:history", "groups:history", "chat:write", "users:read", "channels:manage", "channels:write.invites", "mpim:write", "conversations.connect:manage"],
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    oauthTokenUrl: "https://slack.com/api/oauth.v2.access",
    tools: [
      "slack/auth_test",
      "slack/list_channels",
      "slack/get_channel",
      "slack/list_messages",
      "slack/get_thread",
      "slack/post_message",
      "slack/update_message",
      "slack/create_channel",
      "slack/invite_members",
      "slack/open_group_dm",
      "slack/invite_shared",
      "slack/list_users",
      "slack/get_user",
    ],
    toolScopeRequirements: {
      "slack/post_message": ["chat:write"],
      "slack/update_message": ["chat:write"],
      "slack/create_channel": ["channels:manage"],
      "slack/invite_members": ["channels:write.invites"],
      "slack/open_group_dm": ["mpim:write"],
      "slack/invite_shared": ["conversations.connect:manage"],
    },
    implemented: true,
  },
  reddit: {
    key: "reddit",
    label: "Reddit",
    authTypes: ["oauth"],
    helpText: "Register a 'web app' at reddit.com/prefs/apps with the redirect URI set to this app's /oauth/reddit/callback. Connect grants read access plus posting, commenting, and voting as the authorized account.",
    oauthSetupUrl: "https://www.reddit.com/prefs/apps",
    oauthClientAuthMethod: "CLIENT_SECRET_BASIC",
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
    toolScopeRequirements: {
      "reddit/submit_post": ["submit"],
      "reddit/submit_comment": ["submit"],
      "reddit/vote": ["vote"],
    },
    implemented: true,
  },
  x: {
    key: "x",
    label: "X",
    authTypes: ["oauth"],
    helpText: "Create an OAuth 2.0 app in the X developer portal (Confidential client, type Web App) with the callback URL set to this app's /oauth/x/callback. Connect grants read access plus posting (with images), and deleting tweets as the authorized account.",
    oauthSetupUrl: "https://developer.x.com/en/portal/dashboard",
    oauthClientAuthMethod: "CLIENT_SECRET_BASIC",
    oauthScopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
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
    toolScopeRequirements: {
      "x/post_tweet": ["tweet.write"],
      "x/delete_tweet": ["tweet.write"],
    },
    implemented: true,
  },
  discord: {
    key: "discord",
    label: "Discord",
    authTypes: ["pat"],
    helpText: "Create an application at discord.com/developers/applications, add a Bot, and paste its Bot Token. Invite the bot to your server with the needed permissions (and enable the Server Members Intent for list_members). The token is sent as Authorization: Bot to the Discord REST API.",
    tokenUrl: "https://discord.com/developers/applications",
    tools: [
      "discord/get_me",
      "discord/list_guilds",
      "discord/get_guild",
      "discord/list_channels",
      "discord/get_channel",
      "discord/list_messages",
      "discord/get_message",
      "discord/send_message",
      "discord/edit_message",
      "discord/delete_message",
      "discord/list_members",
      "discord/get_user",
    ],
    implemented: true,
  },
  line: {
    key: "line",
    label: "LINE",
    authTypes: ["pat"],
    helpText: "Create a Messaging API channel in the LINE Developers console and paste its long-lived Channel Access Token (Messaging API tab > Channel access token). The token is sent as Authorization: Bearer to the LINE Messaging API.",
    tokenUrl: "https://developers.line.biz/console/",
    tools: [
      "line/get_bot_info",
      "line/get_quota",
      "line/get_quota_consumption",
      "line/get_profile",
      "line/push_message",
      "line/reply_message",
      "line/multicast",
      "line/broadcast",
      "line/get_group_summary",
      "line/get_group_member_count",
      "line/get_group_member_profile",
    ],
    implemented: true,
  },
  facebook_messenger: {
    key: "facebook_messenger",
    label: "Facebook Messenger",
    authTypes: ["pat"],
    helpText:
      "Create a Meta app with the Messenger product, connect a Facebook Page, and generate a Page Access Token (Messenger > Settings > Access Tokens). Paste the Page Access Token here — a long-lived token is recommended. It is sent as Authorization: Bearer to the Graph API. Sending is bound by Messenger's 24-hour messaging window; outside it you must pass a message tag.",
    tokenUrl: "https://developers.facebook.com/apps",
    tools: [
      "facebook_messenger/get_page",
      "facebook_messenger/get_user_profile",
      "facebook_messenger/list_conversations",
      "facebook_messenger/get_conversation_messages",
      "facebook_messenger/send_message",
      "facebook_messenger/send_sender_action",
    ],
    implemented: true,
  },
  airtable: {
    key: "airtable",
    label: "Airtable",
    authTypes: ["pat"],
    helpText: "Create a Personal Access Token at airtable.com/create/tokens with the data.records:read, data.records:write, and schema.bases:read scopes, then paste the token here. It is sent as Authorization: Bearer.",
    tokenUrl: "https://airtable.com/create/tokens",
    tools: ["airtable/list_bases", "airtable/list_tables", "airtable/list_records", "airtable/get_record", "airtable/create_record", "airtable/update_record", "airtable/delete_record"],
    implemented: true,
  },
  seminar_portal: {
    key: "seminar_portal",
    label: "Seminar Portal",
    authTypes: ["pat"],
    helpText: "Paste the portal's agent API key (AGENT_API_KEYS on the deployment). It is sent as Authorization: Bearer to /api/v1. A Japanese IT/SaaS/AI seminar aggregator: search upcoming seminars, read one, or rank them against a person's technologies. Call list_tech first — interests must be canonical names, and it reports how many upcoming seminars each has. To point at another deployment, paste JSON like {\"api_key\":\"...\",\"base_url\":\"https://example.com\"}.",
    tools: [
      "seminar_portal/list_tech",
      "seminar_portal/search",
      "seminar_portal/get",
      "seminar_portal/recommend",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, placeholder: "Paste the portal's agent API key" },
      { key: "base_url", label: "Portal URL", required: false, placeholder: "https://web-production-5bf84b.up.railway.app", hint: "Only when running your own deployment." },
    ],
    implemented: true,
  },
  intent_engine: {
    key: "intent_engine",
    label: "intent-engine",
    authTypes: ["pat"],
    helpText: "Paste the deployment's API token (API_TOKEN on the intent-engine service). It is sent as Authorization: Bearer to /api. A Japanese corporate intent-signal warehouse: subsidy adoptions plus the monthly count of social-insurance-covered employees per company. get_company returns one company's signals and headcount history in a single call. To point at another deployment, paste JSON like {\"api_token\":\"...\",\"base_url\":\"https://example.com\"}.",
    tools: [
      "intent_engine/health",
      "intent_engine/list_signal_types",
      "intent_engine/search_signals",
      "intent_engine/get_company",
      "intent_engine/stacked_companies",
      "intent_engine/headcount_changes",
      "intent_engine/insured_summary",
    ],
    credentialFields: [
      { key: "api_token", label: "API token", required: true, secret: true, placeholder: "Paste the intent-engine API token" },
      { key: "base_url", label: "intent-engine URL", required: false, placeholder: "https://intent-engine-production-f43a.up.railway.app", hint: "Only when running your own deployment." },
    ],
    implemented: true,
  },
  nocodb: {
    key: "nocodb",
    label: "NocoDB",
    authTypes: ["pat"],
    helpText: "Create an API token in NocoDB under Account Settings > Tokens and paste it here. It is sent as the xc-token header to the NocoDB v2 API. NocoDB Cloud uses https://app.nocodb.com; self-hosted instances enter their own server URL.",
    tokenUrl: "https://app.nocodb.com/#/account/tokens",
    tools: [
      "nocodb/get_me",
      "nocodb/list_bases",
      "nocodb/list_tables",
      "nocodb/get_table",
      "nocodb/list_views",
      "nocodb/list_records",
      "nocodb/count_records",
      "nocodb/get_record",
      "nocodb/create_records",
      "nocodb/update_records",
      "nocodb/delete_records",
    ],
    credentialFields: [
      { key: "api_token", label: "API token", required: true, secret: true, placeholder: "Paste the NocoDB API token" },
      { key: "base_url", label: "Server URL", required: false, placeholder: "https://app.nocodb.com", hint: "Self-hosted instances only. Leave blank for NocoDB Cloud." },
    ],
    implemented: true,
  },
  langgraph: {
    key: "langgraph",
    label: "LangGraph Platform",
    authTypes: ["pat"],
    helpText: "Paste a LangSmith API key (Settings > API keys) plus the deployment URL of your LangGraph Server, e.g. https://my-agent-abc123.us.langgraph.app. The key is sent as the x-api-key header. Each deployment has its own URL, so one connection targets one deployment.",
    tokenUrl: "https://smith.langchain.com/settings",
    tools: [
      "langgraph/get_info",
      "langgraph/search_assistants",
      "langgraph/get_assistant",
      "langgraph/get_assistant_schemas",
      "langgraph/search_threads",
      "langgraph/create_thread",
      "langgraph/get_thread",
      "langgraph/get_thread_state",
      "langgraph/get_thread_history",
      "langgraph/list_runs",
      "langgraph/get_run",
      "langgraph/create_run",
      "langgraph/run_wait",
      "langgraph/cancel_run",
      "langgraph/search_crons",
      "langgraph/delete_cron",
      "langgraph/search_store_items",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, placeholder: "lsv2_pt_…" },
      { key: "base_url", label: "Deployment URL", required: true, placeholder: "https://my-agent-abc123.us.langgraph.app", hint: "The LangGraph Server URL shown on the deployment page." },
    ],
    implemented: true,
  },
  langsmith: {
    key: "langsmith",
    label: "LangSmith",
    authTypes: ["pat"],
    helpText: "Create an API key in LangSmith under Settings > API keys and paste it here. It is sent as the X-Api-Key header to the LangSmith /api/v1 API. The US cloud (https://api.smith.langchain.com) is the default; the EU region and self-hosted installations enter their own API URL.",
    tokenUrl: "https://smith.langchain.com/settings",
    tools: [
      "langsmith/list_workspaces",
      "langsmith/list_projects",
      "langsmith/get_project",
      "langsmith/query_runs",
      "langsmith/get_run",
      "langsmith/list_datasets",
      "langsmith/get_dataset",
      "langsmith/list_examples",
      "langsmith/create_examples",
      "langsmith/list_feedback",
      "langsmith/create_feedback",
      "langsmith/list_prompts",
      "langsmith/get_prompt",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, placeholder: "lsv2_pt_…" },
      { key: "base_url", label: "API URL", required: false, placeholder: "https://api.smith.langchain.com", hint: "EU region: https://eu.api.smith.langchain.com. Leave blank for the US cloud." },
    ],
    implemented: true,
  },
  linear: {
    key: "linear",
    label: "Linear",
    authTypes: ["pat"],
    helpText: "Create a Personal API Key at Linear Settings > Account > API and paste it here. Linear keys are sent directly as the Authorization header value (no Bearer prefix).",
    tokenUrl: "https://linear.app/settings/api",
    tools: ["linear/get_me", "linear/list_teams", "linear/list_issues", "linear/get_issue", "linear/search_issues", "linear/create_issue", "linear/update_issue"],
    implemented: true,
  },
  sendgrid: {
    key: "sendgrid",
    label: "SendGrid",
    authTypes: ["pat"],
    helpText: "Create an API Key in the SendGrid dashboard (Settings > API Keys) with Mail Send + Stats access, then paste it here. It is sent as Authorization: Bearer.",
    tokenUrl: "https://app.sendgrid.com/settings/api_keys",
    tools: ["sendgrid/send_email", "sendgrid/list_templates", "sendgrid/get_template", "sendgrid/get_stats", "sendgrid/list_bounces", "sendgrid/list_api_keys"],
    implemented: true,
  },
  vercel: {
    key: "vercel",
    label: "Vercel",
    authTypes: ["pat"],
    helpText: "Create a token at Vercel Account Settings > Tokens and paste it here. It is sent as Authorization: Bearer. Team-scoped tokens only see that team's resources; pass team_id where supported.",
    tokenUrl: "https://vercel.com/account/tokens",
    tools: ["vercel/get_user", "vercel/list_projects", "vercel/get_project", "vercel/list_deployments", "vercel/get_deployment", "vercel/list_domains"],
    implemented: true,
  },
  stripe: {
    key: "stripe",
    label: "Stripe",
    authTypes: ["pat"],
    helpText: "Paste a Stripe secret key (starts with sk_live_ or sk_test_) from the Stripe dashboard. It is sent as Authorization: Bearer.",
    tokenUrl: "https://dashboard.stripe.com/apikeys",
    tools: ["stripe/list_customers", "stripe/get_customer", "stripe/create_customer", "stripe/list_charges", "stripe/list_payment_intents", "stripe/create_payment_intent", "stripe/list_invoices"],
    implemented: true,
  },
  webflow: {
    key: "webflow",
    label: "Webflow",
    authTypes: ["pat"],
    helpText: "Generate a Site or Workspace API token in Webflow > Account Settings > API Access and paste it here. It is sent as Authorization: Bearer to the Webflow Data API v2.",
    tokenUrl: "https://webflow.com/dashboard/account/authorizations",
    tools: ["webflow/list_sites", "webflow/get_site", "webflow/list_collections", "webflow/list_items", "webflow/create_item", "webflow/publish_site"],
    implemented: true,
  },
  intercom: {
    key: "intercom",
    label: "Intercom",
    authTypes: ["pat"],
    helpText: "Create an Access Token in Intercom Settings > Developers > your app > Authentication, then paste it here. It is sent as Authorization: Bearer.",
    tokenUrl: "https://app.intercom.com/a/apps/_/developer-hub",
    tools: ["intercom/get_me", "intercom/list_contacts", "intercom/get_contact", "intercom/search_contacts", "intercom/create_contact", "intercom/list_conversations", "intercom/reply_conversation"],
    implemented: true,
  },
  customerio: {
    key: "customerio",
    label: "Customer.io",
    authTypes: ["pat"],
    helpText: "Paste your Customer.io App API key. It is sent as Authorization: Bearer. For the EU region, paste JSON like {\"token\":\"...\",\"region\":\"eu\"}.",
    tokenUrl: "https://fly.customer.io/settings/api_credentials",
    tools: ["customerio/send_transactional", "customerio/list_campaigns", "customerio/get_campaign", "customerio/get_campaign_metrics", "customerio/get_customer", "customerio/list_newsletters"],
    implemented: true,
  },
  mailchimp: {
    key: "mailchimp",
    label: "Mailchimp",
    authTypes: ["pat"],
    helpText: "Paste your Mailchimp API key from Account > Extras > API keys. It must include the datacenter suffix, e.g. abc123-us21. It is sent via HTTP Basic auth.",
    tokenUrl: "https://admin.mailchimp.com/account/api/",
    tools: ["mailchimp/ping", "mailchimp/list_lists", "mailchimp/get_list", "mailchimp/list_members", "mailchimp/add_member", "mailchimp/list_campaigns"],
    implemented: true,
  },
  zendesk: {
    key: "zendesk",
    label: "Zendesk",
    authTypes: ["pat"],
    helpText: "Enter your Zendesk subdomain, agent email, and API token. Create an API token in Admin Center > Apps and integrations > APIs > Zendesk API.",
    tokenUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858",
    tools: ["zendesk/list_tickets", "zendesk/get_ticket", "zendesk/create_ticket", "zendesk/update_ticket", "zendesk/add_comment", "zendesk/search", "zendesk/list_users"],
    credentialFields: [
      { key: "subdomain", label: "Subdomain", required: true, placeholder: "acme (from acme.zendesk.com)" },
      { key: "email", label: "Agent email", required: true, placeholder: "you@example.com" },
      { key: "token", label: "API token", required: true, secret: true },
    ],
    implemented: true,
  },
  wordpress: {
    key: "wordpress",
    label: "WordPress",
    authTypes: ["pat"],
    helpText: "Enter your site URL, username, and an Application Password. Create one in wp-admin > Users > Profile > Application Passwords.",
    tokenUrl: "https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/",
    tools: ["wordpress/list_posts", "wordpress/get_post", "wordpress/create_post", "wordpress/update_post", "wordpress/list_pages", "wordpress/list_categories"],
    credentialFields: [
      { key: "site", label: "Site URL", required: true, placeholder: "https://blog.example.com" },
      { key: "username", label: "Username", required: true, placeholder: "admin" },
      { key: "app_password", label: "Application Password", required: true, secret: true, hint: "Create in wp-admin > Users > Profile > Application Passwords." },
    ],
    implemented: true,
  },
  shopify: {
    key: "shopify",
    label: "Shopify",
    authTypes: ["pat"],
    helpText: "Enter your shop domain and an Admin API access token. Create a custom app in Shopify Admin > Settings > Apps and sales channels > Develop apps.",
    tokenUrl: "https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/admin-api-access-tokens",
    tools: ["shopify/list_products", "shopify/get_product", "shopify/create_product", "shopify/list_orders", "shopify/get_order", "shopify/list_customers"],
    credentialFields: [
      { key: "shop", label: "Shop domain", required: true, placeholder: "acme.myshopify.com" },
      { key: "token", label: "Admin API access token", required: true, secret: true, placeholder: "shpat_..." },
    ],
    implemented: true,
  },
  supabase: {
    key: "supabase",
    label: "Supabase",
    authTypes: ["pat"],
    helpText: "Enter your Supabase project URL and a secret key (new sb_secret_… or a legacy service_role JWT). Find both in Project Settings > API. The key bypasses RLS — restrict this connection to a dedicated data store.",
    tokenUrl: "https://supabase.com/dashboard/project/_/settings/api-keys",
    tools: ["supabase/request", "supabase/check_connection", "supabase/list_capabilities"],
    credentialFields: [
      { key: "project_url", label: "Project URL", required: true, placeholder: "https://xxxx.supabase.co" },
      { key: "secret_key", label: "Secret key", required: true, secret: true, placeholder: "sb_secret_… or eyJ…" },
    ],
    implemented: true,
  },
  jira: {
    key: "jira",
    label: "Jira",
    authTypes: ["pat"],
    helpText: "Enter your Atlassian site, account email, and API token. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens.",
    tokenUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    tools: ["jira/search", "jira/get_issue", "jira/create_issue", "jira/update_issue", "jira/add_comment", "jira/list_projects", "jira/transition_issue"],
    credentialFields: [
      { key: "site", label: "Atlassian site", required: true, placeholder: "https://acme.atlassian.net" },
      { key: "email", label: "Account email", required: true, placeholder: "you@example.com" },
      { key: "token", label: "API token", required: true, secret: true },
    ],
    implemented: true,
  },
  salesforce: {
    key: "salesforce",
    label: "Salesforce",
    authTypes: ["pat"],
    helpText: "Enter your instance URL and an OAuth access token. Access tokens expire (default ~2h); re-enter a fresh one when needed.",
    tokenUrl: "https://login.salesforce.com",
    tools: ["salesforce/query", "salesforce/search", "salesforce/get_record", "salesforce/create_record", "salesforce/update_record", "salesforce/delete_record"],
    credentialFields: [
      { key: "instance_url", label: "Instance URL", required: true, placeholder: "https://acme.my.salesforce.com" },
      { key: "token", label: "OAuth access token", required: true, secret: true, hint: "Access tokens expire (default ~2h); re-paste a fresh one when needed." },
    ],
    implemented: true,
  },
  linkedin_ads: {
    key: "linkedin_ads",
    label: "LinkedIn Ads",
    authTypes: ["pat"],
    helpText: "Paste a LinkedIn OAuth access token (Bearer) from a Marketing Developer Platform app with r_ads/rw_ads scopes. Tokens expire after ~60 days and are not auto-refreshed here.",
    tokenUrl: "https://www.linkedin.com/developers/apps",
    tools: ["linkedin_ads/list_ad_accounts", "linkedin_ads/get_ad_account", "linkedin_ads/list_campaigns", "linkedin_ads/get_campaign", "linkedin_ads/get_analytics"],
    implemented: true,
  },
  tiktok_ads: {
    key: "tiktok_ads",
    label: "TikTok Ads",
    authTypes: ["pat"],
    helpText: "Paste a TikTok for Business access token from the TikTok Marketing API OAuth flow. It is sent as the Access-Token header (not Bearer).",
    tokenUrl: "https://business-api.tiktok.com/portal/",
    tools: ["tiktok_ads/get_user_info", "tiktok_ads/get_advertiser_info", "tiktok_ads/list_campaigns", "tiktok_ads/list_adgroups", "tiktok_ads/list_ads", "tiktok_ads/get_report"],
    implemented: true,
  },
  microsoft_ads: {
    key: "microsoft_ads",
    label: "Microsoft Ads",
    authTypes: ["pat"],
    helpText: "Enter your Microsoft Advertising developer token, OAuth access token, customer ID, and account ID. Microsoft Ads is SOAP-based; the access token is short-lived and must be refreshed externally.",
    tokenUrl: "https://learn.microsoft.com/advertising/guides/get-started",
    tools: ["microsoft_ads/get_user", "microsoft_ads/get_accounts_info"],
    credentialFields: [
      { key: "developer_token", label: "Developer token", required: true, secret: true },
      { key: "access_token", label: "OAuth access token", required: true, secret: true, hint: "Short-lived; refresh externally and re-paste when expired." },
      { key: "customer_id", label: "Customer ID", required: true },
      { key: "account_id", label: "Account ID", required: true },
    ],
    implemented: true,
  },
  aws: {
    key: "aws",
    label: "AWS",
    authTypes: ["pat"],
    helpText: "Enter your AWS access key ID and secret access key. Region defaults to us-east-1; session token is only needed for temporary credentials. Requests are signed with AWS SigV4.",
    tokenUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    tools: ["aws/get_caller_identity", "aws/s3_list_buckets", "aws/s3_list_objects"],
    credentialFields: [
      { key: "accessKeyId", label: "Access Key ID", required: true, placeholder: "AKIA..." },
      { key: "secretAccessKey", label: "Secret Access Key", required: true, secret: true },
      { key: "region", label: "Region", placeholder: "us-east-1 (default)" },
      { key: "sessionToken", label: "Session token", secret: true, hint: "Only for temporary credentials." },
    ],
    implemented: true,
  },
  snowflake: {
    key: "snowflake",
    label: "Snowflake",
    authTypes: ["pat"],
    helpText: "Enter your account identifier and a Programmatic Access Token. Warehouse, database, schema, and role are optional per-call defaults.",
    tokenUrl: "https://docs.snowflake.com/en/user-guide/programmatic-access-tokens",
    tools: ["snowflake/execute_statement", "snowflake/get_statement", "snowflake/cancel_statement"],
    credentialFields: [
      { key: "account", label: "Account identifier", required: true, placeholder: "orgname-accountname" },
      { key: "token", label: "Programmatic Access Token", required: true, secret: true },
      { key: "warehouse", label: "Warehouse", hint: "Optional per-call default." },
      { key: "database", label: "Database", hint: "Optional per-call default." },
      { key: "schema", label: "Schema", hint: "Optional per-call default." },
      { key: "role", label: "Role", hint: "Optional per-call default." },
    ],
    implemented: true,
  },
  google_calendar: {
    key: "google_calendar",
    label: "Google Calendar",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect your Google account to read calendars and events through the Calendar API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/userinfo.email"],
    dwdScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_calendar/list_calendars", "google_calendar/list_events", "google_calendar/get_event"],
    implemented: true,
  },
  google_sheets: {
    key: "google_sheets",
    label: "Google Sheets",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect your Google account to read and write spreadsheet values through the Sheets API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/userinfo.email"],
    dwdScopes: ["https://www.googleapis.com/auth/spreadsheets"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_sheets/get_spreadsheet", "google_sheets/get_values", "google_sheets/batch_get_values", "google_sheets/update_values", "google_sheets/append_values", "google_sheets/create_spreadsheet"],
    toolScopeRequirements: {
      "google_sheets/update_values": ["https://www.googleapis.com/auth/spreadsheets"],
      "google_sheets/append_values": ["https://www.googleapis.com/auth/spreadsheets"],
      "google_sheets/create_spreadsheet": ["https://www.googleapis.com/auth/spreadsheets"],
    },
    implemented: true,
  },
  google_slides: {
    key: "google_slides",
    label: "Google Slides",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect your Google account to read, create, and edit presentations through the Slides API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/presentations", "https://www.googleapis.com/auth/userinfo.email"],
    dwdScopes: ["https://www.googleapis.com/auth/presentations"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_slides/get_presentation", "google_slides/get_page", "google_slides/get_page_thumbnail", "google_slides/create_presentation", "google_slides/batch_update"],
    toolScopeRequirements: {
      "google_slides/create_presentation": ["https://www.googleapis.com/auth/presentations"],
      "google_slides/batch_update": ["https://www.googleapis.com/auth/presentations"],
    },
    implemented: true,
  },
  google_forms: {
    key: "google_forms",
    label: "Google Forms",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect your Google account to read, create, and edit forms and read form responses through the Forms API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/forms.body", "https://www.googleapis.com/auth/forms.responses.readonly", "https://www.googleapis.com/auth/userinfo.email"],
    dwdScopes: ["https://www.googleapis.com/auth/forms.body", "https://www.googleapis.com/auth/forms.responses.readonly"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_forms/get_form", "google_forms/create_form", "google_forms/batch_update", "google_forms/list_responses", "google_forms/get_response"],
    toolScopeRequirements: {
      "google_forms/create_form": ["https://www.googleapis.com/auth/forms.body"],
      "google_forms/batch_update": ["https://www.googleapis.com/auth/forms.body"],
      "google_forms/list_responses": ["https://www.googleapis.com/auth/forms.responses.readonly"],
      "google_forms/get_response": ["https://www.googleapis.com/auth/forms.responses.readonly"],
    },
    implemented: true,
  },
  google_tag_manager: {
    key: "google_tag_manager",
    label: "Google Tag Manager",
    authTypes: ["oauth"],
    helpText: "Connect your Google account to read Tag Manager accounts, containers, workspaces, and tags, and to create tags / create + publish container versions.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/tagmanager.readonly",
      "https://www.googleapis.com/auth/tagmanager.edit.containers",
      "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
      "https://www.googleapis.com/auth/tagmanager.publish",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: [
      "google_tag_manager/list_accounts",
      "google_tag_manager/list_containers",
      "google_tag_manager/get_container",
      "google_tag_manager/list_workspaces",
      "google_tag_manager/list_tags",
      "google_tag_manager/create_tag",
      "google_tag_manager/create_version",
      "google_tag_manager/publish_version",
    ],
    implemented: true,
  },
  google_cloud: {
    key: "google_cloud",
    label: "Google Cloud",
    authTypes: ["oauth"],
    helpText: "Connect your Google account to list Cloud projects/services, read Cloud Logging entries, and read Cloud Billing config + pricing catalog (read-only). Actual spend is not in the Billing API — enable BigQuery billing export and query it via the bigquery connector.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only", "https://www.googleapis.com/auth/userinfo.email"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: [
      "google_cloud/list_projects",
      "google_cloud/get_project",
      "google_cloud/list_services",
      "google_cloud/list_log_entries",
      "google_cloud/list_billing_accounts",
      "google_cloud/get_billing_account",
      "google_cloud/list_billing_account_projects",
      "google_cloud/get_project_billing_info",
      "google_cloud/list_billing_services",
      "google_cloud/list_skus",
    ],
    implemented: true,
  },
  google_admin: {
    key: "google_admin",
    label: "Google Admin",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect a Google Workspace administrator account to manage users, groups, group members, and org units through the Admin SDK Directory API. The connecting account must be a Workspace admin. For multi-tenant use, prefer Service Account (Domain-Wide Delegation).",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/admin.directory.user",
      "https://www.googleapis.com/auth/admin.directory.group",
      "https://www.googleapis.com/auth/admin.directory.group.member",
      "https://www.googleapis.com/auth/admin.directory.orgunit",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    dwdScopes: [
      "https://www.googleapis.com/auth/admin.directory.user",
      "https://www.googleapis.com/auth/admin.directory.group",
      "https://www.googleapis.com/auth/admin.directory.group.member",
      "https://www.googleapis.com/auth/admin.directory.orgunit",
    ],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: [
      "google_admin/list_users", "google_admin/get_user", "google_admin/create_user", "google_admin/update_user", "google_admin/delete_user",
      "google_admin/list_groups", "google_admin/get_group", "google_admin/create_group", "google_admin/update_group", "google_admin/delete_group",
      "google_admin/list_members", "google_admin/add_member", "google_admin/update_member", "google_admin/remove_member",
      "google_admin/list_org_units", "google_admin/get_org_unit", "google_admin/create_org_unit", "google_admin/update_org_unit", "google_admin/delete_org_unit",
    ],
    toolScopeRequirements: {
      "google_admin/create_user": ["https://www.googleapis.com/auth/admin.directory.user"],
      "google_admin/update_user": ["https://www.googleapis.com/auth/admin.directory.user"],
      "google_admin/delete_user": ["https://www.googleapis.com/auth/admin.directory.user"],
      "google_admin/create_group": ["https://www.googleapis.com/auth/admin.directory.group"],
      "google_admin/update_group": ["https://www.googleapis.com/auth/admin.directory.group"],
      "google_admin/delete_group": ["https://www.googleapis.com/auth/admin.directory.group"],
      "google_admin/add_member": ["https://www.googleapis.com/auth/admin.directory.group.member"],
      "google_admin/update_member": ["https://www.googleapis.com/auth/admin.directory.group.member"],
      "google_admin/remove_member": ["https://www.googleapis.com/auth/admin.directory.group.member"],
      "google_admin/create_org_unit": ["https://www.googleapis.com/auth/admin.directory.orgunit"],
      "google_admin/update_org_unit": ["https://www.googleapis.com/auth/admin.directory.orgunit"],
      "google_admin/delete_org_unit": ["https://www.googleapis.com/auth/admin.directory.orgunit"],
    },
    implemented: true,
  },
  bigquery: {
    key: "bigquery",
    label: "BigQuery",
    authTypes: ["oauth"],
    helpText: "Connect your Google account to list datasets/tables and run BigQuery SQL queries.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/bigquery", "https://www.googleapis.com/auth/userinfo.email"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["bigquery/list_datasets", "bigquery/list_tables", "bigquery/get_table", "bigquery/query", "bigquery/get_job"],
    implemented: true,
  },
  godaddy: {
    key: "godaddy",
    label: "GoDaddy",
    authTypes: ["pat"],
    helpText: "Create a Production API key at developer.godaddy.com/keys and paste it as KEY:SECRET (the key and secret joined with a colon). It is sent as Authorization: sso-key KEY:SECRET. Note: GoDaddy restricts the production Domains API to accounts that meet its eligibility rules (historically 10+ domains or reseller).",
    tokenUrl: "https://developer.godaddy.com/keys",
    tools: [
      "godaddy/list_domains",
      "godaddy/get_domain",
      "godaddy/check_availability",
      "godaddy/list_dns_records",
      "godaddy/add_dns_records",
      "godaddy/replace_dns_records",
      "godaddy/delete_dns_record",
    ],
    implemented: true,
  },
  openai: {
    key: "openai",
    label: "OpenAI",
    authTypes: ["pat"],
    helpText: "Paste an OpenAI API key (starts with sk- or sk-proj-) from platform.openai.com/api-keys. It is sent as Authorization: Bearer. To pin an org/project, paste JSON like {\"api_key\":\"sk-...\",\"organization\":\"org_...\",\"project\":\"proj_...\"}. Image generation requires an account with billing enabled.",
    tokenUrl: "https://platform.openai.com/api-keys",
    tools: [
      "openai/generate_image",
    ],
    implemented: true,
  },
  openai_ads: {
    key: "openai_ads",
    label: "OpenAI Ads",
    authTypes: ["pat"],
    helpText: "Paste an OpenAI Ads API key from ads.openai.com. It is sent as Authorization: Bearer. Reads cover ad account, campaigns, ad groups, ads and insights; use openai_ads/request for writes (create/update/activate/pause/archive, uploads).",
    tokenUrl: "https://ads.openai.com",
    tools: [
      "openai_ads/get_ad_account",
      "openai_ads/list_campaigns",
      "openai_ads/get_campaign",
      "openai_ads/list_ad_groups",
      "openai_ads/get_ad_group",
      "openai_ads/list_ads",
      "openai_ads/get_ad",
      "openai_ads/get_insights",
    ],
    implemented: true,
  },
  higgsfield: {
    key: "higgsfield",
    label: "Higgsfield",
    authTypes: ["pat"],
    helpText: "Create an API key at cloud.higgsfield.ai and paste it as KEY_ID:KEY_SECRET (the key id and secret joined with a colon). It is sent as Authorization: Key KEY_ID:KEY_SECRET against platform.higgsfield.ai. generate_image and generate_video submit an async job and poll it to completion (video jobs can take minutes — if still running they return a request_id; finish polling with get_request). Pick a model with model_id (e.g. higgsfield-ai/soul/standard for images, higgsfield-ai/dop/standard for video); browse the catalog at cloud.higgsfield.ai.",
    tokenUrl: "https://cloud.higgsfield.ai",
    tools: [
      "higgsfield/generate_image",
      "higgsfield/generate_video",
      "higgsfield/get_request",
      "higgsfield/cancel_request",
    ],
    implemented: true,
  },
  apify: {
    key: "apify",
    label: "Apify",
    authTypes: ["pat"],
    helpText: "Paste an Apify API token from console.apify.com/settings/integrations. It is sent as Authorization: Bearer against api.apify.com/v2. Use apify/request to reach any endpoint — run Actors (POST /acts/{actorId}/runs), read runs, and fetch dataset items (GET /datasets/{datasetId}/items).",
    tokenUrl: "https://console.apify.com/settings/integrations",
    tools: [],
    implemented: true,
  },
  granola: {
    key: "granola",
    label: "Granola",
    authTypes: ["pat"],
    helpText: "Paste your Granola API key (starts with grn_), created in the Granola desktop app. It is sent as Authorization: Bearer against public-api.granola.ai/v1. Read-only: the API only returns notes that already have a generated AI summary and transcript. list_notes filters by created/updated timestamps and folder; get_note with include=transcript returns the full transcript.",
    tokenUrl: "https://www.granola.ai",
    tools: [
      "granola/list_notes",
      "granola/get_note",
      "granola/list_folders",
    ],
    implemented: true,
  },
  tldv: {
    key: "tldv",
    label: "tl;dv",
    authTypes: ["pat"],
    helpText: "Create an API key in tl;dv at Settings > Personal Settings > API Keys and paste it here. It is sent as the x-api-key header to pasta.tldv.io/v1alpha1. API access requires a Pro or Business plan. Covers meetings (list/get), transcripts, AI notes, the deprecated highlights endpoint, a signed recording download URL, and importing a recording from a public URL.",
    tokenUrl: "https://tldv.io/app/settings/personal-settings/api-keys",
    tools: [
      "tldv/list_meetings",
      "tldv/get_meeting",
      "tldv/get_transcript",
      "tldv/get_notes",
      "tldv/get_highlights",
      "tldv/get_download_url",
      "tldv/import_meeting",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, hint: "Settings > Personal Settings > API Keys (Pro / Business plans)." },
    ],
    implemented: true,
  },
  zapmail: {
    key: "zapmail",
    label: "Zapmail",
    authTypes: ["pat"],
    helpText: "Copy the API key from the Zapmail dashboard under Settings > Integrations > API and paste it here. It is sent as the x-auth-zapmail header to api.zapmail.ai/api. API access requires the Pro plan. Covers the account and its workspaces, mailboxes, domains (assignable, health score, DNS records), subscriptions, wallet balance, the global mailbox/domain search, and exporting mailboxes to cold-email apps such as Smartlead or Instantly. Optionally pin a workspace: leave the workspace key empty to use the primary workspace, or set it (and the service provider) to point every call at another workspace. Mailbox passwords, app passwords and TOTP secrets are masked in mailbox listings unless a call explicitly sets include_secrets. Domain availability search (single, bulk and the AI finder) is included and only prices names - it registers nothing. A domain bought at any registrar can be brought in with get_name_servers, verify_name_servers and connect_domain, which is how TLDs Zapmail does not sell (.jp among them) get used for sending. assign_mailboxes creates mailboxes on a connected domain out of the plan's prepaid quota and refuses when the quota would be exceeded, so it never triggers a purchase; add_dmarc and add_forwarding finish the usual sending setup. Endpoints that spend money - buying domains, mailboxes or subscriptions, quick setup, recharging the wallet - are not exposed as tools, and zapmail/request is GET-only, so no agent can commit spend through this connector.",
    tokenUrl: "https://app.zapmail.ai/settings/integrations",
    tools: [
      "zapmail/get_user",
      "zapmail/list_workspaces",
      "zapmail/list_mailboxes",
      "zapmail/get_mailbox",
      "zapmail/list_domains",
      "zapmail/list_assignable_domains",
      "zapmail/search_domains",
      "zapmail/check_domains",
      "zapmail/ai_find_domains",
      "zapmail/get_name_servers",
      "zapmail/verify_name_servers",
      "zapmail/connect_domain",
      "zapmail/list_connection_requests",
      "zapmail/assign_mailboxes",
      "zapmail/add_dmarc",
      "zapmail/add_forwarding",
      "zapmail/get_domain_health",
      "zapmail/get_dns_records",
      "zapmail/list_subscriptions",
      "zapmail/get_wallet_balance",
      "zapmail/search",
      "zapmail/list_third_party_accounts",
      "zapmail/get_export_status",
      "zapmail/export_mailboxes",
    ],
    credentialFields: [
      { key: "api_key", label: "API key", required: true, secret: true, hint: "Zapmail Dashboard > Settings > Integrations > API (Pro plan)." },
      { key: "workspace_key", label: "Workspace key", required: false, hint: "Optional. Workspace ID to act on; empty uses the primary workspace." },
      { key: "service_provider", label: "Service provider", required: false, hint: "Optional. GOOGLE or MICROSOFT, when the workspace needs it pinned." },
    ],
    implemented: true,
  },
  canva: {
    key: "canva",
    label: "Canva",
    authTypes: ["oauth"],
    helpText: "Connect your Canva account via OAuth. Register an integration at canva.com/developers, set its redirect URL to this server's /oauth/canva/callback, then paste the integration's Client ID and Client Secret in Grantry. A development integration works for your own Canva team without review. Uses Authorization Code + PKCE (S256). Use canva/request to reach any Connect API endpoint under api.canva.com/rest/v1 — list/create designs, upload assets, autofill brand templates, export designs (async), read folders and comments.",
    oauthSetupUrl: "https://www.canva.com/developers/integrations/connect-api",
    oauthAppOwner: "workspace",
    oauthClientAuthMethod: "CLIENT_SECRET_BASIC",
    oauthScopes: [
      "design:meta:read",
      "design:content:read",
      "design:content:write",
      "asset:read",
      "asset:write",
      "brandtemplate:meta:read",
      "brandtemplate:content:read",
      "folder:read",
      "folder:write",
      "comment:read",
      "comment:write",
      "profile:read",
    ],
    authorizeUrl: "https://www.canva.com/api/oauth/authorize",
    oauthTokenUrl: "https://api.canva.com/rest/v1/oauth/token",
    tools: [],
    implemented: true,
  },
  figma: {
    key: "figma",
    label: "Figma",
    authTypes: ["oauth"],
    helpText: "Connect your Figma account via OAuth. Register an app at figma.com/developers/apps, set its redirect URL to this server's /oauth/figma/callback, then paste the app's Client ID and Client Secret in Grantry. Uses Authorization Code + PKCE (S256); the client authenticates with HTTP Basic at the token endpoint. Use figma/request to reach any REST endpoint under api.figma.com/v1 — read files and nodes (GET /files/:key), file images, comments (read/write), dev resources, versions, projects, team components/styles, and the current user (GET /me).",
    oauthSetupUrl: "https://www.figma.com/developers/apps",
    oauthAppOwner: "workspace",
    oauthClientAuthMethod: "CLIENT_SECRET_BASIC",
    oauthScopes: [
      "current_user:read",
      "file_content:read",
      "file_metadata:read",
      "file_versions:read",
      "file_comments:read",
      "file_comments:write",
      "file_dev_resources:read",
      "file_dev_resources:write",
      "library_assets:read",
      "library_content:read",
      "team_library_content:read",
      "projects:read",
      "project_metadata:read",
      "selections:read",
      "webhooks:read",
    ],
    authorizeUrl: "https://www.figma.com/oauth",
    oauthTokenUrl: "https://api.figma.com/v1/oauth/token",
    oauthRefreshUrl: "https://api.figma.com/v1/oauth/refresh",
    tools: [],
    implemented: true,
  },
  miro: {
    key: "miro",
    label: "Miro",
    authTypes: ["oauth"],
    helpText: "Connect your Miro account via OAuth. Create an app at miro.com/app/settings/user-profile/apps, set its redirect URL to this server's /oauth/miro/callback, then paste the app's Client ID and Client Secret in Grantry. Access tokens last ~60 min and refresh silently. Use miro/request to reach any REST endpoint under api.miro.com/v2 — list/create/update boards and board items (shapes, sticky notes, text, frames, connectors), members, tags, and app cards.",
    oauthSetupUrl: "https://miro.com/app/settings/user-profile/apps",
    oauthAppOwner: "workspace",
    oauthClientAuthMethod: "CLIENT_SECRET_POST",
    oauthScopes: [
      "boards:read",
      "boards:write",
      "identity:read",
      "team:read",
    ],
    authorizeUrl: "https://miro.com/oauth/authorize",
    oauthTokenUrl: "https://api.miro.com/v1/oauth/token",
    tools: [],
    implemented: true,
  },
};

const GENERIC_REQUESTS: Record<string, NonNullable<ProviderDef["genericRequest"]>> = {
  notion: {
    baseUrl: "https://api.notion.com/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "users_me", method: "GET", path: "/users/me" }],
  },
  zoom: {
    baseUrl: "https://api.zoom.us/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "me", method: "GET", path: "/users/me" }],
  },
  github: {
    baseUrl: "https://api.github.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "viewer", method: "GET", path: "/user" }],
  },
  cloudflare: {
    baseUrl: "https://api.cloudflare.com/client/v4",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  godaddy: {
    baseUrl: "https://api.godaddy.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v1"],
    smokeTests: [
      { id: "domains_available", method: "GET", path: "/v1/domains/available", query: { domain: "grantry-availability-check.com" } },
    ],
  },
  google_drive: {
    baseUrl: "https://www.googleapis.com/drive/v3",
    baseUrls: {
      drive: "https://www.googleapis.com/drive/v3",
      // File content (uploadType=media|multipart|resumable) is served by the
      // upload host, not the metadata host.
      upload: "https://www.googleapis.com/upload/drive/v3",
    },
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_gsc: {
    baseUrl: "https://searchconsole.googleapis.com",
    baseUrls: {
      searchconsole: "https://searchconsole.googleapis.com",
      webmasters: "https://www.googleapis.com/webmasters/v3",
    },
    defaultMethods: ["GET", "PUT", "DELETE"],
    allowedPathPrefixes: ["/"],
    operations: [
      {
        id: "list_sites",
        tools: ["google_gsc/list_sites"],
        method: "GET",
        path: "/sites",
        description: "List Search Console sites available to the authenticated user.",
        baseUrlKey: "webmasters",
        requiredScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
        risk: "read",
        // Webmasters API /sites takes no query params and 400s on an unknown `limit`.
        probeQuery: {},
      },
      {
        id: "add_site",
        method: "PUT",
        path: "/sites/{siteUrl}",
        description:
          "Add a site to Search Console. siteUrl must be URL-encoded " +
          "(https%3A%2F%2Fexample.com%2F for a URL-prefix property, " +
          "sc-domain%3Aexample.com for a domain property). " +
          "Adding does not verify ownership; verification is a separate step.",
        baseUrlKey: "webmasters",
        requiredScopes: ["https://www.googleapis.com/auth/webmasters"],
        risk: "write",
      },
      {
        id: "delete_site",
        method: "DELETE",
        path: "/sites/{siteUrl}",
        description: "Remove a site from Search Console. siteUrl must be URL-encoded.",
        baseUrlKey: "webmasters",
        requiredScopes: ["https://www.googleapis.com/auth/webmasters"],
        risk: "write",
      },
    ],
  },
  google_analytics: {
    baseUrl: "https://analyticsdata.googleapis.com",
    baseUrls: {
      data: "https://analyticsdata.googleapis.com",
      admin: "https://analyticsadmin.googleapis.com/v1beta",
    },
    // Large GA4 runReport requests are slow by design.
    timeoutMs: 60000,
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [
      { id: "admin_account_summaries", method: "GET", path: "/accountSummaries", baseUrlKey: "admin", requiredScopes: ["https://www.googleapis.com/auth/analytics.readonly"] },
    ],
    operations: [
      {
        id: "admin_data_streams",
        method: "GET",
        path: "/properties/{propertyId}/dataStreams",
        description: "List GA4 data streams on a property through the Analytics Admin API. Use base_url_key=admin.",
        baseUrlKey: "admin",
        requiredScopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        risk: "read",
      },
    ],
  },
  google_ads: {
    baseUrl: "https://googleads.googleapis.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  yahoo_ads: {
    baseUrl: "https://ads-search.yahooapis.jp",
    baseUrls: {
      search: "https://ads-search.yahooapis.jp",
      display: "https://ads-display.yahooapis.jp",
    },
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  meta_ads: {
    baseUrl: "https://graph.facebook.com",
    baseUrls: {
      graph: "https://graph.facebook.com",
      // Video creatives (advideos) must be posted to the video host; the
      // main graph host rejects them.
      video: "https://graph-video.facebook.com",
    },
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  meta_ads_platform: {
    baseUrl: "https://graph.facebook.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  clarity: {
    baseUrl: "https://www.clarity.ms",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  gmail: {
    baseUrl: "https://gmail.googleapis.com/gmail/v1",
    baseUrls: {
      gmail: "https://gmail.googleapis.com/gmail/v1",
      // messages.send / messages.import above the 5 MB inline limit go to the
      // upload host with uploadType=media|multipart|resumable.
      upload: "https://gmail.googleapis.com/upload/gmail/v1",
    },
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  youtube: {
    baseUrl: "https://www.googleapis.com/youtube/v3",
    baseUrls: {
      data: "https://www.googleapis.com/youtube/v3",
      // Resumable upload sessions are created against the upload host.
      upload: "https://www.googleapis.com/upload/youtube/v3",
    },
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  hubspot: {
    baseUrl: "https://api.hubapi.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [
      { id: "account", method: "GET", path: "/account-info/v3/details" },
    ],
    operations: [
      {
        id: "crm_deals",
        tools: ["hubspot/list_deals"],
        method: "GET",
        path: "/crm/v3/objects/deals",
        description: "Read CRM deals.",
        requiredScopes: ["crm.objects.deals.read"],
        risk: "read",
      },
      {
        id: "crm_contacts",
        tools: ["hubspot/get_contact"],
        method: "GET",
        path: "/crm/v3/objects/contacts",
        description: "Read CRM contacts.",
        requiredScopes: ["crm.objects.contacts.read"],
        risk: "read",
      },
      {
        id: "marketing_emails",
        tools: ["hubspot/list_marketing_emails", "hubspot/get_marketing_email", "hubspot/get_marketing_email_statistics"],
        method: "GET",
        path: "/marketing/v3/emails",
        description: "Read HubSpot marketing emails.",
        requiredScopes: ["content"],
        risk: "read",
      },
      {
        id: "update_marketing_email",
        tools: ["hubspot/update_marketing_email"],
        method: "PATCH",
        path: "/marketing/v3/emails/{emailId}",
        description: "Update a HubSpot marketing email.",
        requiredScopes: ["content"],
        risk: "write",
      },
      {
        id: "publish_marketing_email",
        tools: ["hubspot/publish_marketing_email"],
        method: "POST",
        path: "/marketing/v3/emails/{emailId}/publish",
        description: "Publish a HubSpot marketing email.",
        requiredScopes: ["content"],
        risk: "write",
      },
    ],
  },
  attio: {
    baseUrl: "https://api.attio.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v2/"],
    smokeTests: [{ id: "objects", method: "GET", path: "/v2/objects" }],
  },
  twenty: {
    baseUrl: "credential.twenty_base",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/rest/", "/graphql"],
    smokeTests: [{ id: "metadata_objects", method: "GET", path: "/rest/metadata/objects" }],
  },
  nocodb: {
    baseUrl: "credential.nocodb_base",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/api/v1/", "/api/v2/"],
    authScheme: "api_key",
    apiKeyHeader: "xc-token",
    smokeTests: [{ id: "me", method: "GET", path: "/api/v1/auth/user/me" }],
  },
  seminar_portal: {
    // Self-hosted: the deployment URL is part of the credential, so the base is
    // resolved from it rather than hardcoded. Routes all sit under /api/v1.
    baseUrl: "credential.seminar_portal_api_v1",
    defaultMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "tech", method: "GET", path: "/tech" }],
  },
  langgraph: {
    baseUrl: "credential.langgraph_base",
    defaultMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/assistants", "/threads", "/runs", "/store", "/info"],
    authScheme: "api_key",
    apiKeyHeader: "x-api-key",
    smokeTests: [{ id: "info", method: "GET", path: "/info" }],
  },
  langsmith: {
    baseUrl: "credential.langsmith_base",
    defaultMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/api/v1/"],
    authScheme: "api_key",
    apiKeyHeader: "X-Api-Key",
    smokeTests: [{ id: "sessions", method: "GET", path: "/api/v1/sessions" }],
  },
  monid: {
    baseUrl: "https://api.monid.ai",
    defaultMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/v1/"],
    smokeTests: [{ id: "whoami", method: "GET", path: "/v1/auth/whoami" }],
  },
  calendly: {
    baseUrl: "https://api.calendly.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "me", method: "GET", path: "/users/me" }],
  },
  tldv: {
    baseUrl: "https://pasta.tldv.io",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v1alpha1/"],
    authScheme: "api_key",
    apiKeyHeader: "x-api-key",
    smokeTests: [{ id: "meetings", method: "GET", path: "/v1alpha1/meetings", query: { limit: 1 } }],
  },
  zapmail: {
    baseUrl: "https://api.zapmail.ai/api",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v2/"],
    authScheme: "api_key",
    apiKeyHeader: "x-auth-zapmail",
    smokeTests: [{ id: "user", method: "GET", path: "/v2/users" }],
  },
  jicoo: {
    baseUrl: "https://api.jicoo.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v1/"],
    authScheme: "api_key",
    apiKeyHeader: "x-jicoo-api-key",
    smokeTests: [{ id: "me", method: "GET", path: "/v1/users/me" }],
  },
  timerex: {
    baseUrl: "https://timerex.net",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/api/beta/"],
    authScheme: "api_key",
    apiKeyHeader: "x-api-key",
    smokeTests: [{ id: "primary_team", method: "GET", path: "/api/beta/user/me/teams/primary" }],
  },
  dataforseo: {
    baseUrl: "https://api.dataforseo.com",
    // SERP and Labs endpoints routinely take a minute on live tasks.
    timeoutMs: 90000,
    defaultMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/v3/"],
    smokeTests: [{ id: "user_data", method: "GET", path: "/v3/appendix/user_data" }],
  },
  firecrawl: {
    baseUrl: "https://api.firecrawl.dev",
    defaultMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/v2/"],
    smokeTests: [{ id: "credit_usage", method: "GET", path: "/v2/team/credit-usage" }],
  },
  acuity: {
    baseUrl: "https://acuityscheduling.com/api/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "me", method: "GET", path: "/me" }],
  },
  calcom: {
    baseUrl: "https://api.cal.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v2/", "/v1/"],
    smokeTests: [{ id: "me", method: "GET", path: "/v2/me" }],
  },
  youcanbookme: {
    baseUrl: "https://api.youcanbook.me",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v1/"],
    smokeTests: [{ id: "profiles", method: "GET", path: "/v1/profiles" }],
  },
  clay: {
    baseUrl: "https://api.clay.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v1/"],
  },
  apollo: {
    baseUrl: "https://api.apollo.io",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    authScheme: "api_key",
    apiKeyHeader: "X-Api-Key",
    smokeTests: [{ id: "health", method: "GET", path: "/api/v1/auth/health" }],
  },
  heyreach: {
    baseUrl: "https://api.heyreach.io",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    authScheme: "api_key",
    apiKeyHeader: "X-API-KEY",
    smokeTests: [{ id: "api_key", method: "GET", path: "/api/public/auth/CheckApiKey" }],
  },
  smartlead: {
    baseUrl: "https://server.smartlead.ai",
    defaultMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/api/v1/"],
    authScheme: "api_key_query",
    apiKeyQueryParam: "api_key",
    smokeTests: [{ id: "campaigns", method: "GET", path: "/api/v1/campaigns", query: { limit: 1 } }],
  },
  chatwork: {
    baseUrl: "https://api.chatwork.com/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    authScheme: "api_key",
    apiKeyHeader: "X-ChatWorkToken",
    smokeTests: [{ id: "me", method: "GET", path: "/me" }],
  },
  channel_talk: {
    baseUrl: "https://api.channel.io/open/v5",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  channel_talk_documents: {
    baseUrl: "https://document-api.channel.io/open/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  railway: {
    baseUrl: "https://backboard.railway.app/graphql/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  railway_api: {
    baseUrl: "https://backboard.railway.app/graphql/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  freee: {
    baseUrl: "https://api.freee.co.jp",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  moneyforward: {
    baseUrl: "https://api-accounting.moneyforward.com/api/v3",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_maps: {
    baseUrl: "https://maps.googleapis.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    authScheme: "api_key",
    apiKeyHeader: "X-Goog-Api-Key",
  },
  resend: {
    baseUrl: "https://api.resend.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "domains", method: "GET", path: "/domains" }],
  },
  slack: {
    baseUrl: "https://slack.com/api",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "auth", method: "GET", path: "/auth.test" }],
  },
  reddit: {
    baseUrl: "https://oauth.reddit.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  x: {
    baseUrl: "https://api.x.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  discord: {
    baseUrl: "https://discord.com/api/v10",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  line: {
    baseUrl: "https://api.line.me",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  facebook_messenger: {
    baseUrl: "https://graph.facebook.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  airtable: {
    baseUrl: "https://api.airtable.com/v0",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  linear: {
    baseUrl: "https://api.linear.app",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  sendgrid: {
    baseUrl: "https://api.sendgrid.com/v3",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  vercel: {
    baseUrl: "https://api.vercel.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  stripe: {
    baseUrl: "https://api.stripe.com/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "balance", method: "GET", path: "/balance" }],
  },
  webflow: {
    baseUrl: "https://api.webflow.com/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  intercom: {
    baseUrl: "https://api.intercom.io",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  customerio: {
    baseUrl: "credential.customerio_region",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "campaigns", method: "GET", path: "/v1/campaigns" }],
  },
  mailchimp: {
    baseUrl: "https://us1.api.mailchimp.com/3.0",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  zendesk: {
    baseUrl: "credential.zendesk_api_v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "me", method: "GET", path: "/users/me.json" }],
  },
  wordpress: {
    baseUrl: "credential.wordpress_wp_v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "me", method: "GET", path: "/users/me", query: { context: "edit" } }],
  },
  supabase: {
    baseUrl: "credential.supabase_rest",
    defaultMethods: ["GET", "POST", "PATCH", "DELETE"],
    allowedPathPrefixes: ["/"],
    // PostgREST root returns the OpenAPI schema (200) regardless of which
    // tables exist, so this works before any table is created.
    smokeTests: [{ id: "root", method: "GET", path: "/" }],
  },
  shopify: {
    baseUrl: "credential.shopify_admin",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "shop", method: "GET", path: "/shop.json" }],
  },
  jira: {
    baseUrl: "credential.jira_api_v3",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "me", method: "GET", path: "/myself" }],
  },
  salesforce: {
    baseUrl: "credential.instance_url",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/services/data/"],
  },
  linkedin_ads: {
    baseUrl: "https://api.linkedin.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  tiktok_ads: {
    baseUrl: "https://business-api.tiktok.com/open_api",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  snowflake: {
    baseUrl: "credential.snowflake_api_v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_calendar: {
    baseUrl: "https://www.googleapis.com/calendar/v3",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_sheets: {
    baseUrl: "https://sheets.googleapis.com/v4",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_slides: {
    baseUrl: "https://slides.googleapis.com/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_forms: {
    baseUrl: "https://forms.googleapis.com/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_tag_manager: {
    baseUrl: "https://tagmanager.googleapis.com/tagmanager/v2",
    baseUrls: {
      tagmanager: "https://tagmanager.googleapis.com/tagmanager/v2",
      web: "https://www.googleapis.com/tagmanager/v2",
    },
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    operations: [
      {
        id: "list_accounts",
        tools: ["google_tag_manager/list_accounts"],
        method: "GET",
        path: "/accounts",
        description: "List Google Tag Manager accounts.",
        baseUrlKey: "web",
        requiredScopes: ["https://www.googleapis.com/auth/tagmanager.readonly"],
        risk: "read",
      },
      {
        id: "list_containers",
        tools: ["google_tag_manager/list_containers"],
        method: "GET",
        path: "/accounts/{accountId}/containers",
        description: "List containers in a Google Tag Manager account.",
        baseUrlKey: "web",
        requiredScopes: ["https://www.googleapis.com/auth/tagmanager.readonly"],
        risk: "read",
      },
      {
        id: "list_workspaces",
        tools: ["google_tag_manager/list_workspaces"],
        method: "GET",
        path: "/accounts/{accountId}/containers/{containerId}/workspaces",
        description: "List workspaces in a Google Tag Manager container.",
        baseUrlKey: "web",
        requiredScopes: ["https://www.googleapis.com/auth/tagmanager.readonly"],
        risk: "read",
      },
      {
        id: "list_tags",
        tools: ["google_tag_manager/list_tags"],
        method: "GET",
        path: "/accounts/{accountId}/containers/{containerId}/workspaces/{workspaceId}/tags",
        description: "List tags in a Google Tag Manager workspace.",
        baseUrlKey: "web",
        requiredScopes: ["https://www.googleapis.com/auth/tagmanager.readonly"],
        risk: "read",
      },
      {
        id: "create_tag",
        tools: ["google_tag_manager/create_tag"],
        method: "POST",
        path: "/accounts/{accountId}/containers/{containerId}/workspaces/{workspaceId}/tags",
        description: "Create a GTM tag in a workspace.",
        baseUrlKey: "web",
        requiredScopes: ["https://www.googleapis.com/auth/tagmanager.edit.containers"],
        risk: "write",
      },
      {
        id: "create_version",
        tools: ["google_tag_manager/create_version"],
        method: "POST",
        path: "/accounts/{accountId}/containers/{containerId}/workspaces/{workspaceId}:create_version",
        description: "Create a GTM container version from a workspace.",
        baseUrlKey: "web",
        requiredScopes: ["https://www.googleapis.com/auth/tagmanager.edit.containerversions"],
        risk: "write",
      },
      {
        id: "publish_version",
        tools: ["google_tag_manager/publish_version"],
        method: "POST",
        path: "/accounts/{accountId}/containers/{containerId}/versions/{versionId}:publish",
        description: "Publish a GTM container version.",
        baseUrlKey: "web",
        requiredScopes: ["https://www.googleapis.com/auth/tagmanager.publish"],
        risk: "write",
      },
    ],
  },
  google_cloud: {
    baseUrl: "https://cloudresourcemanager.googleapis.com",
    baseUrls: {
      resource_manager: "https://cloudresourcemanager.googleapis.com",
      service_usage: "https://serviceusage.googleapis.com",
      logging: "https://logging.googleapis.com",
      billing: "https://cloudbilling.googleapis.com/v1",
    },
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    operations: [
      {
        id: "list_projects",
        tools: ["google_cloud/list_projects"],
        method: "GET",
        path: "/v1/projects",
        description: "List Google Cloud projects visible to the authenticated user.",
        baseUrlKey: "resource_manager",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "get_project",
        tools: ["google_cloud/get_project"],
        method: "GET",
        path: "/v1/projects/{projectId}",
        description: "Get metadata for a Google Cloud project.",
        baseUrlKey: "resource_manager",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "list_services",
        tools: ["google_cloud/list_services"],
        method: "GET",
        path: "/v1/projects/{projectId}/services",
        description: "List enabled and available services for a Google Cloud project.",
        baseUrlKey: "service_usage",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "list_billing_accounts",
        tools: ["google_cloud/list_billing_accounts"],
        method: "GET",
        path: "/billingAccounts",
        description: "List Cloud Billing accounts visible to the authenticated user.",
        baseUrlKey: "billing",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "get_billing_account",
        tools: ["google_cloud/get_billing_account"],
        method: "GET",
        path: "/billingAccounts/{billingAccountId}",
        description: "Get Cloud Billing account metadata.",
        baseUrlKey: "billing",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "list_billing_account_projects",
        tools: ["google_cloud/list_billing_account_projects"],
        method: "GET",
        path: "/billingAccounts/{billingAccountId}/projects",
        description: "List projects linked to a Cloud Billing account.",
        baseUrlKey: "billing",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "get_project_billing_info",
        tools: ["google_cloud/get_project_billing_info"],
        method: "GET",
        path: "/projects/{projectId}/billingInfo",
        description: "Get billing linkage for a Google Cloud project.",
        baseUrlKey: "billing",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "list_billing_services",
        tools: ["google_cloud/list_billing_services"],
        method: "GET",
        path: "/services",
        description: "List Cloud Billing catalog services.",
        baseUrlKey: "billing",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
      {
        id: "list_skus",
        tools: ["google_cloud/list_skus"],
        method: "GET",
        path: "/services/{serviceId}/skus",
        description: "List Cloud Billing catalog SKUs for a service.",
        baseUrlKey: "billing",
        requiredScopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
        risk: "read",
      },
    ],
  },
  google_admin: {
    baseUrl: "https://admin.googleapis.com/admin/directory/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  bigquery: {
    baseUrl: "https://bigquery.googleapis.com/bigquery/v2",
    baseUrls: {
      bigquery: "https://bigquery.googleapis.com/bigquery/v2",
      // jobs.insert with a media body (load jobs) is served by the upload host.
      upload: "https://bigquery.googleapis.com/upload/bigquery/v2",
    },
    // jobs.query blocks until the query finishes or its own timeout elapses.
    timeoutMs: 60000,
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "models", method: "GET", path: "/models" }],
  },
  openai_ads: {
    baseUrl: "https://api.ads.openai.com/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "ad_account", method: "GET", path: "/ad_account" }],
  },
  apify: {
    baseUrl: "https://api.apify.com/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "users_me", method: "GET", path: "/users/me" }],
  },
  canva: {
    baseUrl: "https://api.canva.com/rest/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "users_me", method: "GET", path: "/users/me" }],
  },
  figma: {
    baseUrl: "https://api.figma.com/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "me", method: "GET", path: "/me" }],
  },
  miro: {
    baseUrl: "https://api.miro.com/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    smokeTests: [{ id: "boards", method: "GET", path: "/boards", query: { limit: 1 } }],
  },
};

const PROVIDER_AUTHORITY_GENERIC_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

for (const provider of Object.values(PROVIDERS)) {
  const genericRequest = GENERIC_REQUESTS[provider.key];
  if (!genericRequest || provider.implemented === false) continue;
  provider.genericRequest = {
    ...genericRequest,
    defaultMethods: PROVIDER_AUTHORITY_GENERIC_METHODS,
  };
  const requestTool = `${provider.key}/request`;
  if (!provider.tools.includes(requestTool)) provider.tools.push(requestTool);
  const checkTool = `${provider.key}/check_connection`;
  if (!provider.tools.includes(checkTool)) provider.tools.push(checkTool);
  const capabilitiesTool = `${provider.key}/list_capabilities`;
  if (!provider.tools.includes(capabilitiesTool)) provider.tools.push(capabilitiesTool);
}

export function getProvider(key: string): ProviderDef | undefined {
  return PROVIDERS[key];
}

export function listProviders(): ProviderDef[] {
  return Object.values(PROVIDERS).filter((p) => p.implemented !== false);
}

export function providerCoverageStats(): {
  implementedProviderCount: number;
  runtimeMcpToolNameCount: number;
} {
  const providers = listProviders();
  return {
    implementedProviderCount: providers.length,
    // Count the runtime registry after generic request helpers are appended.
    // Use distinct names for public copy because a small number of aliases are
    // intentionally exposed by more than one provider.
    runtimeMcpToolNameCount: new Set(providers.flatMap((p) => p.tools)).size,
  };
}

export function toolsForProvider(providerKey: string): string[] {
  const provider = PROVIDERS[providerKey];
  if (!provider || provider.implemented === false) return [];
  return provider.tools;
}

function parseArray(raw: string | null | undefined, fallback: unknown[]) {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function stringArray(raw: string | null | undefined, fallback: string[]) {
  return parseArray(raw, fallback).map(String).map((s) => s.trim()).filter(Boolean);
}

export function customProviderTools(key: string) {
  return [`${key}/request`, `${key}/check_connection`, `${key}/list_capabilities`];
}

function customProviderDef(row: any): ProviderDef {
  const methods = Array.from(new Set(stringArray(row.defaultMethods, ["GET"]).map((m) => m.toUpperCase())));
  const allowed = stringArray(row.allowedPathPrefixes, ["/"]);
  const blocked = stringArray(row.blockedPathPrefixes, []);
  const smokeTests = parseArray(row.smokeTests, []);
  const operations = parseArray(row.operations, []);
  const authScheme =
    row.authScheme === "api_key" || row.authScheme === "api_key_query"
      ? row.authScheme
      : "bearer";
  return {
    key: row.key,
    label: row.label,
    authTypes: ["pat"],
    helpText: row.helpText || `Paste your ${row.label} API key or access token.`,
    tokenUrl: row.tokenUrl || undefined,
    tools: customProviderTools(row.key),
    implemented: row.enabled !== false,
    genericRequest: {
      baseUrl: String(row.baseUrl).replace(/\/+$/, ""),
      defaultMethods: methods.length ? methods : ["GET"],
      allowedPathPrefixes: allowed.length ? allowed : ["/"],
      ...(blocked.length ? { blockedPathPrefixes: blocked } : {}),
      authScheme,
      ...(authScheme === "api_key" && row.apiKeyHeader ? { apiKeyHeader: row.apiKeyHeader } : {}),
      ...(authScheme === "api_key_query" && row.apiKeyHeader ? { apiKeyQueryParam: row.apiKeyHeader } : {}),
      ...(smokeTests.length ? { smokeTests: smokeTests as any } : {}),
      ...(operations.length ? { operations: operations as any } : {}),
    },
  };
}

export async function getCustomProvider(key: string, workspaceId?: string | null): Promise<ProviderDef | undefined> {
  if (!workspaceId) return undefined;
  const { prisma } = await import("../db.js");
  const row = await prisma.customProvider.findFirst({ where: { workspaceId, key, enabled: true } });
  return row ? customProviderDef(row) : undefined;
}

export async function getProviderForWorkspace(key: string, workspaceId?: string | null): Promise<ProviderDef | undefined> {
  return getProvider(key) ?? await getCustomProvider(key, workspaceId);
}

export async function listProvidersForWorkspace(workspaceId?: string | null): Promise<ProviderDef[]> {
  const builtIns = listProviders();
  if (!workspaceId) return builtIns;
  const { prisma } = await import("../db.js");
  const reserved = new Set(builtIns.map((p) => p.key));
  const rows = await prisma.customProvider.findMany({
    where: { workspaceId, enabled: true, key: { notIn: Array.from(reserved) } },
    orderBy: [{ label: "asc" }, { key: "asc" }],
  });
  return [...builtIns, ...rows.map(customProviderDef)];
}

export async function toolsForProviderForWorkspace(providerKey: string, workspaceId?: string | null): Promise<string[]> {
  const builtIn = toolsForProvider(providerKey);
  if (builtIn.length) return builtIn;
  return (await getCustomProvider(providerKey, workspaceId))?.tools ?? [];
}

export function validateCustomProviderKey(key: string) {
  if (!/^[a-z0-9_-]+$/.test(key)) return "Provider key must use lowercase letters, numbers, underscores, and hyphens.";
  if (getProvider(key)) return "Provider key is reserved by an included provider.";
  return "";
}

export function normalizePathPrefixes(raw: string) {
  const prefixes = raw.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return prefixes.length ? prefixes.map((p) => p.startsWith("/") ? p : `/${p}`) : ["/"];
}
