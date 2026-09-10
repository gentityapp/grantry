import assert from "node:assert/strict";
import { test } from "node:test";

import { callXTool } from "../../src/connectors/x.js";
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

test("x manifest requests the follow scopes and gates the follow tools on them", () => {
  const x = getProvider("x");
  assert.ok(x.oauthScopes?.includes("follows.write"));
  assert.ok(x.oauthScopes?.includes("follows.read"));
  assert.deepEqual(x.toolScopeRequirements?.["x/follow_user"], ["follows.write"]);
  assert.deepEqual(x.toolScopeRequirements?.["x/unfollow_user"], ["follows.write"]);
  assert.deepEqual(x.toolScopeRequirements?.["x/get_following"], ["follows.read"]);
  for (const tool of ["x/get_following", "x/follow_user", "x/unfollow_user"]) assert.ok(x.tools.includes(tool), tool);
});

test("x/follow_user resolves a handle, then posts to the authorized user's following list", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(({ url, init }) => {
    if (url.endsWith("/2/users/by/username/sampleuser")) return jsonResponse({ data: { id: "145607246", username: "sampleuser" } });
    if (url.endsWith("/2/users/me")) return jsonResponse({ data: { id: "1217246222018215936", username: "ops ownerroot" } });
    if (url.endsWith("/2/users/1217246222018215936/following") && init?.method === "POST") {
      return jsonResponse({ data: { following: true, pending_follow: false } });
    }
    return jsonResponse({ title: "Not Found" }, { status: 404 });
  });

  const result = await callXTool("x/follow_user", { username: "@sampleuser" }, "tok");

  assert.equal(calls.length, 3);
  const post = calls[2];
  assert.equal(post.url, "https://api.x.com/2/users/1217246222018215936/following");
  assert.equal(post.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(post.init?.body)), { target_user_id: "145607246" });
  assert.equal((post.init?.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.deepEqual(result.structuredContent, {
    source_user_id: "1217246222018215936",
    target_user_id: "145607246",
    data: { following: true, pending_follow: false },
  });
});

test("x/follow_user skips the handle lookup when target_user_id is given and surfaces a 403", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(({ url }) => {
    if (url.endsWith("/2/users/me")) return jsonResponse({ data: { id: "1" } });
    return jsonResponse({ title: "Forbidden", status: 403 }, { status: 403 });
  });

  await assert.rejects(callXTool("x/follow_user", { target_user_id: "42" }, "tok"), /x\/follow_user failed: 403/);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith("/2/users/1/following"));
});

test("x/unfollow_user deletes the edge and x/get_following defaults to the authorized user", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(({ url, init }) => {
    if (url.endsWith("/2/users/me")) return jsonResponse({ data: { id: "1" } });
    if (init?.method === "DELETE") return jsonResponse({ data: { following: false } });
    if (url.includes("/2/users/1/following?")) return jsonResponse({ data: [{ id: "42" }], meta: { result_count: 1 } });
    return jsonResponse({}, { status: 404 });
  });

  const unfollow = await callXTool("x/unfollow_user", { target_user_id: "42" }, "tok");
  assert.equal(calls[1].url, "https://api.x.com/2/users/1/following/42");
  assert.equal(calls[1].init?.method, "DELETE");
  assert.equal((unfollow.structuredContent as any).data.following, false);

  const following = await callXTool("x/get_following", { max_results: 5 }, "tok");
  const listCall = calls[calls.length - 1];
  assert.ok(listCall.url.startsWith("https://api.x.com/2/users/1/following?"));
  assert.ok(listCall.url.includes("max_results=5"));
  assert.equal((following.structuredContent as any).meta.result_count, 1);
});

test("x/follow_user requires a target", async () => {
  await assert.rejects(callXTool("x/follow_user", {}, "tok"), /target_user_id or username is required/);
});
