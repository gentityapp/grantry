---
name: gentity-auth
description: |
  Use gentity-auth when the user wants an AI agent to call external SaaS APIs
  (Notion, Google Drive/GSC/Ads, HubSpot, GitHub) under OAuth or PAT authentication
  with multi-tenant scope isolation. gentity-auth is a TypeScript / Hono service
  that holds encrypted credentials and exposes them as MCP tools, so the agent
  never sees tokens directly. Triggers: mentions of "gentity-auth", asking to
  wire up an agent to a SaaS via OAuth or PAT, "ツール権限管理",
  "テナント分離 / scope ベースの認可", or any request where the user wants to
  give an AI agent controlled API access. Do NOT trigger for: general OAuth
  flow questions, building a brand-new OAuth app from scratch, or unrelated
  API documentation.
---

# gentity-auth (TS rewrite)

## When to load
The user mentions gentity-auth by name, or wants the agent to:
- Call Notion / Google Drive / Google Search Console / Google Ads / HubSpot / GitHub APIs under controlled credentials
- Use multi-tenant scope isolation (separate connections per project: e.g. "gentity" vs "onestream")
- Issue tokens for agents and bind roles
- Inspect audit log to see "which agent called which tool on which project"
- Do a `git push` to GitHub via the `github/git_push_repo` MCP tool (use the agent's existing token, no separate PAT needed)

## Quick facts
- **Service**: TypeScript / Hono app deployed at `https://agent-oauth-production.up.railway.app` (production)
  - Note: still branded as `gentity-auth` in user-facing docs / repo name (`gentityapp/gentity-auth`), but the deployment hostname is `agent-oauth-production.up.railway.app`
- **Source**: `https://github.com/gentityapp/gentity-auth` (Hono rewrite, self-hosted via `github/git_push_repo`)
- **MCP endpoint**: `POST /mcp` (JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`, `tools/list`)
- **Auth**: `Authorization: Bearer gn_agt_<token>` for MCP and `/ui/*` (except `/ui/login`, `/ui/signup`); user authentication via [better-auth](https://www.better-auth.com/) (email + password)
- **Tenant model**: connections have a `scope`; roles have `allowed_scopes`; tool calls pass `scope` in arguments to pick the right credential
- **No admin token** — the old `X-Admin-Token` + `scripts/issue_agent_token.py` Python bootstrap path is gone. Token issuance is done through the UI wizard.

## Tool list (22 total)

| Provider | Tools |
|---|---|
| (system) | `ping` |
| Notion | `notion/list_dbs`, `notion/get_page`, `notion/query_db`, `notion/create_page`, `notion/update_page_status` |
| GitHub | `github/list_repos`, `github/get_repo`, `github/list_issues`, `github/create_issue`, `github/git_push_repo`, `github/create_repo` |
| Google Drive | `google_drive/list_files`, `google_drive/get_file`, `google_drive/search` |
| Google Search Console | `google_gsc/list_sites`, `google_gsc/search_analytics` |
| Google Ads | `google_ads/list_campaigns`, `google_ads/get_campaign` |
| HubSpot | `hubspot/list_deals`, `hubspot/get_contact`, `hubspot/create_deal` |

Discover with `POST /mcp` `tools/list` (no auth required). Format: `<provider>/<tool>`.

## Procedure

### 1. Discover the available tools
```
POST /mcp
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}
}
```

### 2. If the user has no agent token yet
Guide them through the **UI wizard** at `/ui/tenants/new` (one step, no admin token required):
1. Sign up / log in at `/ui/signup` or `/ui/login` (better-auth, email + password)
2. Open `/ui/tenants/new`
3. **Step 1 — Tenant**: type a new tenant name (e.g. `my-project`), or pick an existing one from the "Or pick an existing tenant" dropdown to add another agent
4. **Step 2 — Provider**: select the provider. The wizard shows:
   - "🔗 Get a new `<Provider>` token here →" link to the token-issuing page
   - "🔗 Register/manage your `<Provider>` OAuth app here →" link to the OAuth app console (for OAuth-supported providers)
   - Credential textarea (or "Connect with OAuth" button) — hidden automatically if the connection already exists for the chosen tenant+provider
5. **Step 3 — Tools**: pick which tools the agent can call (defaults: all of the provider's tools)
6. Submit → success page shows the new `gn_agt_...` token **once**. Save it.

**Adding another agent to an existing tenant** is also possible via:
- `/ui/tenants/:scope/edit` → "Add another agent to this tenant" card (preferred for clarity)
- Or the wizard with the existing-tenant dropdown

### 3. To call a tool with scope (multi-tenant)
When the agent has multiple scope-bound connections, the call must specify which:
```json
POST /mcp
Authorization: Bearer gn_agt_xxx
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "github/git_push_repo",
    "arguments": {
      "scope": "gentity-dev",
      "owner": "gentityapp", "repo": "gentity-auth",
      "files": {"README.md": "..."}
    }
  }
}
```
- `scope` is required when the calling agent has multiple scope-bound connections. If only one exists, it's optional (legacy behavior).
- If the policy denies, the response is `error.code = -32010` with reason `policy denied`.
- If the scope doesn't match a role's `allowed_scopes`, the call is denied.

### 4. To add a new connection to an existing tenant
- **Via UI**: open `/ui/tenants/:scope/edit`, scroll to the "Add a service" section, pick a provider, paste credential (PAT) or click "Connect with OAuth" (Google, GitHub). Note: when the connection already exists for the chosen tenant+provider, the credential / OAuth fields hide and a "Reusing existing connection" notice shows; click "rotate credential" to paste a new PAT.
- **Bulk / programmatic**: there's no admin API; all connections are user-driven through the UI.

### 5. To grant an agent access to a new scope
1. The connection for that scope must exist (see step 4).
2. Open the role settings on the tenant edit page (`/ui/tenants/:scope/edit` → "Role" section), or pass `additional_scopes` in the wizard when creating the agent. The role's `allowed_scopes` controls which scopes the agent can target.
3. Empty `allowed_scopes` = wildcard ("any scope") — recommended for multi-tenant dev.
4. Bind the role to the agent (default: every agent is bound to its tenant's role).

## Output contract
When the user asks you to do something via gentity-auth, you should:
1. State which tool(s) you'll call and on which scope
2. Show the JSON-RPC payload (so they can see the request shape)
3. If the call involves a write, ask for explicit confirmation first (since gentity-auth tokens are real OAuth/PAT tokens, write actions are non-reversible in the underlying SaaS)
4. Report the result, including the `scope` field in audit-visible responses

## Failure handling
- `error.code = -32002` → agent token is invalid/expired; ask user to re-issue via `/ui/agents` (rotate / delete + create new)
- `error.code = -32010` → policy denied; check that the role has both the tool in `allowed_tools` AND the scope in `allowed_scopes`
- `error.code = -32601` → provider not wired in this gentity-auth version
- `error.message` containing "no enabled connection for" → the scope has no connection set up; guide user to `/ui/tenants/:scope/edit` → "Add a service"
- Network/timeout: retry once with a longer timeout; the GitHub Contents API can take 20+ seconds for large file pushes

## Examples

**Example 1 — search GSC sites for a property** (read-only, no scope needed):
```json
POST /mcp
Authorization: Bearer gn_agt_xxx
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "google_gsc/list_sites",
    "arguments": {}
  }
}
```

**Example 2 — push files to GitHub under a specific tenant scope** (write, scope required):
```json
POST /mcp
Authorization: Bearer gn_agt_xxx
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "github/git_push_repo",
    "arguments": {
      "scope": "gentity-dev",
      "owner": "gentityapp",
      "repo": "gentity-auth",
      "branch": "main",
      "commit_message": "feat: add scope isolation",
      "files": {"README.md": "...", "package.json": "..."}
    }
  }
}
```

**Example 3 — add another agent to an existing tenant via UI** (recommended over raw API):
1. Open `/ui/tenants/gentity-dev/edit` (or `/ui/tenants/new` with the dropdown)
2. Tenant already has a connection for github → credential field hides automatically
3. Type new agent name (e.g. `gentity-read-bot`), submit
4. Get a fresh `gn_agt_...` token bound to the same role
5. New agent inherits all role tools + connections; old agents unaffected

## Key invariants
- gentity-auth never returns the raw credential to the agent. The agent always goes through MCP, where the gateway decrypts and injects the token.
- A `scope: ""` (empty) connection is "legacy": any role with `allowed_scopes=[]` (wildcard) can use it.
- A role with `allowed_scopes=["gentity-dev"]` can ONLY call tools with `scope="gentity-dev"` in arguments; calls without a scope or with another scope are denied.
- **Per-user role naming**: roles are named `${scope}-dev-${userIdShort}` (e.g. `gentity-dev-dev-7HbZCaTK`), so two different users can independently use the same tenant name without colliding. The role's `allowed_scopes` is what controls authorization, not the role's name.
- **Per-user connection ownership**: a `Connection` row is owned by exactly one user. The wizard's connection lookup is filtered by `ownerId: user.id`, so a user can never inherit another user's credentials by typing the same tenant name.
- Audit log records the `scope` for every call. Use `/ui/api/scopes` (returns the full dump of agents, roles, connections) or the audit log to verify which project a call was for.

## Special-case notes
- `github/git_push_repo` uses the **GitHub Contents API** (PUT /repos/{owner}/{repo}/contents/{path}), not the Git Data API. This means it works on **empty repos** (which 409 on the Git Data API). One file per PUT; base64-encoded content.
- For OAuth providers (Google, HubSpot, GitHub), the redirect URI on the OAuth app must be `https://agent-oauth-production.up.railway.app/oauth/<provider>/callback`. The wizard's "🔗 Register/manage your ... OAuth app here →" link takes the user to the provider's developer console.
- For GitHub PAT, the token must have `Contents: Read and write` (and `Administration: Read and write` if you want to create new repos via `github/create_repo`). The token can be fine-grained; for org repos, "All repositories" or "Only select repositories" both work.
