import assert from "node:assert/strict";
import { test } from "node:test";

import { callClayTool, clayPublicPath } from "../../src/connectors/clay.js";
import { callGenericProviderRequest } from "../../src/connectors/generic_request.js";
import { getProvider } from "../../src/connectors/registry.js";

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function installFetchMock(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function headersOf(call: FetchCall) {
  return call.init?.headers as Record<string, string>;
}

test("clay paths are normalised onto the Public API and legacy versions are rejected", () => {
  assert.equal(clayPublicPath("/me"), "/public/v0/me");
  assert.equal(clayPublicPath("me"), "/public/v0/me");
  assert.equal(clayPublicPath("/v0/me"), "/public/v0/me");
  assert.equal(clayPublicPath("/public/v0/tables/query"), "/public/v0/tables/query");
  assert.throws(() => clayPublicPath("/v1/tables/t_1/rows"), /deprecated API endpoint/);
  assert.throws(() => clayPublicPath("/v3/tables/t_1/records"), /deprecated API endpoint/);
  assert.throws(() => clayPublicPath("https://api.clay.com/public/v0/me"), /not a full URL/);
});

test("clay/me sends the clay-api-key header, not a Bearer token", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(() => jsonResponse({ user: { id: "u1", name: "Ops" }, workspace: { id: "800863", name: "Root" } }));

  const result = await callClayTool("clay/me", {}, "clay-test-key");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.clay.com/public/v0/me");
  assert.equal(headersOf(calls[0])["clay-api-key"], "clay-test-key");
  assert.equal(headersOf(calls[0]).Authorization, undefined);
  assert.equal((result.structuredContent as any).workspace.id, "800863");
});

test("clay/search creates the search then fetches the first page", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock((call) => {
    if (call.url.endsWith("/search/query-mode")) return jsonResponse({ search_id: "s_1", source_type: "companies" });
    return jsonResponse({ results: [{ name: "Clay" }], has_more: false });
  });

  const result = await callClayTool("clay/search", { query: "companies in Tokyo", limit: 5 }, "k");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init?.body, JSON.stringify({ query: "companies in Tokyo" }));
  assert.equal(calls[1].url, "https://api.clay.com/public/v0/search/query-mode/s_1/run");
  assert.equal(calls[1].init?.body, JSON.stringify({ limit: 5 }));
  const content = result.structuredContent as any;
  assert.equal(content.search_id, "s_1");
  assert.equal(content.source_type, "companies");
  assert.equal(content.results.length, 1);
});

test("clay/search_reference returns a heading index instead of the whole 170k-char grammar", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const reference = [
    "# Clay search query reference",
    "intro line",
    "## Operators",
    "eq, contains, in",
    "### People fields",
    "x".repeat(5000),
  ].join("\n");
  installFetchMock(() => jsonResponse({ reference }));

  const index = await callClayTool("clay/search_reference", { max_chars: 500 }, "k");
  const content = index.structuredContent as any;
  assert.deepEqual(content.sections, ["Clay search query reference", "Operators", "People fields"]);
  assert.equal(content.total_chars, reference.length);
  assert.equal(content.reference.length, 500);
  assert.equal(content.truncated, true);

  const section = await callClayTool("clay/search_reference", { section: "operators" }, "k");
  const sectionContent = section.structuredContent as any;
  assert.deepEqual(sectionContent.sections, ["Operators"]);
  assert.equal(sectionContent.reference, "## Operators\neq, contains, in");
  assert.equal(sectionContent.truncated, false);

  await assert.rejects(() => callClayTool("clay/search_reference", { section: "nope" }, "k"), /no reference section matches/);
});

