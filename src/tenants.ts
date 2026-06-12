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
 */
export async function ensureTenant(ownerId: string, slug: string, displayName?: string) {
  return prisma.tenant.upsert({
    where: { ownerId_slug: { ownerId, slug } },
    update: {},
    create: { ownerId, slug, displayName: displayName?.trim() || slug },
  });
}
