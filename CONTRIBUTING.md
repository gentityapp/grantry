# Contributing to grantry

Thanks for your interest in contributing! grantry is the access control plane for AI agents: it holds SaaS credentials centrally, keeps raw tokens away from agents, and exposes only the MCP tools each agent is granted.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: **Node.js 22+**, **npm**, and either **Docker** (recommended) or a local **PostgreSQL 16**.

1. Fork and clone this repository.
2. Install dependencies:

   ```bash
   npm ci
   ```

3. Configure the environment:

   ```bash
   cp .env.example .env
   ```

   `.env.example` documents every variable the app reads, marked required or optional, with defaults. For local development you mainly need `DATABASE_URL` and `BETTER_AUTH_SECRET` (the dashboard uses email + password sessions).

4. Start the database and the app — either way works:

   - **Docker (full stack, no `.env` needed):**

     ```bash
     docker compose up
     ```

     This runs PostgreSQL 16 plus the app. The dashboard is at `http://localhost:3000`.

   - **Native dev (watch mode):** point `DATABASE_URL` in `.env` at your own Postgres 16 instance, then:

     ```bash
     npx prisma db push   # create the schema
     npm run dev          # app at http://localhost:3000
     ```

5. Create the first dashboard admin: set `OPS_DOMAIN` in `.env` to a domain you control, then sign up at `http://localhost:3000/dashboard` with an email on that domain — the very first signup becomes the admin.

`curl http://localhost:3000/health` should return `{"ok":true,...}`. The README's "Try it" section shows how to call the MCP endpoint.

## Checks before you push

Every PR runs these in CI, but please run them locally first:

```bash
npm run check              # audits + TypeScript build + prisma validate (works without a DB)
npm run test:connections   # connector behavior tests (node --test)
```

If you change connector code, add or update tests under `tests/connections/`.

## Pull requests

- **One PR per topic.** A PR should fix one thing or add one connector; keep the diff minimal.
- Reference the related issue in the PR description (`Closes #123` is fine there).
- Include tests for behavior changes. CI (`npm run check` + `npm run test:connections`) must pass.
- Never commit secrets, real credentials, or `.env` files.

## Adding a connector (MCP tools for a SaaS provider)

The step-by-step guide is [docs/skill.md](docs/skill.md). The best reference is the existing connectors in `src/connectors/` — pick a provider that resembles the one you want to add (OAuth, PAT, or API key) and follow its shape.

A few notes:

- Tool exposure to agents is filtered by explicit grants, and credential handling is deliberately strict — expect review on anything touching auth.
- `npm run check` runs coverage audits (provider scopes, request coverage, generic coverage, i18n). If you add tools or scopes, the audits will point at what still needs registering.

## Questions and bugs

Open a GitHub issue for bugs and feature requests. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
