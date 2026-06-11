// Smoke test for the Tenant entity migration. Seeds pre-Tenant data
// (scoped + unscoped connections, no tenant rows), runs assertions on the
// backfill result and tenant CRUD semantics. Run against a throwaway DB only.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let failures = 0;

function assert(cond, name) {
  console.log(`${cond ? "✓" : "✗ FAIL"}: ${name}`);
  if (!cond) failures++;
}

// --- seed: 2 users, overlapping scope names, 1 unscoped legacy connection ---
const [userA, userB] = await Promise.all(
  ["a", "b"].map((k) =>
    prisma.user.create({
      data: { id: `user-${k}`, name: `User ${k}`, email: `${k}@smoke.test` },
    }),
  ),
);

const mkConn = (ownerId, provider, scope, authType = "pat") =>
  prisma.connection.create({
    data: {
      provider, authType, scope, ownerId,
      label: `${provider}-${scope || "unscoped"}-${authType}`,
      encryptedCredential: "smoke-not-a-real-credential",
    },
  });

await mkConn(userA.id, "github", "grantry-dev");
await mkConn(userA.id, "notion", "grantry-dev");
await mkConn(userA.id, "github", "seo");
await mkConn(userA.id, "github", ""); // legacy unscoped
await mkConn(userB.id, "github", "grantry-dev"); // same slug, different owner

// --- run the backfill (same code path as start-with-maintenance) ---
const { execSync } = await import("node:child_process");
console.log(execSync("node scripts/backfill-tenants.mjs", { encoding: "utf8" }).trim());

// --- assertions: backfill ---
const tenantsA = await prisma.tenant.findMany({ where: { ownerId: userA.id }, orderBy: { slug: "asc" } });
const tenantsB = await prisma.tenant.findMany({ where: { ownerId: userB.id } });
assert(tenantsA.length === 2 && tenantsA[0].slug === "grantry-dev" && tenantsA[1].slug === "seo",
  "userA gets exactly tenants [grantry-dev, seo]");
assert(tenantsB.length === 1 && tenantsB[0].slug === "grantry-dev",
  "userB gets its own grantry-dev tenant (owner-scoped, no collision)");
assert(tenantsB[0].id !== tenantsA[0].id, "same slug across owners = distinct tenant rows");
assert(tenantsA.every((t) => t.displayName === t.slug), "backfilled displayName defaults to slug");

const linked = await prisma.connection.findMany({ where: { ownerId: userA.id, scope: "grantry-dev" } });
assert(linked.every((c) => c.tenantId === tenantsA[0].id), "scoped connections linked to their tenant");
const unscoped = await prisma.connection.findFirst({ where: { ownerId: userA.id, scope: "" } });
assert(unscoped.tenantId === null, "unscoped legacy connection stays tenantless");

// --- idempotency: second run changes nothing ---
console.log(execSync("node scripts/backfill-tenants.mjs", { encoding: "utf8" }).trim());
assert((await prisma.tenant.count()) === 3, "backfill is idempotent (still 3 tenants)");

// --- rename: displayName changes, slug/wire key untouched ---
await prisma.tenant.update({ where: { id: tenantsA[0].id }, data: { displayName: "Grantry 開発環境" } });
const renamed = await prisma.tenant.findUnique({ where: { id: tenantsA[0].id } });
const connAfterRename = await prisma.connection.findFirst({ where: { tenantId: tenantsA[0].id } });
assert(renamed.displayName === "Grantry 開発環境" && renamed.slug === "grantry-dev",
  "rename touches displayName only");
assert(connAfterRename.scope === "grantry-dev", "connection scope (wire key) unaffected by rename");

// --- delete: tenant cascade removes its connections, other owners untouched ---
await prisma.tenant.delete({ where: { id: tenantsA[0].id } });
assert((await prisma.connection.count({ where: { ownerId: userA.id, scope: "grantry-dev" } })) === 0,
  "deleting tenant cascades to its connections");
assert((await prisma.connection.count({ where: { ownerId: userB.id, scope: "grantry-dev" } })) === 1,
  "userB's same-slug tenant and connection survive");
assert((await prisma.connection.count({ where: { ownerId: userA.id, scope: "" } })) === 1,
  "unscoped connection survives tenant deletion");

// --- unique constraint: duplicate (ownerId, slug) rejected ---
let dupRejected = false;
try {
  await prisma.tenant.create({ data: { ownerId: userB.id, slug: "grantry-dev", displayName: "dup" } });
} catch (e) {
  dupRejected = e.code === "P2002";
}
assert(dupRejected, "duplicate (ownerId, slug) rejected by unique constraint");

await prisma.$disconnect();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
