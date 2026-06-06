// agent-oauth — Phase 1: Hono server with /health and /mcp placeholder
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { auth } from "./auth.js";
import { mcpApp } from "./mcp.js";
import { dashboardApp, oauthApp } from "./ui.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin ?? "*",
    credentials: true,
  }),
);

// Mount auth (better-auth)
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Mount MCP gateway
app.route("/mcp", mcpApp);

// Mount dashboard UI
app.route("/ui", dashboardApp);

// Mount OAuth flows (callback URLs must be stable public paths)
app.route("/oauth", oauthApp);

// Health
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "agent-oauth",
    version: "0.1.0",
    phase: 1,
    ts: new Date().toISOString(),
  }),
);

app.get("/", (c) =>
  c.json({
    name: "agent-oauth",
    description: "OAuth credential broker for AI agents (MCP-compatible)",
    endpoints: {
      health: "GET /health",
      auth: "GET/POST /api/auth/*",
      mcp: "POST /mcp",
      ui: "GET /ui",
    },
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`agent-oauth listening on http://localhost:${info.port}`);
});
