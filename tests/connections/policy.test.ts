import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeToolName } from "../../src/policy.js";

test("normalizeToolName canonicalizes catalogued public tool names", () => {
  assert.equal(normalizeToolName("google_analytics_run_report"), "google_analytics/run_report");
});

test("normalizeToolName falls back to provider prefix when the tool catalog drifts", () => {
  assert.equal(normalizeToolName("google_analytics_future_tool"), "google_analytics/future_tool");
  assert.equal(normalizeToolName("google_tag_manager_future_tool"), "google_tag_manager/future_tool");
});

test("normalizeToolName leaves unknown provider-prefixed names untouched", () => {
  assert.equal(normalizeToolName("unknown_provider_future_tool"), "unknown_provider_future_tool");
});
