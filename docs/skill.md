---
name: grantry
description: |
  Use grantry when the user wants an AI agent to call external SaaS APIs
  (GitHub, Notion, Google Drive/GSC/Ads/Maps, HubSpot, Attio, Clay, HeyReach,
  Chatwork, Channel Talk, Railway, Resend, Slack, Reddit, X, Discord, LINE, Airtable, Linear,
  SendGrid, Vercel, Stripe, Webflow, Intercom, Customer.io, Mailchimp, Zendesk,
  WordPress, Shopify, Jira, Salesforce, LinkedIn Ads, TikTok Ads, Microsoft Ads,
  Microsoft Teams, AWS, Snowflake, Google Calendar/Sheets/Tag Manager/Cloud, BigQuery) under OAuth/PAT authentication
  with tenant isolation. grantry (formerly "grantry-auth", deployed as "agent-oauth") is a
  Hono/TypeScript service that holds encrypted credentials and exposes them as
  MCP tools, so the agent never sees raw tokens. Triggers: mentions of
  "grantry" / "grantry-auth" / "agent-oauth", wiring an agent to a SaaS via OAuth or PAT,
  "ツール権限管理", "テナント分離 / scope ベースの認可", or any request to give
  an AI agent controlled API access. Do NOT trigger for: general OAuth-flow
  questions, building a brand-new OAuth app from scratch, or unrelated API docs.
---

# grantry (formerly grantry-auth / agent-oauth)

## Quick facts
- **Service**: Hono/TypeScript app. **Dashboard + OAuth**: `https://app.grantry.ai`.
  **MCP (agent-facing, stable)**: `https://api.grantry.ai` — split on purpose so the
  MCP URL never moves. The legacy `https://agent-oauth-production.up.railway.app`
  still works as an alias (same service, same DB).
- **Source**: `github.com/gentityapp/grantry`
- **MCP endpoint**: `POST https://api.grantry.ai/mcp`
  (JSON-RPC 2.0: `tools/list`, `connections/list`, `tools/call`; `tools/list`
  needs no auth, `connections/list` and `tools/call` require the agent token)
- **Auth**: `Authorization: Bearer gn_agt_<token>` for MCP. The dashboard `/ui/*`
  uses a **better-auth email+password session** (NOT the agent token). There is
  **no `/admin` HTTP API** and **no `X-Admin-Token`** — tokens are minted through
  the UI only.
- **Scope model**: a scope is backed by the `Tenant` table and has an **immutable `slug`**
  (the wire key, e.g. `grantry-dev` — this is what callers pass as `scope`) and a
  freely **renameable `displayName`** (dashboard label only). Each `Connection`
  belongs to a scope; `scope` always equals the scope slug. Agents receive
  explicit `AgentConnectionGrant(agentId, connectionId)` rows. Tool calls pass
  `scope` in `arguments` to pick the credential. Renaming a scope's display
  name never breaks agents.
- Format: `<provider>/<tool>` (e.g. `github/git_push_repo`).

## The scope rule (the #1 gotcha)
A tool call is allowed only if **all** of these hold (`src/policy.ts`):
1. the calling agent exists, is enabled, and is not expired;
2. the provider implements the requested tool;
3. a granted `Connection` exists with `(provider, scope, enabled=true)`;
4. the agent and connection share the same workspace boundary, or the same owner
   for legacy workspace-less rows.

Therefore: the `scope` you pass in `arguments` must **exactly equal** the scope the
connection was registered under (its scope name). Passing no scope, or a scope
that has no granted connection, returns `-32010 policy denied (no granted enabled
connection …)`. A connection registered at `scope=""` only matches calls that
send no scope at all.

You don't have to know the scope in advance, and you should never guess it:
**`connections/list` resolves the exact scope from the token** (see Procedure §0).

## Procedure

### 0. Connect & verify FIRST — the moment you have a token
When handed a `gn_agt_…` token (or asked to "connect" / "繋いでみて" / test a
provider), your **first call is `connections/list`**, not a question to the user.
One authenticated call returns the exact `(provider, scope)` pairs this agent can
use *and* the tools callable against each — everything you need to connect, with
**no scope guessing and no brute-forcing**:
```json
POST /mcp
Authorization: Bearer gn_agt_<token>
{ "jsonrpc": "2.0", "id": 1, "method": "connections/list", "params": {} }
```
```json
{ "jsonrpc": "2.0", "id": 1, "result": { "connections": [
  { "provider": "google_gsc", "scope": "grantry-dev", "label": "GSC – gentity",
    "tools": ["google_gsc/list_sites", "google_gsc/search_analytics"] }
] } }
```
Then **immediately run a read-only tool** from that connection's `tools` as a
smoke test — pass the returned `scope` verbatim. Read-only calls (`*/list_*`,
`*/get_*`, `*/search*`, `query_db`) are safe, so do this **without asking for
confirmation**:
```json
{ "name": "google_gsc/list_sites", "arguments": { "scope": "grantry-dev" } }
```
That single round-trip *is* the connectivity check — report the result.

**Only stop to ask the user when** `connections/list` returns an empty list (the
agent has no usable enabled connection): point them to `/ui/tenants` to add one,
or ask which scope — never brute-force scope names against `tools/call`.

### 1. Discover tools (optional)
`connections/list` already tells you the callable tools per connection. If you
want the full advertised set (with input schemas) instead, use `tools/list` —
it needs no auth and, with the token, is already scoped to this agent's tools:
```bash
curl -s -X POST https://api.grantry.ai/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 2. Call a tool with scope
Use the exact `scope` from `connections/list`:
```json
POST /mcp
Authorization: Bearer gn_agt_<token>
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "github/list_repos",
    "arguments": { "scope": "grantry-dev" }
  }
}
```

### 4. Issue / rotate an agent token (UI only)
1. Log in at `/login` (register at `/register`; forgot password → `/forgot-password`).
2. Tokens are minted by the **scope wizard** (`/tenants/new`) when you create a
   scope + agent, by **`/agents/new`** for a cross-scope agent (check multiple
   scopes to grant their connections), and can be
   rotated from `/agents` (`POST /agents/:id/rotate`).
   The plaintext `gn_agt_…` is shown **once** — copy it then.

### 5. Add a new connection (credential)
Go to `/tenants/new` (or `/tenants/:scope/edit` to add to an existing scope):
- **GitHub**: paste a **PAT** (`github.com/settings/personal-access-tokens`) *or*
  click Connect → OAuth (`/oauth/github/start`). OAuth needs `GITHUB_CLIENT_ID` /
  secret set as Railway env vars; the OAuth callback is
  `https://app.grantry.ai/oauth/github/callback` (register this URL in the
  provider's OAuth app settings — the legacy Railway domain may also be listed).
- **Notion**: paste an internal integration token (`ntn_…` / `secret_…`).
- **Google (Drive/GSC/Ads)**: OAuth only, via `/oauth/<provider>/start`.
- **Google Workspace data (google_admin / gmail / google_drive / google_calendar /
  google_sheets)**: in addition to per-user OAuth, these support **Service Account
  + Domain-Wide Delegation (DWD)** — the multi-tenant approach. See §5a.
- **HubSpot**: paste a Private App access token.
- **Attio**: paste a workspace access token from Settings > Developers > Access tokens.
- **Clay**: paste a Public API key from Clay Settings > Account > API keys (beta)
  (sent as `clay-api-key` to `https://api.clay.com/public/v0`; the legacy "API key"
  on the same page is rejected).
- **HeyReach**: paste a Public API key.
- **Chatwork**: paste a Chatwork API token.
- **Channel Talk**: paste JSON `{"accessKey":"…","accessSecret":"…"}` from the
  Channel desk Settings > Security > API (sent as x-access-key/x-access-secret).
- **SmartHR (custom provider)**: create a custom provider first, then add a PAT
  connection. Custom provider fields:
  - `Provider key`: `smarthr`
  - `Label`: `SmartHR`
  - `API base URL`: `https://<tenant>.smarthr.jp/api` (do **not** include
    `/v1`; the check path supplies that)
  - `Auth style`: `Authorization: Bearer token`
  - `API key header`: leave blank
  - `Allowed path prefixes`: `/v1`
  - `Connection check path`: `/v1/crews`
  - `Token settings URL`: optional / blank is OK

  After creating the custom provider, add the connection and paste the SmartHR
  access token in the credential field. A successful Recheck shows
  `active`, `ok`, `capabilities ok`, and `Connection check: 1 ok`. If SmartHR
  asks for allowed IP addresses, register Grantry production's Railway
  **Static Outbound IPs** for service `agent-oauth` in environment `production`
  (the dashboard domain IP is not the outbound API source IP). Enable Static
  Outbound IPs in Railway service networking, add every displayed IPv4 address
  to SmartHR with no subnet mask for single IPs, redeploy, then Recheck.
