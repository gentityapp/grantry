# grantry

OAuth credential broker for AI agents. **MCP-compatible.**

> TypeScript rewrite of [gentity-auth](https://github.com/gentityapp/gentity-auth) (Python/FastAPI). Same product, same scope model, but in the same language as [gentity](https://github.com/gentityapp/gentity) so we can share types, use better-auth, and ship one deploy.

## Phase 1 (this commit)

- ✅ Hono + TypeScript + Node
- ✅ Prisma + PostgreSQL (Railway)
- ✅ better-auth (email + password, Google OAuth, GitHub OAuth)
- ✅ MCP `/mcp` JSON-RPC endpoint (ping tool)
- ✅ Minimal `/ui` dashboard
- ⏳ Phase 2: OAuth brokers + real tools (`github/*`, `notion/*`, `google_drive/*`, `google_gsc/*`, `google_ads/*`, `hubspot/*`, `attio/*`)
- ⏳ Phase 3: Multi-tenant scope (already in schema)
- ⏳ Phase 4: Full UI (login, tenant wizard, agent issuance, audit log)

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
| `GET` | `/` | Service info |
| `GET` | `/ui` | Dashboard (Phase 4 will have real UI) |
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

## License

MIT
