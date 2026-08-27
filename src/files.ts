// Upload staging for providers that will not take JSON.
//
// The MCP transport carries JSON-RPC, so a provider call that needs actual
// bytes — a multipart upload, or an https URL the provider fetches itself —
// has no home there: the agent would have to base64 the file into its own tool
// call. That is expensive, lossy at size, and puts customer documents through
// the model's context for no reason.
//
// This module gives an agent a place to put the bytes first:
//
//   POST /files            (multipart, agent token) -> { file_id, url, ... }
//   GET  /files/:id?token= (no agent token)         -> the bytes
//   DELETE /files/:id      (agent token)            -> purge now
//
// The agent then references the upload by `file_id` from a provider request
// (see connectors/generic_request.ts `files`), and grantry streams the bytes
// into the provider call. `url` exists for the providers that insist on
// fetching an https URL themselves; it is unguessable and expires.
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db.js";

export const filesApp = new Hono();

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const PUBLIC_ORIGIN = process.env.PUBLIC_MCP_ORIGIN ?? "https://api.grantry.ai";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Static agent tokens only. The OAuth token styles accepted on /mcp belong to
 * interactive clients (claude.ai, Claude Desktop) which upload through their
 * own UI; a file upload is a plain HTTP call made from a shell or a script,
 * where a gn_agt_ token is what the caller actually has.
 */
async function resolveAgent(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token.startsWith("gn_agt_")) return null;
  const agent = await prisma.agent.findFirst({ where: { hashedToken: sha256(token) } });
  if (!agent || !agent.enabled) return null;
  if (agent.expiresAt && agent.expiresAt < new Date()) return null;
  return agent;
}

/** Best-effort purge of anything past its expiry. Cheap enough to run inline. */
async function sweepExpired() {
  await prisma.stagedFile
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch((e) => console.error("[files] sweep failed", e));
}

function resolveTtlSeconds(raw: unknown) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(value), MAX_TTL_SECONDS);
}

filesApp.post("/", async (c) => {
  const agent = await resolveAgent(c.req.header("authorization") ?? null);
  if (!agent) {
    return c.json({ error: "unauthorized: pass 'Authorization: Bearer gn_agt_...'" }, 401);
  }

  // Reject on the declared length before buffering the body.
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return c.json({ error: `file_too_large: max ${MAX_UPLOAD_BYTES} bytes` }, 413);
  }

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid_multipart: send multipart/form-data with a 'file' part" }, 400);
  }
  const file = form.file;
  if (!(file instanceof File)) {
    return c.json({ error: "file_required: send multipart/form-data with a 'file' part" }, 400);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return c.json({ error: `file_too_large: max ${MAX_UPLOAD_BYTES} bytes` }, 413);
  }
  if (bytes.length === 0) return c.json({ error: "file_empty" }, 400);

  await sweepExpired();

  const downloadToken = randomBytes(24).toString("hex");
  const ttlSeconds = resolveTtlSeconds(form.ttl_seconds);
  const filename = String(form.filename ?? file.name ?? "upload").slice(0, 200);
  const contentType = String(form.content_type ?? file.type ?? "application/octet-stream");
  const staged = await prisma.stagedFile.create({
    data: {
      agentId: agent.id,
      filename,
      contentType,
      size: bytes.length,
      bytes,
      downloadTokenHash: sha256(downloadToken),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    },
    select: { id: true, expiresAt: true },
  });
  console.log("[files] staged", { agent: agent.name, id: staged.id, size: bytes.length, ttlSeconds });

  return c.json({
    file_id: staged.id,
    filename,
    content_type: contentType,
    size: bytes.length,
    // For providers that download the file themselves. Prefer passing file_id
    // to a provider request: then the bytes go straight from grantry to the
    // provider and are never reachable over the public internet.
    url: `${PUBLIC_ORIGIN}/files/${staged.id}?token=${downloadToken}`,
    expires_at: staged.expiresAt.toISOString(),
  }, 201);
});

filesApp.get("/:id", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!token) return c.json({ error: "token_required" }, 401);
  const staged = await prisma.stagedFile.findUnique({ where: { id: c.req.param("id") } });
  if (!staged) return c.json({ error: "not_found" }, 404);
  if (staged.expiresAt < new Date()) {
    await prisma.stagedFile.delete({ where: { id: staged.id } }).catch(() => {});
    return c.json({ error: "expired" }, 410);
  }
  if (sha256(token) !== staged.downloadTokenHash) return c.json({ error: "not_found" }, 404);

  await prisma.stagedFile
    .update({
      where: { id: staged.id },
      data: { lastFetchedAt: new Date(), fetchCount: { increment: 1 } },
    })
    .catch(() => {});
  return new Response(Buffer.from(staged.bytes), {
    status: 200,
    headers: {
      "Content-Type": staged.contentType,
      "Content-Length": String(staged.size),
      "Content-Disposition": `inline; filename="${staged.filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});

filesApp.delete("/:id", async (c) => {
  const agent = await resolveAgent(c.req.header("authorization") ?? null);
  if (!agent) return c.json({ error: "unauthorized" }, 401);
  const staged = await prisma.stagedFile.findUnique({ where: { id: c.req.param("id") } });
  if (!staged || staged.agentId !== agent.id) return c.json({ error: "not_found" }, 404);
  await prisma.stagedFile.delete({ where: { id: staged.id } });
  return c.json({ deleted: staged.id });
});

/**
 * Load a staged upload for a provider call. Scoped to the calling agent so one
 * agent's file id is useless to another, and expiry is enforced here too — a
 * provider request is the one place the bytes leave grantry.
 */
export async function loadStagedFile(agentId: string, fileId: string) {
  const staged = await prisma.stagedFile.findUnique({ where: { id: fileId } });
  if (!staged || staged.agentId !== agentId) {
    throw new Error(`staged_file_not_found: no upload ${fileId} for this agent (upload it to POST /files first)`);
  }
  if (staged.expiresAt < new Date()) {
    await prisma.stagedFile.delete({ where: { id: staged.id } }).catch(() => {});
    throw new Error(`staged_file_expired: upload ${fileId} has expired (re-upload it to POST /files)`);
  }
  return staged;
}

export { sweepExpired as sweepExpiredStagedFiles };
