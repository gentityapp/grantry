# grantry

The access control plane for AI agents. **MCP-compatible, tenant-scoped, and built for real business tools.**

grantry lets teams connect SaaS credentials once, keep tokens out of agents, and grant each agent only the provider connections it is allowed to use. It is not a connector catalog or workflow builder; it is Agent IAM for MCP clients such as Codex, Claude Code, Claude Desktop, and other agent runtimes.

## What grantry controls

- Which workspace, scope, and customer environment an agent can reach.
- Which provider connection an agent can use.
- Which MCP tools are exposed to that agent.
- Which OAuth/PAT/API credential is used at call time.
- Which agent called which tool, against which scope, and when.

## Why it matters

Passing raw API keys or OAuth tokens to every local MCP server does not scale for agency, B2B, or multi-client AI operations. grantry centralizes the credential, keeps provider permissions intact, filters `tools/list` by agent grants, and records tool-call audit history.

The public provider and tool counts are rendered from `providerCoverageStats()` in `src/connectors/registry.ts`, after generic request helper tools are attached to implemented providers. The implemented connectors are the modules in `src/connectors/`: `acuity`, `agentmail`, `airtable`, `apollo`, `attio`, `aws`, `bigquery`, `calcom`, `calendly`, `channel_talk`, `chatwork`, `clarity`, `clay`, `cloudflare`, `cloudsign`, `customerio`, `dataforseo`, `discord`, `facebook_messenger`, `firecrawl`, `freee`, `github`, `gmail`, `godaddy`, `google_admin`, `google_ads`, `google_analytics`, `google_calendar`, `google_cloud`, `google_drive`, `google_forms`, `google_gsc`, `google_maps`, `google_sheets`, `google_slides`, `google_tag_manager`, `heyreach`, `higgsfield`, `hubspot`, `intercom`, `jicoo`, `jira`, `langgraph`, `langsmith`, `line`, `linear`, `linkedin_ads`, `mailchimp`, `meta_ads`, `microsoft_ads`, `microsoft_teams`, `moneyforward`, `monid`, `nocodb`, `notion`, `openai`, `openai_ads`, `openrouter`, `railway`, `reddit`, `resend`, `salesforce`, `sendgrid`, `sentry`, `shopify`, `slack`, `smartlead`, `snowflake`, `stripe`, `tiktok_ads`, `timerex`, `tldv`, `twenty`, `vercel`, `webflow`, `wordpress`, `x`, `yahoo_ads`, `youcanbookme`, `youtube`, `zapmail`, `zendesk`, `zoom`.

## Core flow

1. Create a workspace.
2. Create a scope for a customer, project, or operating boundary.
3. Add provider connections through OAuth, PAT, API key, service account, or JSON credential.
4. Create an agent and grant only the connections it should use.
5. Connect any MCP client to `https://api.grantry.ai/mcp` with that agent token.
6. Review audit logs and rotate or revoke access from the dashboard.

## Public endpoints

- Dashboard and OAuth: `https://app.grantry.ai`
- Stable MCP endpoint: `https://api.grantry.ai/mcp`
- API reference: `https://app.grantry.ai/docs`
- Health: `https://api.grantry.ai/health`

## Self-host

Run grantry with Docker Compose in three steps:

1. Clone the repository and enter it.

   ```bash
   git clone https://github.com/gentityapp/grantry.git
   cd grantry
   ```

2. Create `.env` from `.env.example` and set the required values. `DATABASE_URL` must point to the Postgres service, `BETTER_AUTH_SECRET` signs user sessions, and `FERNET_KEY` encrypts provider credentials. Set `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET` for the Google sign-in button, and register the callback URL as `<BETTER_AUTH_URL>/api/auth/callback/google` in your Google OAuth client.

   ```bash
   cp .env.example .env
   ```

   For a local Compose setup, `DATABASE_URL` can be left unset because Compose supplies its bundled Postgres URL. Keep `BETTER_AUTH_SECRET` and `FERNET_KEY` as separate, randomly generated values. Set `BETTER_AUTH_URL` to the URL where the dashboard is reachable, such as `http://localhost:3000`.

3. Start the application and bundled Postgres database.

   ```bash
   docker compose up --build
   ```

After the services are healthy, open `http://localhost:3000/login` and sign in with Google. On the first login, use an address on the domain configured in `OPS_DOMAIN`, open `http://localhost:3000/_ops`, and select **Promote me to admin**. Then open the dashboard to create a workspace, scope, provider connection, agent, and connection grant.

If you do not want to operate grantry yourself, use the hosted dashboard at [app.grantry.ai](https://app.grantry.ai) and the hosted MCP endpoint at `https://api.grantry.ai/mcp`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/` | Public product page |
| `GET` | `/dashboard` | Dashboard |
| `GET` | `/ui` | Legacy dashboard redirect |
| `GET/POST` | `/api/auth/*` | better-auth handlers (signin/signup/oauth) |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 |

## Try it

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping"}}'
```

## Positioning

OpenAI, Anthropic, and agent frameworks build the agents. grantry controls what those agents are allowed to do in each customer environment.

See [PO.md](PO.md) for the product-owner source of truth, plus [docs/business-positioning.md](docs/business-positioning.md) and [docs/competitive-landscape.md](docs/competitive-landscape.md) for the longer positioning notes.

## License

Apache-2.0 — see [LICENSE](LICENSE).
