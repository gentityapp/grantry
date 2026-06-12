// grantry — Phase 1: Hono server with /health and /mcp placeholder
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

// Mount OAuth flows (callback URLs must be stable public paths)
app.route("/oauth", oauthApp);

// Global error handler — without this, any uncaught exception renders Hono's
// opaque default "Internal Server Error" page with no diagnostics (see the
// OAuth callback). Log the real error and surface a minimal, safe message.
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
  const detail = err instanceof Error ? err.message : String(err);
  return c.json(
    { error: "internal_server_error", path: c.req.path, detail },
    500,
  );
});

// Health
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "grantry",
    version: "0.1.0",
    phase: 1,
    ts: new Date().toISOString(),
  }),
);

// Legacy UI URLs. GET requests move to the product-facing top-level routes;
// POST requests are still accepted through the old mount for compatibility with
// already-open forms during deploys.
app.get("/ui", (c) => c.redirect("/dashboard", 308));
app.get("/ui/*", (c) => {
  const next = c.req.path.replace(/^\/ui/, "") || "/dashboard";
  return c.redirect(next === "/" ? "/dashboard" : next, 308);
});
app.route("/ui", dashboardApp);

// Mount dashboard console at product-facing top-level URLs.
app.route("/", dashboardApp);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`grantry listening on http://localhost:${info.port}`);
});
