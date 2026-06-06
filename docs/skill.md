---
name: gentity-auth
description: |
  Use gentity-auth when the user wants an AI agent to call external SaaS APIs
  (GitHub, Notion, Google Drive/GSC/Ads, HubSpot) under OAuth/PAT authentication
  with tenant isolation. gentity-auth (deployed as "agent-oauth") is a
  Hono/TypeScript service that holds encrypted credentials and exposes them as
  MCP tools, so the agent never sees raw tokens. Triggers: mentions of
  "gentity-auth" / "agent-oauth", wiring an agent to a SaaS via OAuth or PAT,
  "ツール権限管理", "テナント分離 / scope ベースの認可", or any request to give
  an AI agent controlled API access. Do NOT trigger for: general OAuth-flow
  questions, building a brand-new OAuth app from scratch, or unrelated API docs.
---

# gentity-auth (agent-oauth)

## Quick facts
- **Service**: Hono/TypeScript app at `https://agent-oauth-production.up.railway.app`
- **Source**: `github.com/gentityapp/gentity-auth`
- **MCP endpoint**: `POST https://agent-oauth-production.up.railway.app/mcp`
  (JSON-RPC 2.0: `tools/list`, `tools/call`; `tools/list` needs no auth)
- **Auth**: `Authorization: Bearer gn_agt_<token>` for MCP. The dashboard `/ui/*`
  uses a **better-auth email+password session** (NOT the agent token). There is
  **no `/admin` HTTP API** and **no `X-Admin-Token`** — tokens are minted through
  the UI only.
- **Tenant model**: each `Connection` has a `scope` (the tenant name, e.g.
  `gentity-dev`). A `Role` has `allowedTools` + `allowedScopes`. Tool calls pass
  `scope` in `arguments` to pick the credential.
- **22 tools** (incl. `ping`). Format: `<provider>/<tool>` (e.g. `github/git_push_repo`).

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

## Procedure

### 1. Discover tools
```bash
curl -s -X POST https://agent-oauth-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 2. Find the right scope before calling
The scope is the **tenant name**. Check it in the dashboard at `/ui/tenants` (or the
role/tenant edit page). If unsure, **ask the user which tenant/scope** the connection
was registered under rather than guessing — don't brute-force scope names.

### 3. Call a tool with scope
```json
POST /mcp
Authorization: Bearer gn_agt_<token>
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "github/list_repos",
    "arguments": { "scope": "gentity-dev" }
  }
}
```

### 4. Issue / rotate an agent token (UI only)
1. Log in at `/ui/login` (or register at `/ui/register`).
2. Tokens are minted by the **tenant wizard** (`/ui/tenants/new`) when you create a
   tenant + agent, and can be rotated from `/ui/agents` (`POST /ui/agents/:id/rotate`).
   The plaintext `gn_agt_…` is shown **once** — copy it then.

### 5. Add a new connection (credential)
Go to `/ui/tenants/new` (or `/ui/tenants/:scope/edit` to add to an existing tenant):
- **GitHub**: paste a **PAT** (`github.com/settings/personal-access-tokens`) *or*
  click Connect → OAuth (`/oauth/github/start`). OAuth needs `GITHUB_CLIENT_ID` /
  secret set as Railway env vars; the OAuth callback is
  `https://agent-oauth-production.up.railway.app/oauth/github/callback`.
- **Notion**: paste an internal integration token (`ntn_…` / `secret_…`).
- **Google (Drive/GSC/Ads), HubSpot**: OAuth only, via `/oauth/<provider>/start`.
Set the connection's **scope to the tenant name**; that's the scope callers must pass.

### 6. Grant an agent access to a scope
1. Ensure a connection exists at that scope (step 5).
2. The tenant's role must include the tool in **Allowed tools** and the scope in
   **Allowed scopes** (leave Allowed scopes empty for "any scope").
3. Bind the role to the agent (`POST /ui/agents/:id/bind`).

## Providers & tools (22)
- `ping` — liveness (returns `pong from <agent>`)
- **github** (PAT or OAuth; scopes `repo`, `read:user`):
  `list_repos`, `get_repo`, `list_issues`, `create_issue`, `git_push_repo`, `create_repo`
