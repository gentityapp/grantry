// Tenant entity helpers.
//
// A tenant's `slug` is the immutable wire key: it is the exact string agents
// pass as `scope` in tools/call arguments and in the X-Grantry-Scope header.
// Because the slug never changes, Connection.scope stays permanently equal to
// tenant.slug and the policy/MCP hot path keeps matching on the scope string
// without a join. `displayName` is the only renameable part.
import { prisma } from "./db.js";

/**
 * Find or create the Tenant row for (ownerId, slug). Idempotent; safe to call
 * from every code path that materializes a tenant (wizard, add-service, OAuth
 * callback). An existing tenant's displayName is never overwritten here —
 * renames go through the tenant settings form only.
 *
 * `workspaceId` places a brand-new tenant in the caller's active workspace. An
 * existing tenant is left untouched (update is a no-op) so switching workspaces
 * never silently re-homes another workspace's data; null workspaceIds on legacy
 * rows are filled by the boot-time backfill, not here.
 *
 * Workspace-first resolution: when a tenant with this slug already exists in
 * the target workspace — even one created by another member — reuse it instead
 * of upserting a same-slug duplicate under the caller. The slug is the wire
 * key agents send as `scope`, and the runtime matches connections per
 * workspace, so two same-slug tenant rows in one workspace would be one scope
 * with a split identity.
 */
export async function ensureTenant(ownerId: string, slug: string, displayName?: string, workspaceId?: string | null) {
  if (workspaceId) {
    const existing = await prisma.tenant.findFirst({ where: { workspaceId, slug } });
    if (existing) return existing;
  }
  return prisma.tenant.upsert({
    where: { ownerId_slug: { ownerId, slug } },
    update: {},
    create: { ownerId, slug, displayName: displayName?.trim() || slug, workspaceId: workspaceId ?? null },
  });
}