test("clay/query_tables builds a structured query from table_id shortcuts", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(() => jsonResponse({ data: [], fields: {} }));

  await callClayTool("clay/query_tables", { table_id: "t_abc", select: [{ field: "Domain" }], filter: { field: "Domain", op: "is_not_empty" }, limit: 500, cursor: "c1" }, "k");

  assert.equal(calls[0].url, "https://api.clay.com/public/v0/tables/query");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    query: { tables: [{ id: "t_abc" }], field_mode: "names", select: [{ field: "Domain" }], filter: { field: "Domain", op: "is_not_empty" } },
    limit: 100,
    cursor: "c1",
  });
});

test("clay/run_routine validates items and clay/get_routine_run flags 202 as in progress", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(() => callClayTool("clay/run_routine", { routine_id: "function:t_1", items: [] }, "k"), /items must be a non-empty array/);

  const calls = installFetchMock((call) => {
    if (call.url.endsWith("/run")) return jsonResponse({ routine_run_id: "r_1", status: "in_progress" }, { status: 202 });
    return jsonResponse({ routine_run_id: "r_1", status: "in_progress", total: 1, finished: 0 }, { status: 202 });
  });

  const run = await callClayTool("clay/run_routine", { routine_id: "function:t_1", items: [{ id: "row-1", inputs: { domain: "example.com" } }] }, "k");
  assert.equal(calls[0].url, "https://api.clay.com/public/v0/routines/function%3At_1/run");
  assert.equal((run.structuredContent as any).routine_run_id, "r_1");

  const progress = await callClayTool("clay/get_routine_run", { routine_run_id: "r_1", limit: 10 }, "k");
  assert.equal(calls[1].url, "https://api.clay.com/public/v0/routines/run/r_1/results?limit=10");
  assert.equal((progress.structuredContent as any).in_progress, true);
});

test("clay/push_webhook only posts to Clay table webhook sources and sends no API key", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(() => callClayTool("clay/push_webhook", { webhook_url: "https://example.com/hook", data: { a: 1 } }, "k"), /webhook source URL/);
  await assert.rejects(() => callClayTool("clay/push_webhook", { webhook_url: "https://api.clay.com/public/v0/me", data: { a: 1 } }, "k"), /webhook source URL/);

  const calls = installFetchMock(() => jsonResponse({ ok: true }));
  const result = await callClayTool(
    "clay/push_webhook",
    { webhook_url: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-abc", rows: [{ 姓: "鈴木" }, { 姓: "吉田" }] },
    "k",
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-abc");
  assert.equal(headersOf(calls[0])["clay-api-key"], undefined);
  assert.equal(calls[1].init?.body, JSON.stringify({ 姓: "吉田" }));
  assert.equal((result.structuredContent as any).sent, 2);
});

test("clay errors carry the Clay message and a key hint on 401", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  installFetchMock(() => jsonResponse({ message: "Authentication failed" }, { status: 401 }));
  await assert.rejects(() => callClayTool("clay/me", {}, "legacy-key"), /401 Authentication failed.*API keys \(beta\)/);
});

test("clay generic request uses the clay-api-key header and the /public/v0 prefix policy", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const provider = getProvider("clay");
  assert.ok(provider?.genericRequest);
  assert.equal(provider.genericRequest.apiKeyHeader, "clay-api-key");
  assert.deepEqual(provider.genericRequest.smokeTests?.map((s) => s.path), ["/public/v0/me"]);

  const calls = installFetchMock(() => jsonResponse({ reference: "# Clay search" }));
  await callGenericProviderRequest({
    provider,
    toolName: "clay/request",
    credential: "clay-test-key",
    requestArgs: { method: "GET", path: "/public/v0/search/query-mode/reference" },
  });
  assert.equal(calls[0].url, "https://api.clay.com/public/v0/search/query-mode/reference");
  assert.equal(headersOf(calls[0])["clay-api-key"], "clay-test-key");

  await assert.rejects(
    () => callGenericProviderRequest({ provider, toolName: "clay/request", credential: "clay-test-key", requestArgs: { method: "GET", path: "/v1/tables" } }),
  );
});
