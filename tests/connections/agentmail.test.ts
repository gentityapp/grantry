import assert from "node:assert/strict";
import { test } from "node:test";
import { callAgentMailTool } from "../../src/connectors/agentmail.js";
import { callGenericProviderRequest } from "../../src/connectors/generic_request.js";
import { getProvider } from "../../src/connectors/registry.js";

function mockFetch(t: any, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(status === 200 ? { message_id: "m1" } : { message: "Not authorized" }), { status });
  }) as typeof fetch;
  return calls;
}

test("generic requests use the same credential region as inbox tools", async (t) => {
  const calls = mockFetch(t);
  for (const credential of ["am_eu_test", JSON.stringify({ api_key: "am_test", region: "eu" })]) {
    await callGenericProviderRequest({ provider: getProvider("agentmail")!, toolName: "agentmail/request", credential, requestArgs: { method: "GET", path: "/inboxes" } });
    assert.equal(calls.at(-1)!.url, "https://api.agentmail.eu/v0/inboxes");
    assert.equal(new Headers(calls.at(-1)!.init?.headers).get("authorization"), "Bearer " + (credential.startsWith("{") ? "am_test" : credential));
  }
});

test("send and reply preserve idempotency headers and pinned inboxes", async (t) => {
  const calls = mockFetch(t);
  const credential = JSON.stringify({ api_key: "am_test", inbox_id: "test@example.com", region: "eu" });
  await callAgentMailTool("agentmail/send_message", { to: ["recipient@example.com"], subject: "Test", text: "Body", idempotency_key: "send-1", track_opens: false }, credential);
  assert.equal(calls[0].url, "https://api.agentmail.eu/v0/inboxes/test%40example.com/messages/send");
  assert.equal(new Headers(calls[0].init?.headers).get("Idempotency-Key"), "send-1");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.track_opens, false);
  assert.equal(body.idempotency_key, undefined);
  await callAgentMailTool("agentmail/reply_message", { message_id: "m/1", text: "Reply", reply_all: true, idempotency_key: "reply-1" }, credential);
  assert.match(calls[1].url, /messages\/m%2F1\/reply-all$/);
  assert.equal(new Headers(calls[1].init?.headers).get("Idempotency-Key"), "reply-1");
});

test("invalid input fails before sending and provider errors do not trigger retries", async (t) => {
  const calls = mockFetch(t, 403);
  await assert.rejects(callAgentMailTool("agentmail/send_message", { inbox_id: "test@example.com", to: "recipient@example.com", subject: "Test" }, "am_test"), /text or html is required/);
  assert.equal(calls.length, 0);
  await assert.rejects(callAgentMailTool("agentmail/list_inboxes", {}, "am_test"), /403 Not authorized/);
  assert.equal(calls.length, 1);
});
