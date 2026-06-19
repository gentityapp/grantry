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
  /** Tools this provider exposes, by name */
  tools: string[];
  /** Safe generic provider API request manifest. Phase 1 is read-only. */
  genericRequest?: {
    baseUrl: string;
    defaultMethods: string[];
    allowedPathPrefixes: string[];
    blockedPathPrefixes?: string[];
    authScheme?: "bearer" | "api_key";
    apiKeyHeader?: string;
    smokeTests?: Array<{
      id: string;
      method: "GET";
      path: string;
      query?: Record<string, string | number | boolean>;
      requiredScopes?: string[];
    }>;
    operations?: Array<{
      id: string;
      method: string;
      path: string;
      description: string;
      requiredScopes?: string[];
      risk: "read" | "write" | "destructive";
    }>;
  };
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
  zoom: {
    key: "zoom",
    label: "Zoom",
    authTypes: ["oauth"],
    helpText: "Connect your Zoom account via OAuth. Register a user-managed OAuth app at marketplace.zoom.us, set its redirect URL to this server's /oauth/zoom/callback, and enable the recording/meeting/user/report scopes listed below (adjust to match your app). Then set ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET env vars.",
    oauthSetupUrl: "https://marketplace.zoom.us/develop/create",
    oauthScopes: [
      "user:read:user",
      "user:read:list_users:admin",
      "cloud_recording:read:list_user_recordings",
      "cloud_recording:read:list_recording_files",
      "meeting:read:list_meetings",
      "meeting:read:meeting",
      "meeting:write:meeting",
      "report:read:list_meeting_participants:admin",
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
    authTypes: ["oauth", "service_account"],
    helpText: "Connect your Google account. We'll request read-only access to Drive files you choose to share with the integration.",
    /** Where to register/manage an OAuth client (callback URL setup) */
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    dwdScopes: ["https://www.googleapis.com/auth/drive.readonly"],
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
    tools: ["google_ads/list_accessible_customers", "google_ads/search", "google_ads/mutate", "google_ads/generate_keyword_ideas"],
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
  meta_ads: {
    key: "meta_ads",
    label: "Meta Ads",
    authTypes: ["oauth"],
    helpText: "Connect a Facebook user with access to the Meta Ads account via Business Manager. grantry exchanges the login for a long-lived (~60 day) access token; reconnect when it expires. Requires a Meta app with the Marketing API and the ads_read / ads_management permissions.",
    oauthSetupUrl: "https://developers.facebook.com/apps",
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
    implemented: true,
  },
  gmail: {
    key: "gmail",
    label: "Gmail",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect Gmail to list, read, and send messages through the Gmail API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    dwdScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
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
    authTypes: ["pat", "oauth"],
    helpText: "Connect via OAuth, or paste a HubSpot Private App access token to access CRM and marketing email data. Marketing email APIs require HubSpot's content scope. For OAuth apps, configure content as an optional scope in HubSpot.",
    tokenUrl: "https://app.hubspot.com/private-apps",
    oauthScopes: ["crm.objects.deals.read", "crm.objects.deals.write", "crm.objects.contacts.read", "crm.objects.contacts.write", "oauth"],
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
    ],
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
  freee: {
    key: "freee",
    label: "freee会計",
    authTypes: ["oauth"],
    helpText: "Connect your freee account. grantry requests read/write access to the accounting data (deals, partners, account items, trial balances) for the companies this user can access. Access tokens expire after a few hours; grantry refreshes them with the stored refresh token.",
    oauthSetupUrl: "https://app.secure.freee.co.jp/developers/applications",
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
    helpText: "Paste JSON with your subdomain, agent email, and API token: {\"subdomain\":\"acme\",\"email\":\"you@example.com\",\"token\":\"...\"}. Create an API token in Admin Center > Apps and integrations > APIs > Zendesk API.",
    tokenUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858",
    tools: ["zendesk/list_tickets", "zendesk/get_ticket", "zendesk/create_ticket", "zendesk/update_ticket", "zendesk/add_comment", "zendesk/search", "zendesk/list_users"],
    implemented: true,
  },
  wordpress: {
    key: "wordpress",
    label: "WordPress",
    authTypes: ["pat"],
    helpText: "Paste JSON with your site URL, username, and Application Password: {\"site\":\"https://blog.example.com\",\"username\":\"admin\",\"app_password\":\"xxxx xxxx ...\"}. Create an Application Password in wp-admin > Users > Profile.",
    tokenUrl: "https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/",
    tools: ["wordpress/list_posts", "wordpress/get_post", "wordpress/create_post", "wordpress/update_post", "wordpress/list_pages", "wordpress/list_categories"],
    implemented: true,
  },
  shopify: {
    key: "shopify",
    label: "Shopify",
    authTypes: ["pat"],
    helpText: "Paste JSON with your shop domain and Admin API access token: {\"shop\":\"acme.myshopify.com\",\"token\":\"shpat_...\"}. Create a custom app in Shopify Admin > Settings > Apps and sales channels > Develop apps.",
    tokenUrl: "https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/admin-api-access-tokens",
    tools: ["shopify/list_products", "shopify/get_product", "shopify/create_product", "shopify/list_orders", "shopify/get_order", "shopify/list_customers"],
    implemented: true,
  },
  jira: {
    key: "jira",
    label: "Jira",
    authTypes: ["pat"],
    helpText: "Paste JSON with your Atlassian site, email, and API token: {\"site\":\"https://acme.atlassian.net\",\"email\":\"you@example.com\",\"token\":\"...\"}. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens.",
    tokenUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    tools: ["jira/search", "jira/get_issue", "jira/create_issue", "jira/update_issue", "jira/add_comment", "jira/list_projects", "jira/transition_issue"],
    implemented: true,
  },
  salesforce: {
    key: "salesforce",
    label: "Salesforce",
    authTypes: ["pat"],
    helpText: "Paste JSON with your instance URL and OAuth access token: {\"instance_url\":\"https://acme.my.salesforce.com\",\"token\":\"...\"}. Access tokens expire (default ~2h); re-paste a fresh one when needed.",
    tokenUrl: "https://login.salesforce.com",
    tools: ["salesforce/query", "salesforce/search", "salesforce/get_record", "salesforce/create_record", "salesforce/update_record", "salesforce/delete_record"],
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
    helpText: "Paste JSON with your Microsoft Advertising developer token and OAuth access token: {\"developer_token\":\"...\",\"access_token\":\"...\",\"customer_id\":\"...\",\"account_id\":\"...\"}. Microsoft Ads is SOAP-based; the access token is short-lived and must be refreshed externally.",
    tokenUrl: "https://learn.microsoft.com/advertising/guides/get-started",
    tools: ["microsoft_ads/get_user", "microsoft_ads/get_accounts_info"],
    implemented: true,
  },
  aws: {
    key: "aws",
    label: "AWS",
    authTypes: ["pat"],
    helpText: "Paste JSON with your AWS credentials: {\"accessKeyId\":\"AKIA...\",\"secretAccessKey\":\"...\",\"region\":\"us-east-1\",\"sessionToken\":\"...\"}. region defaults to us-east-1; sessionToken is only needed for temporary credentials. Requests are signed with AWS SigV4.",
    tokenUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    tools: ["aws/get_caller_identity", "aws/s3_list_buckets", "aws/s3_list_objects"],
    implemented: true,
  },
  snowflake: {
    key: "snowflake",
    label: "Snowflake",
    authTypes: ["pat"],
    helpText: "Paste JSON with your account identifier and a Programmatic Access Token: {\"account\":\"orgname-accountname\",\"token\":\"...\",\"warehouse\":\"...\",\"database\":\"...\",\"schema\":\"...\",\"role\":\"...\"}. Only account and token are required; the rest are optional per-call defaults.",
    tokenUrl: "https://docs.snowflake.com/en/user-guide/programmatic-access-tokens",
    tools: ["snowflake/execute_statement", "snowflake/get_statement", "snowflake/cancel_statement"],
    implemented: true,
  },
  google_calendar: {
    key: "google_calendar",
    label: "Google Calendar",
    authTypes: ["oauth", "service_account"],
    helpText: "Connect your Google account to read and manage calendar events through the Calendar API.",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/userinfo.email"],
    dwdScopes: ["https://www.googleapis.com/auth/calendar"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_calendar/list_calendars", "google_calendar/list_events", "google_calendar/get_event", "google_calendar/create_event", "google_calendar/update_event", "google_calendar/delete_event"],
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
    implemented: true,
  },
  google_tag_manager: {
    key: "google_tag_manager",
    label: "Google Tag Manager",
    authTypes: ["oauth"],
    helpText: "Connect your Google account to read Tag Manager accounts, containers, workspaces, and tags (read-only).",
    oauthSetupUrl: "https://console.cloud.google.com/apis/credentials",
    oauthScopes: ["https://www.googleapis.com/auth/tagmanager.readonly", "https://www.googleapis.com/auth/userinfo.email"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    tools: ["google_tag_manager/list_accounts", "google_tag_manager/list_containers", "google_tag_manager/get_container", "google_tag_manager/list_workspaces", "google_tag_manager/list_tags"],
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
};

const GENERIC_REQUESTS: Record<string, NonNullable<ProviderDef["genericRequest"]>> = {
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
  google_drive: {
    baseUrl: "https://www.googleapis.com/drive/v3",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_gsc: {
    baseUrl: "https://searchconsole.googleapis.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_analytics: {
    baseUrl: "https://analyticsdata.googleapis.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  meta_ads: {
    baseUrl: "https://graph.facebook.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  gmail: {
    baseUrl: "https://gmail.googleapis.com/gmail/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  youtube: {
    baseUrl: "https://www.googleapis.com/youtube/v3",
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
        method: "GET",
        path: "/crm/v3/objects/deals",
        description: "Read CRM deals.",
        requiredScopes: ["crm.objects.deals.read"],
        risk: "read",
      },
      {
        id: "crm_contacts",
        method: "GET",
        path: "/crm/v3/objects/contacts",
        description: "Read CRM contacts.",
        requiredScopes: ["crm.objects.contacts.read"],
        risk: "read",
      },
      {
        id: "marketing_emails",
        method: "GET",
        path: "/marketing/v3/emails",
        description: "Read HubSpot marketing emails.",
        requiredScopes: ["content"],
        risk: "read",
      },
    ],
  },
  attio: {
    baseUrl: "https://api.attio.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v2/"],
  },
  clay: {
    baseUrl: "https://api.clay.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/v1/"],
  },
  heyreach: {
    baseUrl: "https://api.heyreach.io",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  chatwork: {
    baseUrl: "https://api.chatwork.com/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
    authScheme: "api_key",
    apiKeyHeader: "X-ChatWorkToken",
  },
  freee: {
    baseUrl: "https://api.freee.co.jp",
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
  mailchimp: {
    baseUrl: "https://us1.api.mailchimp.com/3.0",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
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
  google_tag_manager: {
    baseUrl: "https://tagmanager.googleapis.com/tagmanager/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_cloud: {
    baseUrl: "https://cloudresourcemanager.googleapis.com",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  google_admin: {
    baseUrl: "https://admin.googleapis.com/admin/directory/v1",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
  bigquery: {
    baseUrl: "https://bigquery.googleapis.com/bigquery/v2",
    defaultMethods: ["GET"],
    allowedPathPrefixes: ["/"],
  },
};

for (const provider of Object.values(PROVIDERS)) {
  const genericRequest = GENERIC_REQUESTS[provider.key];
  if (!genericRequest || provider.implemented === false) continue;
  provider.genericRequest = genericRequest;
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

export function toolsForProvider(providerKey: string): string[] {
  const provider = PROVIDERS[providerKey];
  if (!provider || provider.implemented === false) return [];
  return provider.tools;
}