- **Railway Project Token**: paste a Project Token from Project Settings >
  Tokens. These are scoped to one project environment.
- **Railway API Token**: paste an Account or Workspace API Token from Account
  Settings > Tokens. These are sent as Bearer tokens.
- **Resend**: paste a Resend API key. Sending requires `sending_access` or
  `full_access` and a verified sending domain.
- **Slack**: paste a **Bot User OAuth Token** (`xoxb-…`) from the app's OAuth &
  Permissions page, *or* click Connect → OAuth (`/oauth/slack/start`). OAuth needs
  `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` set as env vars and the callback
  `https://app.grantry.ai/oauth/slack/callback` registered in the Slack app.
- **Google Maps**: paste a Google Maps Platform API key from Google Cloud Console
  > APIs & Services > Credentials. Enable the Geocoding, Places, Directions, and
  Distance Matrix APIs for the key.
- **Reddit**: OAuth only, via `/oauth/reddit/start`. Needs `REDDIT_CLIENT_ID` /
  `REDDIT_CLIENT_SECRET` (register a "web app" at `reddit.com/prefs/apps` with the
  callback `https://app.grantry.ai/oauth/reddit/callback`). Grants read + posting,
  commenting, and voting as the authorized account.
- **X (Twitter)**: OAuth only, via `/oauth/x/start`. Needs `X_CLIENT_ID` /
  `X_CLIENT_SECRET` (OAuth 2.0 Confidential client / Web App with callback
  `https://app.grantry.ai/oauth/x/callback`). Grants read + posting and deleting
  tweets as the authorized account.
- **Discord**: paste a **Bot Token** from `discord.com/developers/applications` >
  your app > Bot. Invite the bot to the target server with the needed permissions
  (and enable the Server Members Intent for `list_members`).
- **LINE**: paste a **Channel Access Token** from the LINE Developers console
  (`developers.line.biz/console`) > your Messaging API channel > Messaging API tab.
  Scoped to one official account / channel.
- **NocoDB**: paste an **API token** from Account Settings > Tokens. Self-hosted
  instances also enter their **Server URL**; NocoDB Cloud leaves it blank.
- **LangGraph Platform**: paste a **LangSmith API key** (`smith.langchain.com/settings`)
  and the **Deployment URL** of the LangGraph Server, e.g.
  `https://my-agent-abc123.us.langgraph.app`. One connection = one deployment.
- **LangSmith**: paste an **API key** from Settings > API keys
  (`smith.langchain.com/settings`). EU-region and self-hosted installations also
  enter their **API URL**; the US cloud leaves it blank.
- **PAT (paste an API key / token)**: **Airtable** (PAT), **Linear** (personal API
  key, no Bearer prefix), **SendGrid** (API key), **Vercel** (token), **Stripe**
  (secret key), **Webflow** (token), **Intercom** (access token), **Customer.io**
  (App API key; JSON `{"token","region"}` for EU), **Mailchimp** (key with `-dc`
  suffix), **LinkedIn Ads** / **TikTok Ads** (OAuth access token pasted in).
- **JSON credential blobs (paste JSON)**: **Zendesk** `{"subdomain","email","token"}`,
  **WordPress** `{"site","username","app_password"}`, **Shopify** `{"shop","token"}`,
  **Jira** `{"site","email","token"}`, **Salesforce** `{"instance_url","token"}`,
  **Microsoft Ads** `{"developer_token","access_token","customer_id","account_id"}`,
  **AWS** `{"accessKeyId","secretAccessKey","region"}`, **Snowflake**
  `{"account","token","warehouse","database","schema","role"}`.
- **Google OAuth (via `/oauth/<provider>/start`, reuse `GOOGLE_CLIENT_ID/SECRET`)**:
  **google_calendar**, **google_sheets**, **google_tag_manager**, **google_cloud**,
  **bigquery** — enable the matching API in the Google Cloud project.
- **Microsoft Teams OAuth**: create a Microsoft identity platform app in Entra,
  register `https://app.grantry.ai/oauth/microsoft_teams/callback`, paste that
  app's client ID/secret as a workspace OAuth app, then connect the user. Teams
  message read scopes usually require Microsoft Entra admin consent.
Set the connection's **scope to the scope name**; that's the scope callers must pass.

### 5a. Google Workspace via Service Account + Domain-Wide Delegation (DWD)
For Workspace **domain data** (`google_admin`, `gmail`, `google_drive`,
`google_calendar`, `google_sheets`) across **other tenants' Workspaces**, per-user
OAuth doesn't scale: our consent screen is in Testing (refresh tokens expire ~7
days, 100-user cap), and going to production requires Google brand verification
(sensitive scopes) or a CASA security assessment (restricted Gmail/Drive scopes).
DWD sidesteps all of that — the customer's Workspace admin authorizes our service
account once, with no Google verification, no CASA, and no token expiry.

Other Google providers (`google_ads`, `google_gsc`, `google_analytics`,
`bigquery`, `google_tag_manager`, `google_cloud`) stay on per-user OAuth — they
key off individual Google accounts / GCP IAM, not Workspace domain data, so DWD
doesn't apply.

**One-time setup (Grantry operator):**
1. In Google Cloud Console, create a **service account** in the `gentity` project
   and download its **JSON key** (`console.cloud.google.com/iam-admin/serviceaccounts`).
