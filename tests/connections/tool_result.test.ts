import assert from "node:assert/strict";
import { test } from "node:test";

import { providerToolResult } from "../../src/tool_result.js";

test("content text carries the full payload, no truncation", () => {
  const payload = { items: Array.from({ length: 2000 }, (_, i) => ({ id: `row_${i}`, name: `Account ${i}` })) };
  const r = providerToolResult({ structuredContent: payload });
  assert.ok(r.content[0].text.length > 8000);
  assert.deepEqual(JSON.parse(r.content[0].text), payload);
  assert.deepEqual(r.structuredContent, payload);
  assert.equal(r.isError, false);
});

test("falls back to the raw result when structuredContent is absent", () => {
  const r = providerToolResult({ ok: true });
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true });
  assert.equal(r.structuredContent, undefined);
});
