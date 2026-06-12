---
name: grantry
description: |
  Use grantry when the user wants an AI agent to call external SaaS APIs
  (GitHub, Notion, Google Drive/GSC/Ads, HubSpot, Attio, Clay, HeyReach,
  Chatwork, Railway, Resend, Slack) under OAuth/PAT authentication
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
- **Tenant model**: a `Tenant` is a real entity with an **immutable `slug`**
  (the wire key, e.g. `grantry-dev` — this is what callers pass as `scope`) and a
  freely **renameable `displayName`** (dashboard label only). Each `Connection`
  belongs to a tenant; `scope` always equals the tenant slug. A `Role` has
  `allowedTools` + `allowedScopes`. Tool calls pass `scope` in `arguments` to
  pick the credential. Renaming a tenant's display name never breaks agents.
- Format: `<provider>/<tool>` (e.g. `github/git_push_repo`).

## The scope rule (the #1 gotcha)
A tool call is allowed only if **all three** hold (`src/policy.ts`):
1. the calling agent has a bound role;
2. a bound role lists the tool in `allowedTools`, and the call's `scope` is in
   that role's `allowedScopes` — **empty `allowedScopes` = any scope**;
3. a `Connection` exists with `(provider, scope, enabled=true)` — matched on the
   **EXACT scope string**.

Therefore: the `scope` you pass in `arguments` must **exactly equal** the scope the
connection was registered under (its tenant name). Passing no scope, or a scope
that has no connection, returns `-32010 policy denied (no enabled connection …)`,
**even though the role allows any scope.** A connection registered at `scope=""`
only matches calls that send no scope at all.

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
or ask which tenant — never brute-force scope names against `tools/call`.

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
2. Tokens are minted by the **tenant wizard** (`/tenants/new`) when you create a
   tenant + agent, by **`/agents/new`** for a cross-tenant agent (check multiple
   tenants, untick tools — a dedicated 1:1 role is auto-created), and can be
   rotated from `/agents` (`POST /agents/:id/rotate`).
   The plaintext `gn_agt_…` is shown **once** — copy it then.