2. In `/tenants/:scope/edit`, add a connection and pick the provider with auth
   type **Service Account (DWD)**. Paste the **full JSON key** and the **admin
   email to impersonate** (the `subject` — a real admin in the customer's domain).
   The key + subject are encrypted at rest; only non-secret metadata (client ID,
   client email, subject, scopes) is stored in the clear for display.
3. The edit page then shows the **Client ID** (the SA's numeric `client_id`) and
   the **OAuth scopes** to hand to the customer.

**Customer onboarding (their Workspace admin, once):**
1. Admin console → **Security → Access and data control → API controls →
   Domain-wide delegation** → **Add new**.
2. Paste the **Client ID** from step 3 above.
3. Paste the **comma-separated OAuth scopes** shown on the same page.
4. Authorize. (Propagation can take a few minutes.)

Then click **Recheck** on the connection: Grantry mints a real DWD access token
to confirm the delegation works. If the admin hasn't registered the client ID +
scopes yet, the mint fails with `unauthorized_client` and the exact client ID /
subject / scopes to fix are shown.

At call time Grantry signs a JWT with the SA key, impersonates the `subject`, and
exchanges it for a short-lived access token (cached in-process) — agents call the
tools exactly as before. A DWD connection coexists with an OAuth connection for
the same provider+scope; disambiguate with `auth_type` (`service_account` vs
`oauth`) or `connection_id` if both exist (see the scope rule / error `-32010`).

### 6. Grant an agent access to a scope
1. Ensure a connection exists at that scope (step 5).
2. Grant the connection to the agent. The dashboard does this automatically
   when creating an agent via `/agents/new` or the scope wizard.
3. Use `connections/list` with the agent token to verify the exact
   `connection_id`, provider, and scope the agent can use.

## Providers & tools
- `ping` — liveness (returns `pong from <agent>`)
- **grantry** (system metadata, no SaaS credential required): `get_skill`,
  `get_providers`; plus capability discovery (token required): `list_scopes`,
  `find_agent`, `route`, `delegate`
- **grantry (admin)** (gn_adm_ admin API key from `/api-keys`, connected as a
  normal `provider="grantry"` connection — see the Self-management section):
  `list_agents`, `list_tenants`, `list_connections`, `create_tenant`,
  `create_agent`, `update_agent`, `assign_agent`, `unassign_agent`,
  `rotate_agent_token`, `grant_scope`, `revoke_scope`, `create_connection`
- **github** (PAT or OAuth; scopes `repo`, `read:user`):
  `list_repos`, `get_repo`, `get_file_contents`, `list_issues`, `create_issue`, `git_push_repo`, `create_repo`
- **notion** (PAT): `list_dbs`, `get_page`, `query_db`, `create_page`,
  `update_page`, `append_blocks`, `update_blocks`, `update_page_status`
- **google_drive** (OAuth, read-only): `list_files`, `get_file`, `search`
- **google_gsc** (OAuth, read-only): `list_sites`, `search_analytics`
- **google_ads** (OAuth, read-only): `list_campaigns`, `get_campaign`
- Most implemented providers also expose read-only `request` as a safe generic
  provider API escape hatch. Use curated tools first; use `<provider>/request`
  with `method: "GET"`, a relative `path`, and optional `query` when a read API
  exists but Grantry has no curated tool for it. Large list responses may include
  `pagination` metadata (`has_more`, `next_cursor`, `cursor_source`); continue
  with the provider's cursor query parameter when more pages are needed. Use `<provider>/check_connection`
  to run provider smoke tests, and `<provider>/list_capabilities` to inspect
  known operations, required scopes, and generic request guardrails.
- **File uploads.** A provider endpoint that wants a multipart file (or an
  https URL it downloads itself) cannot be fed over JSON-RPC. Upload the bytes
  to grantry first, outside the MCP transport:

  ```bash
  curl -H "Authorization: Bearer gn_agt_..." -F file=@deck.pdf https://api.grantry.ai/files
  ```

  With no static token at hand (OAuth clients), call `grantry/create_upload_url`
  first and POST to the URL it returns — the ticket is single-use and expires:

  ```bash
  curl -F file=@deck.pdf "https://api.grantry.ai/files?ticket=..."
  ```

  The response carries `file_id` plus a short-lived, unguessable `url`
  (30 min by default, override with a `ttl_seconds` form field, max 24h).
  Pass `files: [{ field: "file", file_id: "..." }]` to `<provider>/request` and
  grantry streams the bytes into a multipart provider call — nothing is exposed
  publicly and the file never passes through the model's context. Use `url`
  only for providers that insist on fetching the file themselves. Uploads
  expire on their own; `DELETE /files/{id}` with the agent token purges one
  immediately.
- **hubspot** (Private App token or OAuth): `list_deals`, `get_contact`,
  `create_deal`, `list_marketing_emails`, `get_marketing_email`,
  `get_marketing_email_statistics`, `request`
- **attio** (access token): `search_records`, `list_records`, `get_record`,
  `create_record`, `upsert_record`, `update_record`, `list_notes`, `get_note`,
  `create_note`, `delete_note`, `list_tasks`, `get_task`, `create_task`,
  `update_task`, `delete_task`, `list_threads`, `get_thread`, `create_comment`,
  `get_comment`, `delete_comment`, `list_meetings`, `get_meeting`
- **clay** (Public API key): `me`, `search_reference`, `search`, `search_next`,
  `query_tables` (Enterprise), `run_routine`, `get_routine_run`,
  `query_workflow_runs`, `push_webhook`, `raw_request`
- **heyreach** (Public API key): `check_api_key`, `list_campaigns`,
  `get_campaign`, `pause_campaign`, `resume_campaign`, `add_leads_to_campaign`,
  `list_leads`, `list_conversations`, `list_lead_lists`, `create_empty_list`,
  `get_overall_stats`
- **chatwork** (API token): `get_me`, `list_contacts`, `list_rooms`, `get_room`,
  `list_room_members`, `list_messages`, `get_message`, `send_message`,
  `list_my_tasks`, `list_room_tasks`, `get_room_task`, `create_room_task`,
  `list_room_files`, `get_room_file`
- **channel_talk** (JSON access key/secret): `list_managers`, `get_manager`,
  `list_user_chats`, `get_user_chat`, `list_messages`, `send_message`, `get_user`
- **channel_talk_documents** (JSON access key/secret; a **separate** Documents
  *space* API key, sent as HTTP Basic to document-api.channel.io — NOT the chat
  Open API key): `list_articles`, `get_article`, `create_article`,
  `delete_article`, `list_topics`, `get_topic`. v1 has no article-update endpoint.
- **railway** (Project token): `graphql`, `project_token_info`,
  `introspect_schema`
- **railway_api** (Account/Workspace API token): `graphql`, `introspect_schema`
- **resend** (API key): `send_email`, `list_emails`, `get_email`,
  `list_domains`, `get_domain`, `list_api_keys`
- **slack** (Bot token or OAuth; scopes `channels:read`, `groups:read`,
  `channels:history`, `groups:history`, `chat:write`, `users:read`): `auth_test`, `list_channels`, `get_channel`,
  `list_messages`, `get_thread`, `post_message`, `update_message`,
  `list_users`, `get_user`
- **google_maps** (API key): `geocode`, `reverse_geocode`, `place_search`,
  `place_details`, `directions`, `distance_matrix`
- **reddit** (OAuth; read + write): `get_me`, `get_subreddit`, `list_posts`,
  `search`, `get_comments`, `submit_post`, `submit_comment`, `vote`
- **x** (OAuth; read + write): `get_me`, `get_user`, `get_user_tweets`,
  `search_recent`, `get_tweet`, `post_tweet`, `delete_tweet`
- **zoom** (OAuth; needs `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET`, callback
  `/oauth/zoom/callback`): `get_me`, `list_users`, `list_recordings`,
  `get_meeting_recordings`, `list_meetings`, `get_meeting`, `create_meeting`,
  `get_meeting_participants`. Recording tools return cloud-recording metadata +
  per-file `download_url`s (fetch the file out-of-band; grantry returns the URL,
  not the media bytes).
- **discord** (Bot token; read + write): `get_me`, `list_guilds`, `get_guild`,
  `list_channels`, `get_channel`, `list_messages`, `get_message`, `send_message`,
  `edit_message`, `delete_message`, `list_members`, `get_user`
- **line** (Channel access token; read + write): `get_bot_info`, `get_quota`,
  `get_quota_consumption`, `get_profile`, `push_message`, `reply_message`,
  `multicast`, `broadcast`, `get_group_summary`, `get_group_member_count`,
  `get_group_member_profile`
- **airtable** (PAT; read+write): `list_bases`, `list_tables`, `list_records`, `get_record`, `create_record`, `update_record`, `delete_record`
- **linear** (PAT; read+write): `get_me`, `list_teams`, `list_issues`, `get_issue`, `search_issues`, `create_issue`, `update_issue`
- **sendgrid** (API key; read+write): `send_email`, `list_templates`, `get_template`, `get_stats`, `list_bounces`, `list_api_keys`
- **vercel** (PAT; read): `get_user`, `list_projects`, `get_project`, `list_deployments`, `get_deployment`, `list_domains`
- **stripe** (secret key; read+write): `list_customers`, `get_customer`, `create_customer`, `list_charges`, `list_payment_intents`, `create_payment_intent`, `list_invoices`
- **webflow** (PAT; read+write): `list_sites`, `get_site`, `list_collections`, `list_items`, `create_item`, `publish_site`
- **intercom** (PAT; read+write): `get_me`, `list_contacts`, `get_contact`, `search_contacts`, `create_contact`, `list_conversations`, `reply_conversation`
- **customerio** (App API key; read+write): `send_transactional`, `list_campaigns`, `get_campaign`, `get_campaign_metrics`, `get_customer`, `list_newsletters`
- **mailchimp** (API key; read+write): `ping`, `list_lists`, `get_list`, `list_members`, `add_member`, `list_campaigns`
- **zendesk** (JSON cred; read+write): `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `add_comment`, `search`, `list_users`
- **wordpress** (JSON cred; read+write): `list_posts`, `get_post`, `create_post`, `update_post`, `list_pages`, `list_categories`
- **shopify** (JSON cred; read+write): `list_products`, `get_product`, `create_product`, `list_orders`, `get_order`, `list_customers`
- **jira** (JSON cred; read+write): `search`, `get_issue`, `create_issue`, `update_issue`, `add_comment`, `list_projects`, `transition_issue`
- **salesforce** (JSON cred; read+write): `query`, `search`, `get_record`, `create_record`, `update_record`, `delete_record`
- **linkedin_ads** (access token; read): `list_ad_accounts`, `get_ad_account`, `list_campaigns`, `get_campaign`, `get_analytics`
- **tiktok_ads** (access token; read): `get_user_info`, `get_advertiser_info`, `list_campaigns`, `list_adgroups`, `list_ads`, `get_report`
- **microsoft_ads** (JSON cred; read; SOAP): `get_user`, `get_accounts_info`
- **microsoft_teams** (OAuth via Microsoft Graph; read + write): `get_me`,
  `list_joined_teams`, `list_channels`, `list_messages`, `get_message`,
  `list_replies`, `send_message`, `send_reply`
- **aws** (JSON cred; SigV4; read): `get_caller_identity`, `s3_list_buckets`, `s3_list_objects`
- **snowflake** (JSON cred; read+write): `execute_statement`, `get_statement`, `cancel_statement`
- **google_calendar** (OAuth; read+write): `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`
- **google_sheets** (OAuth; read+write): `get_spreadsheet`, `get_values`, `batch_get_values`, `update_values`, `append_values`, `create_spreadsheet`
- **google_tag_manager** (OAuth; read-only): `list_accounts`, `list_containers`, `get_container`, `list_workspaces`, `list_tags`
- **google_cloud** (OAuth; read-only): `list_projects`, `get_project`, `list_services`, `list_log_entries`
- **bigquery** (OAuth; read+query): `list_datasets`, `list_tables`, `get_table`, `query`, `get_job`

### GitHub tool arguments (besides `scope`)
- `get_repo`, `list_issues`: `owner`, `repo` (list_issues also `state`, default `open`)
- `get_file_contents` (read): `owner`, `repo`, `path` (file or dir; `""` = repo root),
  `ref?` (branch/tag/commit). A file returns decoded UTF-8 `content` (`truncated:true`
  for files >1MB — fetch the blob by `sha`); a directory returns `entries[]`.
- `create_issue`: `owner`, `repo`, `title`, `body?`
- `git_push_repo`: `owner`, `repo`, `branch?` (default `main`), `commit_message?`,
  `files` (object `{ "path": "utf8 content" }`). Uses the Contents API — works on
  empty and non-empty repos.
- `create_repo`: `name`, `org?` (omit = personal account), `description?`, `private?`

### Grantry system tool arguments
- `get_skill` (read): optional `format` (`markdown`). Returns the latest
  `docs/skill.md` content plus metadata (`updated_at`, `commit_sha`, version).
- `get_providers` (read): optional `include_tools` boolean. Returns implemented
  provider metadata, auth types, links, and tool names. When called **with an
  agent token**, `metadata.scopes` also lists the scopes that token can
  reach (the full per-scope detail is in `list_scopes`).
- `list_scopes` (read, token required): no arguments. Returns the
  **scopes** this agent token can access, each with its connected `providers`
  and the exact `connections` (`provider`, `auth_type`, `connection_id`, `label`,
  callable `tools`). This is the authoritative answer to *"which scopes do I
  have?"* — call it instead of guessing scope names or inferring them from a
  server/tool name. `connections/list` returns the same data flattened by
  connection; `list_scopes` groups it by scope.
- `find_agent` (read, token required): `task` (plain-language description),
  optional `scope`. Answers the inverse question *"which agent can do this?"* —
  keyword-matches the task to candidate tools, then returns ranked agents in
  your workspace that can call them (with the scopes and connection each
  would use). Also returns `scopeMatches` (accessible scopes whose name appears
  in the task) and, when no agent matched, a `hint` pointing at `list_scopes` —
  so an empty `candidates` is never mistaken for "that scope doesn't exist".
  Never returns tokens. See `docs/agent-orchestration.md`.
- `route` (read, token required): `tool` (e.g. `railway/graphql`), optional
  `scope`, optional `action` (`read`/`write`, advisory). The structured form of
  `find_agent` when you already know the tool. Returns the same ranked
  `candidates`.

- `delegate` (token required): `agent_id`, `tool`, `scope`. Mints a
  **single-use, time-boxed grant token** so you can run one `(tool, scope)` via
  a capable peer — grantry does **not** execute it for you. The target must
  share your owner and actually be capable (checked server-side). Returns
  `{ delegationId, grant_token, target, expiresAt, usage }`. Then **you** make a
  normal `tools/call` for that tool, passing `grant_token` in its arguments;
  grantry gates it and routes the call through the target's connection (you
  never see the target's credential). The redeemed call is audited under the
  target agent with `delegatedById` + `delegationId`. Get `agent_id` from
  `find_agent`/`route`.

  Example: `delegate(agent_id, "railway/graphql", "grantry-prod")` → take the
  returned `grant_token` → `railway_graphql({ scope: "grantry-prod",
  grant_token: "gn_grant_…", query: "…" })`.

When a `tools/call` is denied (`-32010`) but another agent in your workspace
*could* run it, the error's `data.capableAgents` lists who — so a dead-end
becomes a signpost. Ask an admin to route the work, call `find_agent`, or (for
a same-owner peer) `delegate` to get a one-time grant and run it yourself.

### Notion tool arguments (besides `scope`)
- `list_dbs`: no additional arguments.
- `get_page`: `page_id`; optional `include_children` to include first-level block children.
- `query_db`: `database_id`; optional `filter`, `sorts`, `page_size`, `start_cursor`.
  Shortcut filters: `slug` and optional `slug_property` (default `Slug`).
- `create_page`: raw Notion `parent` and `properties`.
- `update_page`: `page_id`; one or more of raw Notion `properties`, `archived`,
  `icon`, `cover`. Use this for existing page title/excerpt/status/date updates.
- `append_blocks`: `page_id` or `parent_block_id`, raw Notion `children`, optional
  `after`. Use this for adding headings, paragraphs, related links, and tables.
- `update_blocks`: `operations[]` with `block_id` and either raw Notion `patch` or
  `archived`; max 25 operations. Use this for targeted block edits or archiving.
- `update_page_status`: legacy helper; `page_id`, `status`, optional `status_name`.

### Attio tool arguments (besides `scope`)
- `search_records` (read): `query`, `objects[]` (e.g. `people`, `companies`, `deals`),
  optional `limit` (max 25), `request_as`.
- `list_records` (read): `object`; optional `filter`, `filter_view_id`, `sorts`,
  `limit` (max 500), `offset`.
- `get_record` (read): `object`, `record_id`.
- `create_record` (write): `object`, `values` (attribute slug/ID keyed object).
- `upsert_record` (write): `object`, `matching_attribute`, `values`.
- `update_record` (write): `object`, `record_id`, `values`.
- `list_notes` (read): optional `parent_object`, `parent_record_id`, `limit` (max 50), `offset`.
- `get_note` (read): `note_id`.
- `create_note` (write): `parent_object`, `parent_record_id`, `title`, `content`;
  optional `created_at`, `meeting_id`. Use this to record email summaries or
  follow-up notes on a person/company/deal record.
- `delete_note` (write): `note_id`.
- `list_tasks` (read): optional `linked_object`, `linked_record_id`, `assignee`,
  `is_completed`, `limit` (max 50), `offset`.
- `get_task` (read): `task_id`.
- `create_task` (write): `content`; optional `deadline_at`, `is_completed`,
  `linked_records`, `assignees`.
- `update_task` (write): `task_id`; optional `deadline_at`, `is_completed`,
  `linked_records`, `assignees`.
- `delete_task` (write): `task_id`.
- `list_threads` (read): optional record filter (`object` + `record_id`) or list
  entry filter (`list` + `entry_id`), plus `limit` (max 50), `offset`.
- `get_thread` (read): `thread_id`.
- `create_comment` (write): `content`; optional `thread_id` to reply, or `record`
  / `entry` to create a new record/list-entry comment, plus `author`, `created_at`.
- `get_comment` (read): `comment_id`.
- `delete_comment` (write): `comment_id`.
- `list_meetings` (read): optional `linked_object`, `linked_record_id`,
  `participants`, `sort`, `ends_from`, `starts_before`, `timezone`, `cursor`,
  `limit` (max 200).
- `get_meeting` (read): `meeting_id`.

### Clay tool arguments (besides `scope`)
- `me` (read): no additional arguments. Returns the user/workspace behind the key.
- `search_reference` (read): no additional arguments. Returns the Clay search
  query syntax (markdown). Call it before writing a `search` query.
- `search` (read, consumes plan result budget): `query`; optional `limit`
  (first page, default 20, free plans cap at 50). Returns `search_id`,
  `source_type` and the first page.
- `search_next` (read, consumes plan result budget): `search_id`; optional `limit`.
  Clay returns 402 when the plan's result budget is exhausted.
- `query_tables` (read, Enterprise plans only): `table_id` (from the Clay URL,
  `t_...`) with optional `select`, `filter`, `order_by`, `field_mode`; or a full
  structured `query`; optional `limit` (max 100), `cursor`.
- `run_routine` (write, consumes Clay credits): `routine_id`, `items`
  (1-100 `{ id, inputs }`); optional `webhook_id`.
- `get_routine_run` (read): `routine_run_id`; optional `batch`, `cursor`, `limit`.
  `in_progress: true` (HTTP 202) means poll again.
- `query_workflow_runs` (read, beta): `query`; optional `limit`, `cursor`.
- `push_webhook` (write, no API key): `webhook_url` (the table's Webhook source
  URL, `https://api.clay.com/v3/sources/webhook/...`) plus `data` (one row) or
  `rows` (array). This is the only way to add rows to a Clay table; the Public
  API has no row write endpoint.
- `raw_request` (read/write depending on method): `path` under `/public/v0`
  (auto-prefixed; legacy `/v1` and `/v3` paths are rejected); optional `method`,
  `query`, `data`/`body`.

### HeyReach tool arguments (besides `scope`)
- `check_api_key` (read): no additional arguments.
- `list_campaigns` (read): optional `offset`, `limit` (max 100), `data` raw filters.
- `get_campaign` (read): `campaign_id`.
- `pause_campaign` / `resume_campaign` (write): `campaign_id`.
- `add_leads_to_campaign` (write): `campaign_id`, `leads`; or raw `data`.
- `list_leads` (read): optional `campaign_id`, `lead_list_id`, `statuses`,
  `offset`, `limit` (max 100), `data` raw filters.
- `list_conversations` (read): optional `offset`, `limit` (max 100), `data` raw filters.
- `list_lead_lists` (read): optional `offset`, `limit` (max 100), `data` raw filters.
- `create_empty_list` (write): `name`; or raw `data`.
- `get_overall_stats` (read): optional raw `data` filters.

### Railway tool arguments (besides `scope`)
- `project_token_info` (read): no additional arguments. For project tokens,
  returns the project/environment IDs the token is scoped to.
- `introspect_schema` (read): no additional arguments. Returns the Railway
  GraphQL schema metadata.
- `graphql` (read/write depending on query): `query`; optional `variables`,
  `operation_name`. Use this for Railway GraphQL queries/mutations. Project
  tokens are sent using the `Project-Access-Token` header; account/workspace/OAuth
  tokens are sent using `Authorization: Bearer`.

### Chatwork tool arguments (besides `scope`)
- `get_me`, `list_contacts`, `list_rooms` (read): no additional arguments.
- `get_room`, `list_room_members`, `list_messages`, `list_room_tasks`,
  `list_room_files` (read): `room_id`; optional filters where exposed.
- `get_message` (read): `room_id`, `message_id`.
- `send_message` (write): `room_id`, `body`; optional `self_unread`.
- `list_my_tasks` (read): optional `assigned_by_account_id`, `status`.
- `get_room_task` (read): `room_id`, `task_id`.
- `create_room_task` (write): `room_id`, `body`, `to_ids`; optional `limit`.
- `get_room_file` (read): `room_id`, `file_id`; optional `create_download_url`.

### Channel Talk tool arguments (besides `scope`)
- `list_managers` (read): optional `limit`, `since`, `sortOrder`.
- `get_manager` (read): `manager_id`.
- `list_user_chats` (read): optional `state`, `sortOrder`, `limit`, `since`.
- `get_user_chat` (read): `user_chat_id`.
- `list_messages` (read): `user_chat_id`; optional `limit`, `since`, `sortOrder`.
- `send_message` (write): `user_chat_id`; `plain_text` (or `blocks`); optional
  `bot_name` to attribute the message to a bot.
- `get_user` (read): `user_id`.

### Resend tool arguments (besides `scope`)
- `send_email` (write): `from`, `to`, `subject`; one of `html`, `text`, or
  `react`; optional `cc`, `bcc`, `reply_to`, `scheduled_at`, `attachments`,
  `tags`, `headers`. Raw Resend request body can be passed as `data`.
- `list_emails` (read): optional `limit`, `after`, `before`.
- `get_email` (read): `email_id`.
- `list_domains` / `list_api_keys` (read): no additional arguments.
- `get_domain` (read): `domain_id`.

### Slack tool arguments (besides `scope`)
- `auth_test` (read): no additional arguments. Verifies the token and returns the
  team/user it belongs to.
- `list_channels` (read): optional `types` (comma-separated
  `public_channel,private_channel,mpim,im`), `limit`, `cursor`,
  `exclude_archived`, `team_id`.
- `get_channel` (read): `channel`; optional `include_num_members`.
- `list_messages` (read): `channel`; optional `limit`, `cursor`, `oldest`,
  `latest`, `inclusive`.
- `get_thread` (read): `channel`, `ts` (parent message timestamp); optional
  `limit`, `cursor`, `oldest`, `latest`, `inclusive`.
- `post_message` (write): `channel`; one of `text`, `blocks`, or `attachments`;
  optional `thread_ts`, `reply_broadcast`, `unfurl_links`, `unfurl_media`,
  `mrkdwn`.
- `update_message` (write): `channel`, `ts`; one of `text`, `blocks`, or
  `attachments`; optional `reply_broadcast`.
- `list_users` (read): optional `limit`, `cursor`, `team_id`.
- `get_user` (read): `user`.

### Google Maps tool arguments (besides `scope`)
All tools are read-only and send the API key as the `key` query parameter.
- `geocode` (read): `address`; optional `components`, `bounds`, `region`, `language`.
- `reverse_geocode` (read): `latlng` (e.g. `"35.6895,139.6917"`) or separate
  `lat`/`lng`; optional `result_type`, `location_type`, `language`.
- `place_search` (read): `query` (free text); optional `location`, `radius`,
  `type`, `open_now`, `page_token`, `region`, `language`.
- `place_details` (read): `place_id`; optional `fields` (comma-separated),
  `language`, `region`.
- `directions` (read): `origin`, `destination`; optional `mode`
  (`driving`/`walking`/`bicycling`/`transit`), `waypoints`, `alternatives`,
  `avoid`, `departure_time`, `arrival_time`, `units`, `language`, `region`.
- `distance_matrix` (read): `origins`, `destinations` (pipe-separated); optional
  `mode`, `avoid`, `departure_time`, `arrival_time`, `units`, `language`, `region`.

### Reddit tool arguments (besides `scope`)
- `get_me` (read): no additional arguments.
- `get_subreddit` (read): `subreddit` (without the `r/` prefix).
- `list_posts` (read): `subreddit`; optional `sort` (`hot`/`new`/`top`/`rising`/
  `controversial`, default `hot`), `time` (for top/controversial), `limit` (max
  100), `after` (pagination fullname).
- `search` (read): `query`; optional `subreddit` (restricts to that subreddit),
  `sort`, `time`, `limit`, `after`.
- `get_comments` (read): `article` (post id, with/without `t3_`); optional
  `subreddit`, `sort`, `limit`.
- `submit_post` (write): `subreddit`, `title`; `kind` (`self`/`link`, default
  inferred); `text` for self posts or `url` for link posts; optional `flair_id`.
- `submit_comment` (write): `parent` (fullname, e.g. `t3_<post>` or `t1_<comment>`),
  `text`.
- `vote` (write): `id` (fullname), `dir` (`1` up / `0` clear / `-1` down).

### X tool arguments (besides `scope`)
- `get_me` (read): optional `user_fields`.
- `get_user` (read): `username` (handle, with or without `@`); optional `user_fields`.
- `get_user_tweets` (read): `user_id` (numeric — resolve a handle via `get_user`);
  optional `max_results` (5-100), `pagination_token`, `tweet_fields`.
- `search_recent` (read): `query`; optional `max_results` (10-100), `next_token`,
  `tweet_fields`.
- `get_tweet` (read): `id`; optional `tweet_fields`.
- `post_tweet` (write): `text` (≤280 chars; optional when an image is attached);
  optional `image_urls` / `image_base64` / `media_ids` (≤4 images total),
  `reply_to`, `quote_tweet_id`. Images require the `media.write` scope.
- `delete_tweet` (write): `id` (a tweet owned by the authorized account).

### Discord tool arguments (besides `scope`)
- `get_me` (read): no additional arguments. Returns the bot user.
- `list_guilds` (read): optional `before`, `after`, `limit`, `with_counts`.
- `get_guild` (read): `guild_id`; optional `with_counts`.
- `list_channels` (read): `guild_id`.
- `get_channel` (read): `channel_id`.
- `list_messages` (read): `channel_id`; optional `around`, `before`, `after`,
  `limit` (1-100).
- `get_message` (read): `channel_id`, `message_id`.
- `send_message` (write): `channel_id`; one of `content`, `embeds`, or
  `components`; optional `tts`, `allowed_mentions`, `message_reference` (to reply),
  `flags`.
- `edit_message` (write): `channel_id`, `message_id`; optional `content`, `embeds`,
  `components`, `allowed_mentions`, `flags` (only messages sent by the bot).
- `delete_message` (write): `channel_id`, `message_id`.
- `list_members` (read): `guild_id`; optional `limit` (1-1000), `after`. Requires
  the Server Members privileged intent.
- `get_user` (read): `user_id`.

### LINE tool arguments (besides `scope`)
Messages take a `messages` array of LINE message objects; as a convenience a
plain `text` string is accepted and wrapped into a single text message.
- `get_bot_info` (read): no additional arguments. Returns the official account.
- `get_quota` / `get_quota_consumption` (read): no additional arguments.
- `get_profile` (read): `user_id`.
- `push_message` (write): `to` (user/group/room ID); `messages` or `text`;
  optional `notification_disabled`, `custom_aggregation_units`.
- `reply_message` (write): `reply_token` (from a webhook event); `messages` or
  `text`; optional `notification_disabled`.
- `multicast` (write): `to` (array of user IDs, max 500); `messages` or `text`;
  optional `notification_disabled`.
- `broadcast` (write): `messages` or `text`; optional `notification_disabled`.
- `get_group_summary` / `get_group_member_count` (read): `group_id`.
- `get_group_member_profile` (read): `group_id`, `user_id`.

### Airtable tool arguments (besides `scope`)
- `list_bases` (read): none. `list_tables` (read): `base_id`.
- `list_records` (read): `base_id`, `table`; opt `max_records`, `view`, `page_size`, `offset`, `filter_by_formula`.
- `get_record` (read): `base_id`, `table`, `record_id`.
- `create_record` (write): `base_id`, `table`; one of `fields` (object) or `records` (array).
- `update_record` (write): `base_id`, `table`, `record_id`, `fields`. `delete_record` (write): `base_id`, `table`, `record_id`.

### NocoDB tool arguments (besides `scope`)
- Credential: `{"api_token": "...", "base_url": "https://nocodb.example.com"}` — `base_url` only for self-hosted; cloud defaults to `https://app.nocodb.com`. Sent as the `xc-token` header.
- `get_me` (read): none. `list_bases` (read): opt `workspace_id` (cloud only).
- `list_tables` (read): `base_id`. `get_table` / `list_views` (read): `table_id`.
- `list_records` (read): `table_id`; opt `view_id`, `fields`, `sort`, `where`, `limit`, `offset`.
- `count_records` (read): `table_id`; opt `view_id`, `where`. `get_record` (read): `table_id`, `record_id`; opt `fields`.
- `create_records` (write): `table_id`; one of `fields` (object) or `records` (array).
- `update_records` (write): `table_id`; either `record_id` + `fields`, or `records` (array, each row carrying `Id`).
- `delete_records` (destructive): `table_id`; either `record_id` or `records` (array of `{Id}`).

### LangGraph Platform tool arguments (besides `scope`)
- Credential: `{"api_key": "lsv2_...", "base_url": "https://my-agent-abc123.us.langgraph.app"}` — `base_url` is required (every deployment has its own URL). Sent as the `x-api-key` header.
- `get_info` (read): none. `search_assistants` (read): opt `graph_id`, `name`, `metadata`, `limit`, `offset`.
- `get_assistant` / `get_assistant_schemas` (read): `assistant_id`.
- `search_threads` (read): opt `metadata`, `status`, `values`, `limit`, `offset`. `create_thread` (write): opt `thread_id`, `metadata`, `if_exists`.
- `get_thread` (read): `thread_id`. `get_thread_state` (read): `thread_id`; opt `checkpoint_id`.
- `get_thread_history` (read): `thread_id`; opt `limit`, `before`, `metadata`.
- `list_runs` (read): `thread_id`; opt `limit`, `offset`. `get_run` (read): `thread_id`, `run_id`.
- `create_run` (write): `assistant_id`; opt `thread_id` (omit for a stateless background run), `input`, `config`, `metadata`, `webhook`, `interrupt_before`, `interrupt_after`, `multitask_strategy`. Returns immediately.
- `run_wait` (write): same args; blocks and returns the final output. Omit `thread_id` for a stateless run.
- `cancel_run` (write): `thread_id`, `run_id`; opt `wait`, `action` (`interrupt` or `rollback`).
- `search_crons` (read): opt `assistant_id`, `thread_id`, `limit`, `offset`. `delete_cron` (destructive): `cron_id`.
- `search_store_items` (read): opt `namespace_prefix`, `filter`, `query`, `limit`, `offset`.

### LangSmith tool arguments (besides `scope`)
- Credential: `{"api_key": "lsv2_...", "base_url": "https://eu.api.smith.langchain.com"}` — `base_url` only for the EU region or self-hosted; the US cloud defaults to `https://api.smith.langchain.com`. Sent as the `X-Api-Key` header.
- `list_workspaces` (read): none. Service keys are workspace-scoped and may not see this list.
- `list_projects` (read): opt `name`, `name_contains`, `limit`, `offset`. `get_project` (read): `project_id`.
- `query_runs` (read): opt `session` (project id), `filter` (e.g. `eq(run_type, "llm")`), `trace_filter`, `tree_filter`, `run_type`, `is_root`, `trace`, `parent_run`, `start_time`, `end_time`, `error`, `select`, `order`, `limit` (default 20), `cursor`.
- `get_run` (read): `run_id`.
- `list_datasets` (read): opt `name`, `name_contains`, `data_type`, `limit`, `offset`. `get_dataset` (read): `dataset_id`.
- `list_examples` (read): `dataset_id`; opt `splits`, `full_text_contains`, `filter`, `limit`, `offset`.
- `create_examples` (write): `dataset_id`; one of `inputs` (+ opt `outputs`, `metadata`) or `examples` (array).
- `list_feedback` (read): opt `run_id`, `project_id`, `key`, `limit`, `offset`.
- `create_feedback` (write): `run_id`, `key`; opt `score`, `value`, `comment`.
- `list_prompts` (read): opt `query`, `is_public`, `limit`, `offset`. `get_prompt` (read): `owner`, `repo`; opt `with_latest_manifest`.

### Linear tool arguments (besides `scope`)
- `get_me` / `list_teams` (read): none. `list_issues` (read): opt `first`.
- `get_issue` (read): `id`. `search_issues` (read): `query`.
- `create_issue` (write): `team_id`, `title`; opt `description`. `update_issue` (write): `id`; opt `title`, `description`, `stateId`, or raw `input`.

### SendGrid tool arguments (besides `scope`)
- `send_email` (write): `from`, `to`, `subject`, one of `text`/`html`; or raw `data`.
- `list_templates` (read): opt `page_size`. `get_template` (read): `template_id`.
- `get_stats` (read): `start_date`; opt `end_date`, `aggregated_by`. `list_bounces` / `list_api_keys` (read): opt time bounds / none.

### Vercel tool arguments (besides `scope`)
- `get_user` / `list_projects` / `list_domains` (read): opt `limit`, `team_id`.
- `get_project` (read): `project_id`. `get_deployment` (read): `deployment_id`. `list_deployments` (read): opt `project_id`, `app`, `limit`, `team_id`.

### Stripe tool arguments (besides `scope`)
- `list_customers` / `list_charges` / `list_payment_intents` / `list_invoices` (read): opt `limit`, `customer`, `starting_after`, `status`/`email`.
- `get_customer` (read): `customer_id`.
- `create_customer` (write): opt `email`, `name`, `description`, `phone`, `metadata`, raw `params`.
- `create_payment_intent` (write): `amount`, `currency`; opt `customer`, `description`, `metadata`.

### Webflow tool arguments (besides `scope`)
- `list_sites` (read): none. `get_site` / `list_collections` (read): `site_id`.
- `list_items` (read): `collection_id`; opt `limit`, `offset`.
- `create_item` (write): `collection_id`, `field_data`. `publish_site` (write): `site_id`.

### Intercom tool arguments (besides `scope`)
- `get_me` (read): none. `list_contacts` / `list_conversations` (read): opt `per_page`, `starting_after`.
- `get_contact` (read): `contact_id`. `search_contacts` (read): `query` (object).
- `create_contact` (write): `email` and/or `external_id`; opt `name`. `reply_conversation` (write): `conversation_id`, `admin_id`, `body`.

### Customer.io tool arguments (besides `scope`)
- `send_transactional` (write): `to`; opt `transactional_message_id`, `identifiers`, `message_data`, raw `data`.
- `list_campaigns` / `list_newsletters` (read): none. `get_campaign` / `get_campaign_metrics` (read): `campaign_id`. `get_customer` (read): `customer_id`.

### Mailchimp tool arguments (besides `scope`)
- `ping` / `list_lists` / `list_campaigns` (read): opt `count`, `offset`.
- `get_list` (read): `list_id`. `list_members` (read): `list_id`; opt `count`, `offset`, `status`.
- `add_member` (write): `list_id`, `email_address`; opt `status`, `merge_fields`.

### Zendesk tool arguments (besides `scope`)
- `list_tickets` / `list_users` (read): opt `page`, `per_page`, `sort_by`/`role`. `get_ticket` (read): `ticket_id`. `search` (read): `query`.
- `create_ticket` (write): `subject`, `body`. `update_ticket` (write): `ticket_id`; opt `status`, `priority`, `assignee_id`, raw `ticket`. `add_comment` (write): `ticket_id`, `body`; opt `public`.

### WordPress tool arguments (besides `scope`)
- `list_posts` / `list_pages` (read): opt `per_page`, `page`, `search`, `status`. `get_post` (read): `post_id`. `list_categories` (read): opt `per_page`.
- `create_post` (write): `title`; opt `content`, `status`. `update_post` (write): `post_id`; opt `title`, `content`, `status`.

### Shopify tool arguments (besides `scope`)
- `list_products` / `list_orders` / `list_customers` (read): opt `limit`, `status`, `financial_status`. `get_product` (read): `product_id`. `get_order` (read): `order_id`.
- `create_product` (write): `title`; opt `body_html`, `vendor`, `status`.

### Jira tool arguments (besides `scope`)
- `search` (read): `jql`; opt `max_results`, `fields`. `get_issue` (read): `issue_key`. `list_projects` (read): opt `max_results`, `query`.
- `create_issue` (write): `project_key`, `summary`, `issue_type`; opt `description`. `update_issue` (write): `issue_key`, `fields`. `add_comment` (write): `issue_key`, `body`. `transition_issue` (write): `issue_key`, `transition_id`.

### Salesforce tool arguments (besides `scope`)
- `query` (read): `soql`. `search` (read): `sosl`. `get_record` (read): `sobject`, `record_id`.
- `create_record` (write): `sobject`, `fields`. `update_record` (write): `sobject`, `record_id`, `fields`. `delete_record` (write): `sobject`, `record_id`.

### LinkedIn Ads tool arguments (besides `scope`)
- `list_ad_accounts` (read): opt `start`, `count`. `get_ad_account` / `list_campaigns` (read): `account_id`. `get_campaign` (read): `campaign_id`. `get_analytics` (read): `params` (object of adAnalytics query params).

### TikTok Ads tool arguments (besides `scope`)
- `get_user_info` (read): none. `get_advertiser_info` (read): `advertiser_ids`. `list_campaigns` / `list_adgroups` / `list_ads` (read): `advertiser_id`; opt `page`, `page_size`. `get_report` (read): `advertiser_id`, `params`.

### Microsoft Ads tool arguments (besides `scope`)
- SOAP-based. `get_user` (read): none. `get_accounts_info` (read): opt `customer_id` (defaults to the credential).

### Microsoft Teams tool arguments (besides `scope`)
- `get_me` / `list_joined_teams` (read): none.
- `list_channels` (read): `team_id`.
- `list_messages` (read): `team_id`, `channel_id`; optional `top` (max 50),
  `expand` (for Microsoft Graph `$expand`, e.g. `replies`).
- `get_message` (read): `team_id`, `channel_id`, `message_id`.
- `list_replies` (read): `team_id`, `channel_id`, `message_id`; optional `top`.
- `send_message` (write): `team_id`, `channel_id`, `content`; optional
  `content_type` (`text` default, or `html`).
- `send_reply` (write): `team_id`, `channel_id`, `message_id`, `content`;
  optional `content_type` (`text` default, or `html`).

### AWS tool arguments (besides `scope`)
- `get_caller_identity` / `s3_list_buckets` (read): none. `s3_list_objects` (read): `bucket`. Requests are SigV4-signed; permissions follow the IAM identity.

### Snowflake tool arguments (besides `scope`)
- `execute_statement` (write): `statement`; opt `warehouse`, `database`, `schema`, `role`, `timeout`. `get_statement` (read) / `cancel_statement` (write): `statement_handle`.

### Google Calendar tool arguments (besides `scope`)
- `list_calendars` (read): none. `list_events` (read): `calendar_id`; opt `time_min`, `time_max`, `q`, `max_results`, `single_events`, `order_by`. `get_event` (read): `calendar_id`, `event_id`.
- `create_event` (write): `calendar_id`, `start`, `end`; opt `summary`, `description`, `location`, `attendees`. `update_event` (write): `calendar_id`, `event_id`; opt fields. `delete_event` (write): `calendar_id`, `event_id`.

### Google Sheets tool arguments (besides `scope`)
- `get_spreadsheet` (read): `spreadsheet_id`; opt `ranges`, `include_grid_data`. `get_values` (read): `spreadsheet_id`, `range`. `batch_get_values` (read): `spreadsheet_id`, `ranges`.
- `update_values` / `append_values` (write): `spreadsheet_id`, `range`, `values`; opt `value_input_option`. `create_spreadsheet` (write): `title`.

### Google Tag Manager tool arguments (besides `scope`)
- `list_accounts` (read): none. `list_containers` (read): `account_id`. `get_container` / `list_workspaces` (read): `account_id`, `container_id`. `list_tags` (read): `account_id`, `container_id`, `workspace_id`.

### Google Cloud tool arguments (besides `scope`)
- `list_projects` (read): opt `filter`, `page_size`, `page_token`. `get_project` (read): `project_id`. `list_services` (read): `project_id`. `list_log_entries` (read): `project_id`; opt `filter`, `order_by`, `page_size`.

### BigQuery tool arguments (besides `scope`)
- `list_datasets` (read): `project_id`. `list_tables` (read): `project_id`, `dataset_id`. `get_table` (read): `project_id`, `dataset_id`, `table_id`. `get_job` (read): `project_id`, `job_id`.
- `query` (read/query): `project_id`, `query`; opt `max_results`, `use_legacy_sql`, `dry_run`.

## Self-management (grantry admin tools)

grantry manages itself the same way it manages any SaaS — grantry is just
another **provider**. A human mints a `gn_adm_` **admin API key** on the
dashboard (`/api-keys`), pastes it into a `provider="grantry"` connection at a
scope (e.g. `grantry-admin`), and grants that connection to an agent like any
credential. The granted agent can then manage the key's workspace over the
same `/mcp` endpoint — the building block for an "agent that creates agents".
Pass the connection's `scope` in `arguments` like any other tool call.

The key is the capability, and it cannot self-replicate: key minting is
dashboard-only (no tool can mint or list keys), agents never see connection
plaintext so they cannot copy their own key, `create_connection` refuses
`provider="grantry"`, and `grant_scope` skips grantry connections. Spreading
admin access is always a human dashboard action; rotating or disabling the key
on `/api-keys` instantly cuts off every connection using it.

Read (safe, no confirmation needed):
- `grantry_list_agents` — every agent with charter, status, token prefix, and
  granted scopes (`grantry_admin: true` marks admin-granted agents).
- `grantry_list_tenants` — every tenant (scope) with its connected providers.
- `grantry_list_connections` (`target_scope?`) — connections (id, provider,
  auth type, scope, enabled). Credentials are never returned.

In every admin call, `scope` selects the **admin connection itself** (e.g.
`"grantry-admin"`), like any provider call. The scope an operation *acts on*
is therefore passed as **`target_scope`** — the two must not be confused.

Write (confirm before calling):
- `grantry_create_tenant` (`target_scope`, `display_name?`) — idempotent; the
  slug is the immutable wire key.
- `grantry_create_agent` (`name`, `charter?`, `scopes?`) — mints a new agent
  and returns its `gn_agt_` token **once** — store it immediately; only the
  hash is persisted. `scopes` grants every enabled non-admin connection at
  each scope.
- `grantry_update_agent` (`agent_id`, `enabled?`, `charter?`).
- `grantry_assign_agent` (`agent_id`, `user_email?`, `user_id?`, `notify?`) —
  assigns an enabled agent to one workspace member for user-mode MCP access.
  Idempotent. `notify` defaults to `true`; duplicate assignments do not email.
- `grantry_unassign_agent` (`agent_id`, `user_email?`, `user_id?`) — removes
  one member's assignment. Existing user-mode MCP tokens lose access on the
  next request.
- `grantry_rotate_agent_token` (`agent_id`) — returns the new token once; the
  old token dies immediately.
- `grantry_grant_scope` / `grantry_revoke_scope` (`agent_id`, `target_scope`)
  — move connection grants (grantry admin connections excluded). Idempotent.
- `grantry_create_connection` (`provider`, `target_scope`, `credential`,
  `auth_type?`, `label?`) — registers a PAT/API-key credential (encrypted at
  rest; redacted from audit logs). OAuth providers still require the dashboard
  consent flow; `provider="grantry"` is refused.

Typical "create a worker agent" flow (admin connection at `grantry-admin`):
1. `grantry_create_tenant {scope:"grantry-admin", target_scope:"acme-prod"}`
2. `grantry_create_connection {scope:"grantry-admin", provider:"notion", target_scope:"acme-prod", credential:"ntn_…"}`
3. `grantry_create_agent {scope:"grantry-admin", name:"acme-notion-bot", charter:"…", scopes:["acme-prod"]}`
   → hand the returned token to the new agent's runtime.

Every call is audited; minted tokens and keys never appear in the audit log.

## Output contract
When asked to act via grantry:
1. If you don't already know the scope, call `connections/list` first to resolve
   it from the token — don't ask the user for a scope you can discover yourself.
2. State which tool(s) and which **scope** you'll use.
3. Show the JSON-RPC payload.
4. For **write** actions (`git_push_repo`, `create_repo`, `create_issue`,
   `notion/create_page`, `notion/update_page`, `notion/append_blocks`,
   `notion/update_blocks`, `hubspot/create_deal`, `attio/create_record`,
   `attio/upsert_record`, `attio/update_record`, `attio/create_note`,
   `attio/delete_note`, `attio/create_task`, `attio/update_task`,
   `attio/delete_task`, `attio/create_comment`, `attio/delete_comment`,
   `clay/raw_request` with non-GET methods, `clay/run_routine`,
   `clay/push_webhook`,
   `heyreach/pause_campaign`,
   `heyreach/resume_campaign`, `heyreach/add_leads_to_campaign`,
   `heyreach/create_empty_list`, `chatwork/send_message`,
   `channel_talk_documents/create_article`, `channel_talk_documents/delete_article`,
   `chatwork/create_room_task`, `channel_talk/send_message`,
   `railway/graphql` with mutations,
   `resend/send_email`, `slack/post_message`, `slack/update_message`,
   `reddit/submit_post`, `reddit/submit_comment`, `reddit/vote`,
   `x/post_tweet`, `x/delete_tweet`, `discord/send_message`,
   `discord/edit_message`, `discord/delete_message`, `line/push_message`,
   `line/reply_message`, `line/multicast`, `line/broadcast`,
   `airtable/create_record`, `airtable/update_record`, `airtable/delete_record`,
   `linear/create_issue`, `linear/update_issue`, `sendgrid/send_email`,
   `stripe/create_customer`, `stripe/create_payment_intent`, `webflow/create_item`,
   `webflow/publish_site`, `intercom/create_contact`, `intercom/reply_conversation`,
   `customerio/send_transactional`, `mailchimp/add_member`, `zendesk/create_ticket`,
   `zendesk/update_ticket`, `zendesk/add_comment`, `wordpress/create_post`,
   `wordpress/update_post`, `shopify/create_product`, `jira/create_issue`,
   `jira/update_issue`, `jira/add_comment`, `jira/transition_issue`,
   `salesforce/create_record`, `salesforce/update_record`, `salesforce/delete_record`,
   `snowflake/execute_statement`, `snowflake/cancel_statement`,
   `google_calendar/create_event`, `google_calendar/update_event`,
   `google_calendar/delete_event`, `google_sheets/update_values`,
   `google_sheets/append_values`, `google_sheets/create_spreadsheet`, …)
   get explicit confirmation first —
   these hit the real SaaS via real tokens and are not reversible. **Read-only**
   calls (incl. the connectivity smoke test) need no confirmation — just run them.
   `<provider>/request` is GET-only in the generic gateway and is treated as a
   read-only call.
5. Report the result. The `scope` is recorded in the audit log (`/audit`).

## Failure handling (error codes)
- `-32700` → JSON parse error (malformed body).
- `-32001` → missing `Authorization` header.
- `-32002` → agent token invalid/disabled/expired. Rotate it via `/ui/agents`.
- `-32010` → policy denied. Common sub-reasons:
  - `no granted enabled connection for this agent (...)` → the agent has no
    enabled connection grant at that exact provider/scope/auth/connection id.
  - `ambiguous granted connections (...)` → pass `auth_type` or `connection_id`
    when several granted connections match the same provider/scope.
  Call `connections/list` to get the exact scope and connection id, then resend.
- `-32011` → connection row vanished mid-call (rare).
- `-32029` → rate limited (default 120 `tools/call`/min per agent; HTTP 429).
  Back off and retry after a minute.
- `-32601` → unknown JSON-RPC method.
- Tool-level errors come back as `result.isError = true` with `content[].text`
  (e.g. a GitHub 4xx body), not as a JSON-RPC error.

## Examples

**1 — list repos (read) for scope `grantry-dev`:**
```json
POST /mcp   Authorization: Bearer gn_agt_<token>
{ "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"github/list_repos","arguments":{ "scope":"grantry-dev" } } }
```

**2 — push files (write, confirm first):**
```json
POST /mcp   Authorization: Bearer gn_agt_<token>
{ "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"github/git_push_repo","arguments":{
    "scope":"grantry-dev",
    "owner":"gentityapp","repo":"grantry","branch":"main",
    "commit_message":"docs: update skill",
    "files":{ "SKILL.md":"...", "docs/notes.md":"..." } } } }
```

**3 — create an issue (write):**
```json
{ "name":"github/create_issue","arguments":{
    "scope":"grantry-dev","owner":"gentityapp","repo":"gentity",
    "title":"Bug: …","body":"Steps to reproduce …" } }
```

## UI routes (top-level; legacy `/ui/*` URLs 308-redirect here)
- `/login`, `/register`, `/forgot-password`, `/reset-password` — auth
  (better-auth email+password; reset links are emailed via Resend, 1h expiry)
- `/dashboard` — overview (requires login)
- `/tenants`, `/tenants/new`, `/tenants/:scope/edit` — scope + connection wizard;
  the edit page also renames the scope's display name (slug is immutable)
- `/agents`, `/agents/new` — agents; `/agents/new` creates a **cross-scope**
  agent by granting selected scope connections
- `/providers` — provider catalog. Workspace admins can register a **custom
  provider** for any HTTP API not in the built-in list. The add form posts to
  **`/providers/custom/new`** (direct link to reach it: `https://app.grantry.ai/providers/custom/new`)
  and takes: `key` (e.g. `one_webinar`), `label`, API `base_url`, auth style
  (`bearer` = `Authorization: Bearer <key>`, `api_key` = header, `api_key_query`
  = query param), `api_key_header` (when not bearer), allowed path prefixes,
  optional smoke-test path, optional token settings URL. A custom provider
  exposes generic request tools scoped to its allowed path prefixes.
- `/api-keys` — mint/disable `gn_adm_` admin API keys (the credential behind
  `provider="grantry"` connections; workspace owner/admin only)
- `/account` — signed-in identity (email shown in every page's nav), owned
  resource counts, change password
- `/audit` — audit log (per-call scope, status, duration; request args are
  **masked**: file payloads / message bodies / token-like values are redacted)
- `/oauth/<provider>/start`, `/oauth/<provider>/callback` — OAuth connect

## Key invariants
- The raw credential is never returned to the agent. The gateway decrypts and
  injects the token server-side; the agent only ever sees tool results.
- Connection scope match is **exact**. `scope=""` is its own bucket: it only serves
  calls that send no scope.
- Agent access is connection-grant based. Provider permissions are enforced by
  the provider credential itself; Grantry does not pre-model provider ACLs.
- Every call is audited with its `scope` (`/audit`); sensitive request args are
  masked before storage.
- Token issuance/rotation is UI-first. The only API path is the `grantry_*`
  admin tools behind a `provider="grantry"` connection whose credential is a
  human-minted `gn_adm_` key (`/api-keys`); those tools can never mint keys or
  spread admin connections, so admin capability always originates from a human.
- `tools/call` is rate-limited per agent (default 120/min → `-32029`).

## Multi-server guard (multiple grantry MCP servers in one client)

grantry is the **callee** (the MCP server). The client (Claude Code, a routine,
etc.) is the **caller**. Server-side tenant/scope isolation is real, but it
cannot see a *client-level* mix-up: if a call arrives at customer B's endpoint
with B's valid token, B's server has no way to know the human was actually
working on customer A. That kind of cross-workspace misfire can only be caught
on the **client** side. This section is the client-side protocol.

Two usage models exist, and the failure mode differs:
- **Single endpoint + `scope` argument** (the JSON-RPC model above): one server,
  many scopes, disambiguated by the `scope` you pass. Misfire = wrong `scope`
  string (already covered by the scope rule + `connections/list`).
- **Multiple client-configured servers**: the client has several grantry MCP
  servers connected at once, one per customer/workspace, each surfacing as its
  own tool prefix (`mcp__grantry-A__…`, `mcp__grantry-B__…`). All tools flatten
  into one namespace, so a tool from the wrong customer's server is one wrong
  pick away. This section addresses that second model.

### Activation gate (count first — this keeps single-tenant users at zero cost)
Before the first grantry tool call, count how many distinct `mcp__grantry-*__`
**prefixes** are present in the tool namespace.
- **Exactly one** → this guard is a **no-op**. Do nothing, ask nothing, proceed
  normally. Single-workspace users never feel it.
- **Two or more** → run the protocol below.

### Protocol (only when two or more grantry prefixes coexist)
1. **Fix the active workspace before calling.** Determine which
   customer/workspace the current task belongs to. If the task context makes it
   unambiguous, adopt that prefix silently. If it is ambiguous, **stop and ask** —
   do not guess. Hold the chosen prefix as the "active prefix"
   (e.g. `mcp__grantry-A__`).
2. **Only call raw provider tools under the active prefix.** Provider tools
   (`*_request`, `attio_*`, `slack_*`, `gmail_*`, …) must come from the active
   prefix only. Never call another prefix's raw provider tools directly.
3. **Cross-workspace work goes through delegation, not direct calls.** If the
   task genuinely needs another workspace, use `grantry_delegate` /
   `grantry_route` / `grantry_find_agent` **on your own active prefix** — the
   crossing is then authorized server-side against scope/tenant and audited.
   This is the only sanctioned cross-boundary path; it does not conflict with
   this rule, it is reinforced by it.
4. **Re-confirm on switch.** When the user moves to a different customer/case,
   update the active prefix explicitly. If you notice you are about to call the
   new case's tools while the active prefix still points at the previous one,
   stop and confirm the switch instead of proceeding silently.
5. **When in doubt, stop — especially for writes.** Do not proceed to a
   side-effecting call (create / update / delete / send / push) while unsure
   which prefix it belongs to. Hold read-only calls to a lower bar than writes.

### Non-goals
- This does not replace server-side tenant/scope isolation; that stays in force
  at its own layer.
- This is a **soft** guard (model-followed). Customers who need a hard guarantee
  should pair it with a client-side `PreToolUse` hook that denies any
  `mcp__grantry-*__` call whose prefix is not the bound one.
- It never forbids `grantry_delegate` / `grantry_route`; those remain the
  intended cross-workspace channel.
