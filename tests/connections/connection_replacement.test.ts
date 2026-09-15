import assert from "node:assert/strict";
import { test } from "node:test";

import { otherEnabledConnectionsWhere } from "../../src/provider_credentials.js";

test("otherEnabledConnectionsWhere targets every other enabled connection at the same (owner, workspace, provider, scope)", () => {
  const where = otherEnabledConnectionsWhere({
    ownerId: "u1",
    workspaceId: "w1",
    provider: "github",
    scope: "tenant-a",
    keepConnectionId: "conn_new",
  });
  assert.deepEqual(where, {
    ownerId: "u1",
    workspaceId: "w1",
    provider: { in: ["github"] },
    scope: "tenant-a",
    enabled: true,
    id: { not: "conn_new" },
  });
});

test("otherEnabledConnectionsWhere keeps provider aliases (railway/railway_api) in the same ambiguity family as checkPolicy", () => {
  const where = otherEnabledConnectionsWhere({ ownerId: "u1", provider: "railway", scope: "tenant-a" });
  assert.deepEqual(where.provider, { in: ["railway", "railway_api"] });
});

test("otherEnabledConnectionsWhere omits workspace and keep-id filters when not given", () => {
  const where = otherEnabledConnectionsWhere({ ownerId: "u1", provider: "github", scope: "tenant-a" });
  assert.equal("workspaceId" in where, false);
  assert.equal("id" in where, false);
  assert.equal(where.enabled, true);
});
