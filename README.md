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

Current `origin/main` includes 90 implemented provider definitions and 700+ MCP tool names, including GitHub, Notion, Google Search Console, Google Analytics, Google Ads, Gmail, YouTube, HubSpot, Attio, Twenty CRM, Slack, Cloudflare, LINE Yahoo Ads, Meta Ads, Airtable, Linear, Vercel, Stripe, Salesforce, BigQuery, OpenAI, Higgsfield, Figma, and Miro.

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

## Quickstart

```bash
# Local
cp .env.example .env
# edit DATABASE_URL, BETTER_AUTH_SECRET
npm install
npx prisma db push
npm run dev

# Deploy (Railway)
# 1. Create new Railway service from this repo
# 2. Add Postgres plugin
# 3. Set env vars from .env.example
# 4. Deploy
```

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

MIT
