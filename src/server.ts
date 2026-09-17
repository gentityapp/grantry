// grantry — Phase 1: Hono server with /health and /mcp placeholder
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getCookie, setCookie } from "hono/cookie";
import { detectLocale, runWithLocale, t, LANG_COOKIE, LOCALES, type Locale } from "./i18n.js";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "./auth.js";
import { mcpApp } from "./mcp.js";
import { dashboardApp, oauthApp, mcpAuthorizeGate } from "./ui.js";
import { publicFormsApp } from "./public_forms.js";
import { filesApp } from "./files.js";
import { Scalar } from "@scalar/hono-api-reference";
import { openApiDocument } from "./openapi.js";
import { startHealthSweepScheduler } from "./health_sweep.js";
import { startOnboardingNudgeScheduler } from "./onboarding_nudge.js";
import { startConnectionDormancyNudgeScheduler } from "./connection_dormancy_nudge.js";
// Side-effect import: registers GET /usage on the dashboardApp exported by ui.ts.
import "./usage.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin ?? "*",
    credentials: true,
  }),
);

// Per-request locale. Runs the entire downstream chain (handlers + the HTML
// post-processing middleware below) inside an AsyncLocalStorage store so the
// synchronous render functions in ui.ts/auth.ts can resolve translations via
// t()/currentLocale() without threading a locale parameter everywhere. Cookie
// override (set by /lang/:locale) wins over the Accept-Language header.
app.use("*", async (c, next) => {
  const locale = detectLocale(
    c.req.header("accept-language"),
    getCookie(c, LANG_COOKIE),
  );
  await runWithLocale(locale, next);
});

// Language switcher target. Sets a 1-year cookie and returns to the referring
// page (defaults to the dashboard). Only known locales are accepted.
app.get("/lang/:locale", (c) => {
  const requested = c.req.param("locale") as Locale;
  if (LOCALES.includes(requested)) {
    setCookie(c, LANG_COOKIE, requested, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "Lax",
    });
  }
  const next = c.req.query("next");
  const dest = next && next.startsWith("/") ? next : "/dashboard";
  return c.redirect(dest, 302);
});

// Inject the "Usage" sidebar tab into dashboard HTML responses without editing
// the ~400KB single-file ui.ts NAV. Outer middleware: it runs `next()` first,
// then, only for text/html responses that already render the dashboard nav (the
// Audit link) and don't yet have a Usage link, inserts the Usage anchor right
// before Audit. No-op for JSON, redirects, public pages, and the /usage page
// itself (its own NAV already includes the tab). Purely additive string edit.
app.use("*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return;
  const body = await c.res.text();
  let out = body;
  if (body.includes('href="/audit"') && !body.includes('href="/usage"')) {
    const active = c.req.path === "/usage" ? "active" : "";
    const link = `<a href="/usage" class="${active}">${t("Usage")}</a>\n    `;
    out = body.replace('<a href="/audit"', link + '<a href="/audit"');
  }
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(out, { status: c.res.status, statusText: c.res.statusText, headers });
});

// Agent-binding gate for the MCP OAuth authorize flow. Registered before the
// better-auth mount so it sees the request first; returning null passes the
// request through to better-auth unchanged.
app.get("/api/auth/mcp/authorize", async (c) => {
  const intercepted = await mcpAuthorizeGate(c);
  return intercepted ?? auth.handler(c.req.raw);
});

// Mount auth (better-auth)
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// OAuth discovery for remote MCP clients (RFC 8414 / RFC 9728). These must be
// served at the origin root; they advertise the authorize/token/register
// endpoints that better-auth's mcp plugin mounts under /api/auth/mcp/*.
app.get("/.well-known/oauth-authorization-server", (c) =>
  oAuthDiscoveryMetadata(auth)(c.req.raw),
);
app.get("/.well-known/oauth-protected-resource", (c) =>
  oAuthProtectedResourceMetadata(auth)(c.req.raw),
);
// RFC 9728 path-insertion form: for the resource https://host/mcp/w/<ws>,
// clients derive https://host/.well-known/oauth-protected-resource/mcp/w/<ws>
// and fetch it FIRST — and they validate that the metadata's `resource`
// exactly matches the MCP URL they were given. Serve every /mcp* variant
// (workspace-locked /mcp/w/<ws>, scope-locked /mcp/s/<scope>) with a patched
// resource field. Serving only the root form makes spec-compliant clients
// (claude.ai, Claude Desktop) fail before ever opening the authorize popup.
app.get("/.well-known/oauth-protected-resource/mcp/*", async (c) => {
  const base = await oAuthProtectedResourceMetadata(auth)(c.req.raw);
  const body = await base.json() as Record<string, unknown>;
  const resourcePath = c.req.path.replace("/.well-known/oauth-protected-resource", "");
  const origin = process.env.BETTER_AUTH_URL
    ? new URL(process.env.BETTER_AUTH_URL).origin
    : new URL(c.req.url).origin;
  body.resource = `${origin}${resourcePath}`;
  return new Response(JSON.stringify(body), { status: 200, headers: base.headers });
});
app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  oAuthProtectedResourceMetadata(auth)(c.req.raw),
);

// Mount MCP gateway
app.route("/mcp", mcpApp);

// Mount OAuth flows (callback URLs must be stable public paths)
app.route("/oauth", oauthApp);

// Public form endpoints for the static marketing site (grantry.ai).
app.route("/public/forms", publicFormsApp);

// Mount upload staging. Plain HTTP on purpose: it is the one part of the agent
// surface that carries bytes, which JSON-RPC over /mcp cannot.
app.route("/files", filesApp);

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

// API reference. The spec is served as JSON so external tools (client
// generators, Postman, other MCP hosts) can consume it directly; /docs renders
// the same document with Scalar. Registered before the dashboard mount so the
// paths can never be shadowed by a console route.
app.get("/openapi.json", (c) => c.json(openApiDocument));
app.get(
  "/docs",
  Scalar({
    url: "/openapi.json",
    pageTitle: "grantry API reference",
    theme: "default",
    darkMode: true,
    // The reference UI itself loads from a CDN. Pin the major so an upstream
    // release can never change what /docs renders without a deploy here.
    cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1",
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

// Background credential-health sweep: re-validates stale connections daily so
// the Connections page reflects reality without a manual Check now.
startHealthSweepScheduler();

// Onboarding nudge (issue #250): daily mail to workspaces that never got to
// their first scope. No-op without RESEND_API_KEY.
startOnboardingNudgeScheduler();

// Connection dormancy nudge (issue #281): daily mail to workspaces whose
// enabled connection has had no successful call in the silent window. Off
// until CONNECTION_DORMANT_NUDGE_ENABLED=true.
startConnectionDormancyNudgeScheduler();
