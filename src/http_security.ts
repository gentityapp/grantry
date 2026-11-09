import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

function configuredOrigins(): Set<string> {
  const urls = [process.env.BETTER_AUTH_URL ?? "http://localhost:3000", ...(process.env.TRUSTED_ORIGINS ?? "").split(",")];
  return new Set(urls.filter(Boolean).flatMap((url) => {
    try { return [new URL(url.trim()).origin]; } catch { return []; }
  }));
}

// MCP authenticates with a bearer token; it does not need browser cookies.
// Dashboard writes must not accept an ambient session from an untrusted site.
export const browserBoundary: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  const trusted = !!origin && origin !== "null" && configuredOrigins().has(origin);
  const path = c.req.path;
  const bearerSurface = path === "/mcp" || path.startsWith("/mcp/") || path === "/files" || path.startsWith("/files/");
  const publicForm = path.startsWith("/public/forms/");
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (unsafe && !bearerSurface && !publicForm && (
    (origin && !trusted) || (!origin && c.req.header("sec-fetch-site") === "cross-site")
  )) return c.json({ error: "untrusted_origin" }, 403);
  return cors({ origin: trusted ? origin! : bearerSurface || publicForm ? "*" : "", credentials: trusted })(c, next);
};

export function stagedFileHeaders(filename: string, contentType: string, size: number): Record<string, string> {
  const safeName = filename.replace(/[\x00-\x1f\x7f"\\]/g, "_");
  return {
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}
