import assert from "node:assert/strict";
import { test } from "node:test";

import { credentialCheckRejection } from "../../src/connectors/credential_meta.js";
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

test("credentialCheckRejection rejects a definitive connect-time auth failure with its provider message", () => {
  const rejection = credentialCheckRejection({
    healthStatus: "error",
    healthErrorMessage: "GitHub token check failed: 401 Bad credentials",
  });
  assert.equal(rejection, "GitHub token check failed: 401 Bad credentials");
});

test("credentialCheckRejection falls back to a generic message when the provider error is empty", () => {
  assert.equal(credentialCheckRejection({ healthStatus: "error", healthErrorMessage: "" }), "credential check failed");
  assert.equal(credentialCheckRejection({ healthStatus: "error" }), "credential check failed");
});

test("credentialCheckRejection allows ok, warn (missing scope), and unknown (check outage) so a paste is never blocked by a transient failure", () => {
  assert.equal(credentialCheckRejection({ healthStatus: "ok", healthErrorMessage: null }), null);
  assert.equal(credentialCheckRejection({ healthStatus: "warn", healthErrorMessage: "missing_scope" }), null);
  assert.equal(credentialCheckRejection({ healthStatus: "unknown", healthErrorCode: "check_unavailable" }), null);
  assert.equal(credentialCheckRejection(null), null);
});