### 5. Add a new connection (credential)
Go to `/tenants/new` (or `/tenants/:scope/edit` to add to an existing tenant):
- **GitHub**: paste a **PAT** (`github.com/settings/personal-access-tokens`) *or*
  click Connect → OAuth (`/oauth/github/start`). OAuth needs `GITHUB_CLIENT_ID` /
  secret set as Railway env vars; the OAuth callback is
  `https://app.grantry.ai/oauth/github/callback` (register this URL in the
  provider's OAuth app settings — the legacy Railway domain may also be listed).
- **Notion**: paste an internal integration token (`ntn_…` / `secret_…`).
- **Google (Drive/GSC/Ads)**: OAuth only, via `/oauth/<provider>/start`.
- **HubSpot**: paste a Private App access token.
- **Attio**: paste a workspace access token from Settings > Developers > Access tokens.
- **Clay**: paste the API key from Clay Settings > Account > API key.
- **HeyReach**: paste a Public API key.
- **Chatwork**: paste a Chatwork API token.
- **Railway**: paste a Project Token from Project Settings > Tokens. Plain tokens
  are treated as project tokens. For account/workspace tokens, paste JSON like
  `{"token":"...","token_type":"account"}`.
- **Resend**: paste a Resend API key. Sending requires `sending_access` or
  `full_access` and a verified sending domain.
- **Slack**: create an app at `api.slack.com/apps`, add Bot Token Scopes, install
  it to the workspace, and paste the Bot User OAuth Token (`xoxb-…`).
Set the connection's **scope to the tenant name**; that's the scope callers must pass.

### 6. Grant an agent access to a scope
1. Ensure a connection exists at that scope (step 5).
2. The tenant's role must include the tool in **Allowed tools** and the scope in
   **Allowed scopes** (leave Allowed scopes empty for "any scope").
3. Bind the role to the agent (`POST /agents/:id/bind`) — or skip role wrangling
   entirely and create the agent via `/agents/new`.

## Providers & tools (118)
- `ping` — liveness (returns `pong from <agent>`)
- **grantry** (system metadata, no SaaS credential required): `get_skill`,
  `get_providers`
- **github** (PAT or OAuth; scopes `repo`, `read:user`):
  `list_repos`, `get_repo`, `get_file_contents`, `list_issues`, `create_issue`, `git_push_repo`, `create_repo`
- **notion** (PAT): `list_dbs`, `get_page`, `query_db`, `create_page`,
  `update_page`, `append_blocks`, `update_blocks`, `update_page_status`
- **google_drive** (OAuth, read-only): `list_files`, `get_file`, `search`
- **google_gsc** (OAuth, read-only): `list_sites`, `search_analytics`
- **google_ads** (OAuth, read-only): `list_campaigns`, `get_campaign`
- **hubspot** (Private App token): `list_deals`, `get_contact`, `create_deal`
- **attio** (access token): `search_records`, `list_records`, `get_record`,
  `create_record`, `upsert_record`, `update_record`, `list_notes`, `get_note`,
  `create_note`, `delete_note`, `list_tasks`, `get_task`, `create_task`,
  `update_task`, `delete_task`, `list_threads`, `get_thread`, `create_comment`,
  `get_comment`, `delete_comment`, `list_meetings`, `get_meeting`
- **clay** (API key): `raw_request`, `lookup_row`, `create_row`, `update_row`,
  `enrich_person`, `enrich_company`
- **heyreach** (Public API key): `check_api_key`, `list_campaigns`,
  `get_campaign`, `pause_campaign`, `resume_campaign`, `add_leads_to_campaign`,
  `list_leads`, `list_conversations`, `list_lead_lists`, `create_empty_list`,
  `get_overall_stats`
- **chatwork** (API token): `get_me`, `list_contacts`, `list_rooms`, `get_room`,
  `list_room_members`, `list_messages`, `get_message`, `send_message`,
  `list_my_tasks`, `list_room_tasks`, `get_room_task`, `create_room_task`,
  `list_room_files`, `get_room_file`
- **railway** (Project token / API token): `graphql`, `project_token_info`,
  `introspect_schema`
- **resend** (API key): `send_email`, `list_emails`, `get_email`,
  `list_domains`, `get_domain`, `list_api_keys`
- **slack** (Bot token): `auth_test`, `list_channels`, `get_channel`,
  `list_messages`, `get_thread`, `post_message`, `update_message`,
  `list_users`, `get_user`

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
  provider metadata, auth types, links, and tool names.

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
- `raw_request` (read/write depending on method): `path`; optional `method`
  (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) and `data`/`body`. The path must be a
  Clay API path, not a full URL.
- `lookup_row` (read): `table_id`; optional `column`, `value`, `limit`, or raw `data`.
- `create_row` (write): `table_id`, `data`.
- `update_row` (write): `table_id`, `row_id`, `data`.
- `enrich_person` (write): `data` Clay person enrichment request body.
- `enrich_company` (write): `data` Clay company enrichment request body.

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
   `clay/raw_request` with non-GET methods, `clay/create_row`,
   `clay/update_row`, `clay/enrich_person`, `clay/enrich_company`,
   `heyreach/pause_campaign`,
   `heyreach/resume_campaign`, `heyreach/add_leads_to_campaign`,
   `heyreach/create_empty_list`, `chatwork/send_message`,
   `chatwork/create_room_task`, `railway/graphql` with mutations,
   `resend/send_email`, `slack/post_message`, `slack/update_message`, …)
   get explicit confirmation first —
   these hit the real SaaS via real tokens and are not reversible. **Read-only**
   calls (incl. the connectivity smoke test) need no confirmation — just run them.
5. Report the result. The `scope` is recorded in the audit log (`/audit`).

## Failure handling (error codes)
- `-32700` → JSON parse error (malformed body).
- `-32001` → missing `Authorization` header.
- `-32002` → agent token invalid/disabled/expired. Rotate it via `/ui/agents`.
- `-32010` → policy denied. Two sub-reasons:
  - `no role permits (tool=…, scope=…)` → the agent's role lacks the tool, or the
    scope isn't in a non-empty `allowedScopes`.
  - `no enabled connection for (provider=…, scope=…)` → role is fine, but **no
    enabled connection at that exact scope**. Almost always means you passed the
    wrong/empty `scope`. Call `connections/list` to get the exact scope, then resend.
- `-32011` → connection row vanished mid-call (rare).
- `-32029` → rate limited (default 120 `tools/call`/min per agent; HTTP 429).
  Back off and retry after a minute.
- `-32601` → unknown JSON-RPC method.
- Tool-level errors come back as `result.isError = true` with `content[].text`
  (e.g. a GitHub 4xx body), not as a JSON-RPC error.

## Examples

**1 — list repos (read) for tenant `grantry-dev`:**
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
- `/tenants`, `/tenants/new`, `/tenants/:scope/edit` — tenant + connection wizard;
  the edit page also renames the tenant's display name (slug is immutable)
- `/agents`, `/agents/new` — agents; `/agents/new` creates a **cross-tenant**
  agent (tenant checkboxes + per-tool unticks, dedicated role auto-created)
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
- A role with empty `allowedScopes` permits **any** scope; a role with
  `allowedScopes=["grantry-dev"]` permits only `scope="grantry-dev"`.
- Every call is audited with its `scope` (`/audit`); sensitive request args are
  masked before storage.
- Token issuance/rotation is UI-only — there is no admin HTTP API.
- `tools/call` is rate-limited per agent (default 120/min → `-32029`).
