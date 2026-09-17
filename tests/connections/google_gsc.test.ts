import assert from "node:assert/strict";
import { test } from "node:test";

import { PROVIDERS } from "../../src/connectors/registry.js";

test("google_gsc manifest exposes a url_inspection operation on the webmasters v3 inspect endpoint", () => {
  const manifest = PROVIDERS.google_gsc?.genericRequest;
  assert.ok(manifest, "google_gsc has a genericRequest manifest");
  const op = (manifest.operations ?? []).find((o) => o.id === "url_inspection");
  assert.ok(op, "url_inspection operation exists in the manifest");
  assert.equal(op.method, "POST");
  assert.equal(op.baseUrlKey, "webmasters");
  assert.equal(op.risk, "read");
  assert.equal(
    manifest.baseUrls?.webmasters + op.path,
    "https://www.googleapis.com/webmasters/v3/urlInspection/index:inspect"
  );
  // Agents must learn from the description alone that the body carries
  // inspectionUrl and an already-URL-encoded siteUrl.
  assert.match(op.description, /inspectionUrl/);
  assert.match(op.description, /siteUrl/);
  assert.match(op.description, /URL-encoded/i);
});

test("google_gsc request accepts POST at runtime (registry overrides defaultMethods)", () => {
  const manifest = PROVIDERS.google_gsc?.genericRequest;
  assert.ok(manifest, "google_gsc has a genericRequest manifest");
  // The manifest text keeps GET/PUT/DELETE, but the runtime registry rewrites
  // defaultMethods for every provider with a genericRequest manifest, so the
  // POST url_inspection call must be permitted. If this breaks, agents fall
  // back to guessing paths again.
  assert.ok(manifest.defaultMethods.includes("POST"));
});