- **notion** (PAT): `list_dbs`, `get_page`, `query_db`, `create_page`, `update_page_status`
- **google_drive** (OAuth, read-only): `list_files`, `get_file`, `search`
- **google_gsc** (OAuth, read-only): `list_sites`, `search_analytics`
- **google_ads** (OAuth, read-only): `list_campaigns`, `get_campaign`
- **hubspot** (OAuth): `list_deals`, `get_contact`, `create_deal`

### GitHub tool arguments (besides `scope`)
- `get_repo`, `list_issues`: `owner`, `repo` (list_issues also `state`, default `open`)
- `create_issue`: `owner`, `repo`, `title`, `body?`
- `git_push_repo`: `owner`, `repo`, `branch?` (default `main`), `commit_message?`,
  `files` (object `{ "path": "utf8 content" }`). Uses the Contents API — works on
  empty and non-empty repos.
- `create_repo`: `name`, `org?` (omit = personal account), `description?`, `private?`

## Output contract
When asked to act via gentity-auth:
1. State which tool(s) and which **scope** you'll use.
2. Show the JSON-RPC payload.
3. For **write** actions (`git_push_repo`, `create_repo`, `create_issue`,
   `notion/create_page`, `hubspot/create_deal`, …) get explicit confirmation first —
   these hit the real SaaS via real tokens and are not reversible.
4. Report the result. The `scope` is recorded in the audit log (`/ui/audit`).

## Failure handling (error codes)
- `-32700` → JSON parse error (malformed body).
- `-32001` → missing `Authorization` header.
- `-32002` → agent token invalid/disabled/expired. Rotate it via `/ui/agents`.
- `-32010` → policy denied. Two sub-reasons:
  - `no role permits (tool=…, scope=…)` → the agent's role lacks the tool, or the
    scope isn't in a non-empty `allowedScopes`.
  - `no enabled connection for (provider=…, scope=…)` → role is fine, but **no
    enabled connection at that exact scope**. Almost always means you passed the
    wrong/empty `scope`. Verify the tenant name and resend.
- `-32011` → connection row vanished mid-call (rare).
- `-32601` → unknown JSON-RPC method.
- Tool-level errors come back as `result.isError = true` with `content[].text`
  (e.g. a GitHub 4xx body), not as a JSON-RPC error.

## Examples

**1 — list repos (read) for tenant `gentity-dev`:**
```json
POST /mcp   Authorization: Bearer gn_agt_<token>
{ "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"github/list_repos","arguments":{ "scope":"gentity-dev" } } }
```

**2 — push files (write, confirm first):**
```json
POST /mcp   Authorization: Bearer gn_agt_<token>
{ "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"github/git_push_repo","arguments":{
    "scope":"gentity-dev",
    "owner":"gentityapp","repo":"gentity-auth","branch":"main",
    "commit_message":"docs: update skill",
    "files":{ "SKILL.md":"...", "docs/notes.md":"..." } } } }
```

**3 — create an issue (write):**
```json
{ "name":"github/create_issue","arguments":{
    "scope":"gentity-dev","owner":"gentityapp","repo":"gentity",
    "title":"Bug: …","body":"Steps to reproduce …" } }
```

## UI routes — note: there is no `/ui/add`
- `/ui/login`, `/ui/register` — auth (better-auth email+password)
- `/ui/` — dashboard (requires login)
- `/ui/tenants`, `/ui/tenants/new`, `/ui/tenants/:scope/edit` — tenant + connection wizard
- `/ui/agents` — agents; `POST /ui/agents/:id/bind`, `POST /ui/agents/:id/rotate`
- `/ui/audit` — audit log (per-call scope, status, duration)
- `/oauth/<provider>/start`, `/oauth/<provider>/callback` — OAuth connect (under `/oauth`, not `/ui`)

## Key invariants
- The raw credential is never returned to the agent. The gateway decrypts and
  injects the token server-side; the agent only ever sees tool results.
- Connection scope match is **exact**. `scope=""` is its own bucket: it only serves
  calls that send no scope.
- A role with empty `allowedScopes` permits **any** scope; a role with
  `allowedScopes=["gentity-dev"]` permits only `scope="gentity-dev"`.
- Every call is audited with its `scope` (`/ui/audit`).
- Token issuance/rotation is UI-only — there is no admin HTTP API.
