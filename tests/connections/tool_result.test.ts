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

// ---------- lossless compact format ----------
import { compactPayload, expandPayload } from "../../src/tool_result.js";

function stripNulls(v: any): any {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) o[k] = stripNulls(x);
    return o;
  }
  return v;
}
const roundTrips = (v: any) => assert.deepEqual(expandPayload(compactPayload(v)), stripNulls(v));

test("compact: Google Ads rows become a table and expand back exactly", () => {
  const sc = { api_version: "v22", results: [
    { campaign: { resourceName: "customers/1/campaigns/9", status: "PAUSED", name: "ルートチーム", id: "9" }, metrics: { conversions: 0, costMicros: "0" } },
    { campaign: { resourceName: "customers/1/campaigns/8", status: "ENABLED", name: "general-003", id: "8" }, metrics: { conversions: 2.5, costMicros: "1200000" } },
  ] };
  const c: any = compactPayload(sc);
  assert.deepEqual(c.results.$cols, ["campaign.resourceName", "campaign.status", "campaign.name", "campaign.id", "metrics.conversions", "metrics.costMicros"]);
  assert.equal(c.results.$rows.length, 2);
  assert.ok(JSON.stringify(c).length < JSON.stringify(sc).length);
  roundTrips(sc);
});

test("compact: nested arrays in cells (Meta actions), sparse columns, nulls", () => {
  const sc = { results: [
    { campaign_id: "1", spend: "32453", actions: [{ action_type: "lead", value: "4" }, { action_type: "link_click", value: "67" }], date_stop: null },
    { campaign_id: "2", spend: "0", extra: { deep: { x: 1 } } },
    { campaign_id: "3", actions: [] },
  ], paging: { cursors: { before: "a", after: null } } };
  roundTrips(sc);
  const c: any = compactPayload(sc);
  assert.equal(c.paging.cursors.after, undefined, "null dropped");
  assert.deepEqual(c.results.$rows[0][2].$cols, ["action_type", "value"], "cell arrays compacted too");
});

test("compact: ambiguous shapes are left alone (still lossless)", () => {
  const dotted = [{ "a.b": 1 }, { "a.b": 2 }];
  assert.deepEqual(compactPayload(dotted), dotted);
  const prefix = [{ a: 1 }, { a: { b: 2 } }];
  assert.deepEqual(compactPayload(prefix), prefix);
  const reserved = [{ $cols: 1 }, { $cols: 2 }];
  assert.deepEqual(compactPayload(reserved), reserved);
  const single = [{ a: 1 }];
  assert.deepEqual(compactPayload(single), single);
  const mixed = [{ a: 1 }, 2, "x"];
  assert.deepEqual(compactPayload(mixed), mixed);
  for (const v of [dotted, prefix, reserved, single, mixed, [{ e: {} }, { e: {} }], "s", 0, false, []]) roundTrips(v);
});

test("compact: pseudo-random payloads round-trip", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gen = (depth: number): any => {
    const r = rnd();
    if (depth > 3 || r < 0.3) return [null, 1, "x", true, 2.5, ""][Math.floor(rnd() * 6)];
    if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth + 1));
    const o: any = {};
    for (let i = 0; i < Math.floor(rnd() * 4); i++) o[["id", "name", "m", "n"][i]] = gen(depth + 1);
    return o;
  };
  for (let i = 0; i < 3000; i++) {
    const rows = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => ({ id: i, v: gen(1), w: gen(1) }));
    roundTrips({ results: rows, other: gen(0) });
  }
});

test("providerToolResult: compact only when asked; content mirrors structuredContent", () => {
  const raw = { structuredContent: { results: [{ a: 1, b: null }, { a: 2 }] } };
  const plain = providerToolResult(raw);
  assert.deepEqual(plain.structuredContent, raw.structuredContent);
  const compact = providerToolResult(raw, { compact: true });
  assert.deepEqual(compact.structuredContent, { results: { $cols: ["a"], $rows: [[1], [2]] } });
  assert.equal(compact.content[0].text, JSON.stringify(compact.structuredContent));
});
