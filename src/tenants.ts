// Tenant entity helpers.
//
// A tenant's `slug` is the immutable wire key: it is the exact string agents
// pass as `scope` in tools/call arguments and in the X-Grantry-Scope header.
// Because the slug never changes, Connection.scope stays permanently equal to
// tenant.slug and the policy/MCP hot path keeps matching on the scope string
// without a join. `displayName` is the only renameable part.
import { prisma } from "./db.js";

/**
 * Find or create the Tenant row for `slug` in the caller's active workspace.
 * Idempotent; safe to call from every code path that materializes a tenant
 * (wizard, add-service, OAuth callback). An existing tenant's displayName is
 * never overwritten here — renames go through the tenant settings form only.
 *
 * Workspace-first resolution: when a tenant with this slug already exists in
 * the target workspace — even one created by another member — reuse it instead
 * of creating a same-slug duplicate under the caller. The slug is the wire
 * key agents send as `scope`, and the runtime matches connections per
 * workspace, so two same-slug tenant rows in one workspace would be one scope
 * with a split identity.
 *
 * Deliberately NO cross-workspace fallback: a same-slug tenant the caller owns
 * in a *different* workspace must never be reused, or the new scope's
 * connections would silently land in that other workspace. (This happened when
 * the old implementation upserted on the per-owner unique (ownerId, slug); the
 * schema unique is now (workspaceId, slug).) Without a workspaceId (legacy
 * pre-workspace paths only) resolution stays per-owner among tenants that have
 * no workspace.
 */
export async function ensureTenant(ownerId: string, slug: string, displayName?: string, workspaceId?: string | null) {
  const where = workspaceId ? { workspaceId, slug } : { ownerId, slug, workspaceId: null };
  const existing = await prisma.tenant.findFirst({ where });
  if (existing) return existing;
  try {
    return await prisma.tenant.create({
      data: { ownerId, slug, displayName: displayName?.trim() || slug, workspaceId: workspaceId ?? null },
    });
  } catch (e: any) {
    // Concurrent create of the same (workspaceId, slug) — the loser re-reads.
    if (e?.code === "P2002") {
      const raced = await prisma.tenant.findFirst({ where });
      if (raced) return raced;
    }
    throw e;
  }
}
