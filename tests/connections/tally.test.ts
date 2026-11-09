import assert from "node:assert/strict";
import test from "node:test";
import { getProvider } from "../../src/connectors/registry.js";
import { callTallyTool, tallyInputProperties, tallyRequiredArgs } from "../../src/connectors/tally.js";
import { callGenericCheckConnection, callGenericProviderRequest } from "../../src/connectors/generic_request.js";
import { credentialMetadataForStorage } from "../../src/connectors/credential_meta.js";

const provider = getProvider("tally")!;
function mockFetch(t: any, status = 200) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(status === 200 ? { id: "user_1", submissions: [], hasMore: true, page: 2 } : { message: "Unauthorized" }), { status });
  }) as typeof fetch;
  return calls;
}

test("Tally onboarding is verified with a read-only authenticated account probe", async (t) => {
  const calls = mockFetch(t);
  assert.deepEqual(provider.authTypes, ["pat"]);
  assert.equal(provider.tokenUrl, "https://tally.so/settings/api-keys");
  const result = await credentialMetadataForStorage("tally", "pat", "tly_test_only");
  assert.equal(result.healthStatus, "ok");
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url.origin, "https://api.tally.so");
    assert.ok(["/users/me", "/forms", "/workspaces", "/webhooks"].includes(call.url.pathname));
    assert.equal(call.url.searchParams.has("timezone"), false);
    assert.equal(call.init.method, "GET");
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer tly_test_only");
    assert.equal(call.init.body, undefined);
  }
});

test("Tally invalid credentials fail the connection probe", async (t) => {
  mockFetch(t, 401);
  const result = await callGenericCheckConnection({ provider, credential: "tly_test_invalid" });
  assert.equal(result.structuredContent.status, "error");
});

test("forms preserve pagination and repeat workspace filters", async (t) => {
  const calls = mockFetch(t);
  await callTallyTool("tally/list_forms", { page: 2, limit: 500, workspace_ids: ["abc", "def"], api_version: "2026-01-01" }, "tly_test_only", provider);
  assert.equal(calls[0].url.pathname, "/forms");
  assert.equal(calls[0].url.searchParams.get("page"), "2");
  assert.equal(calls[0].url.searchParams.get("limit"), "500");
  assert.deepEqual(calls[0].url.searchParams.getAll("workspaceIds"), ["abc", "def"]);
  assert.equal(new Headers(calls[0].init.headers).get("tally-version"), "2026-01-01");
});

test("submission filters match Tally names and return pagination metadata", async (t) => {
  const calls = mockFetch(t);
  const result = await callTallyTool("tally/list_submissions", { form_id: "abc", page: 2, limit: 100, filter: "completed", start_date: "2026-11-01T00:00:00Z", end_date: "2026-11-09T00:00:00Z" }, "tly_test_only", provider);
  assert.equal(calls[0].url.pathname, "/forms/abc/submissions");
  assert.equal(calls[0].url.searchParams.get("filter"), "completed");
  assert.equal(calls[0].url.searchParams.get("startDate"), "2026-11-01T00:00:00Z");
  assert.equal(calls[0].url.searchParams.get("endDate"), "2026-11-09T00:00:00Z");
  assert.equal((result.structuredContent.body as any).hasMore, true);
  assert.equal((result.structuredContent.body as any).page, 2);
});

test("form and webhook writes use the documented verbs, paths and bodies", async (t) => {
  const calls = mockFetch(t);
  const cases = [
    ["tally/create_form", { data: { status: "DRAFT", blocks: [] } }, "POST", "/forms"],
    ["tally/update_form", { form_id: "abc", data: { status: "PUBLISHED" } }, "PATCH", "/forms/abc"],
    ["tally/delete_form", { form_id: "abc" }, "DELETE", "/forms/abc"],
    ["tally/get_form", { form_id: "abc" }, "GET", "/forms/abc"],
    ["tally/list_questions", { form_id: "abc" }, "GET", "/forms/abc/questions"],
    ["tally/get_submission", { form_id: "abc", submission_id: "sub" }, "GET", "/forms/abc/submissions/sub"],
    ["tally/delete_submission", { form_id: "abc", submission_id: "sub" }, "DELETE", "/forms/abc/submissions/sub"],
    ["tally/create_webhook", { data: { formId: "abc", url: "https://example.com/hook", eventTypes: ["FORM_RESPONSE"] } }, "POST", "/webhooks"],
    ["tally/update_webhook", { webhook_id: "hook", data: { url: "https://example.com/hook", eventTypes: ["FORM_RESPONSE"], isEnabled: false } }, "PATCH", "/webhooks/hook"],
    ["tally/delete_webhook", { webhook_id: "hook" }, "DELETE", "/webhooks/hook"],
    ["tally/list_workspaces", { page: 2 }, "GET", "/workspaces"],
    ["tally/list_webhooks", { limit: 100 }, "GET", "/webhooks"],
  ] as const;
  for (const [name, args, method, path] of cases) {
    await callTallyTool(name, args, "tly_test_only", provider);
    const call = calls.at(-1)!;
    assert.equal(call.init.method, method);
    assert.equal(call.url.pathname, path);
    assert.equal(call.url.origin, "https://api.tally.so");
    assert.equal(call.init.body, "data" in args ? JSON.stringify(args.data) : undefined);
  }
});

test("invalid named-tool inputs are rejected before contacting Tally", async (t) => {
  const calls = mockFetch(t);
  for (const [name, args] of [
    ["tally/get_form", {}], ["tally/get_form", { form_id: ".." }],
    ["tally/create_form", { data: [] }], ["tally/create_form", {}],
    ["tally/list_forms", { page: 0 }], ["tally/list_forms", { limit: 501 }],
    ["tally/list_webhooks", { limit: 101 }], ["tally/list_forms", { workspace_ids: "abc" }],
    ["tally/list_submissions", { form_id: "abc", filter: "unread" }],
  ] as const) await assert.rejects(callTallyTool(name, args, "tly_test_only", provider));
  assert.equal(calls.length, 0);
});

test("named tools cannot override their method, host or credential; generic guards apply", async (t) => {
  const calls = mockFetch(t);
  await callTallyTool("tally/get_me", { method: "DELETE", path: "https://example.com", headers: { Authorization: "Bearer wrong" } }, "tly_test_only", provider);
  assert.equal(calls[0].url.href, "https://api.tally.so/users/me");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer tly_test_only");
  for (const requestArgs of [{ path: "https://example.com" }, { path: "/users/me", headers: { Authorization: "Bearer wrong" } }]) {
    await assert.rejects(callGenericProviderRequest({ provider, toolName: "tally/request", credential: "tly_test_only", requestArgs }));
  }
  assert.equal(calls.length, 1);
});

test("Tally exposes named schemas plus the existing generic capability tools", () => {
  for (const name of ["tally/request", "tally/check_connection", "tally/list_capabilities", "tally/create_form", "tally/list_submissions"]) assert.ok(provider.tools.includes(name));
  assert.deepEqual(tallyRequiredArgs("tally/update_form"), ["form_id", "data"]);
  assert.deepEqual(tallyRequiredArgs("tally/get_submission"), ["form_id", "submission_id"]);
  assert.deepEqual((tallyInputProperties("tally/list_submissions").filter as any).enum, ["all", "completed", "partial"]);
});
