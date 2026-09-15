import assert from "node:assert/strict";
import test from "node:test";
import { callSentryTool, parseSentryCredential } from "../../src/connectors/sentry.js";

type Call = { url: string; init?: RequestInit };

function mockFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

test("credential parsing: raw token defaults to sentry.io, JSON carries org and EU host", () => {
  assert.deepEqual(parseSentryCredential("sntryu_abc"), { token: "sntryu_abc", apiBase: "https://sentry.io/api/0" });
  assert.deepEqual(
    parseSentryCredential(JSON.stringify({ token: "t", organization: "acme", base_url: "https://de.sentry.io/" })),
    { token: "t", apiBase: "https://de.sentry.io/api/0", organization: "acme" },
  );
  assert.equal(parseSentryCredential(JSON.stringify({ token: "t", base_url: "https://sentry.example.com/api/0" })).apiBase, "https://sentry.example.com/api/0");
});

test("list_issues uses the stored org, defaults to is:unresolved and returns the next cursor", async () => {
  const { calls, restore } = mockFetch(() => json(
    [{ id: "42", shortId: "API-1", title: "TypeError", status: "unresolved", count: "3", project: { slug: "api" }, assignedTo: null }],
    { link: '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/organizations/acme/issues/?cursor=0:25:0>; rel="next"; results="true"; cursor="0:25:0"' },
  ));
  try {
    const result: any = await callSentryTool("sentry/list_issues", { environment: ["production"] }, JSON.stringify({ token: "t", organization: "acme" }));
    assert.equal(calls[0].url, "https://sentry.io/api/0/organizations/acme/issues/?query=is%3Aunresolved&environment=production");
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer t");
    assert.equal(result.structuredContent.next_cursor, "0:25:0");
    assert.equal(result.structuredContent.issues[0].short_id, "API-1");
  } finally {
    restore();
  }
});

test("get_issue_event resolves a short id and trims the event to in-app frames", async () => {
  const { calls, restore } = mockFetch(({ url }) => {
    if (url.endsWith("/shortids/API-1/")) return json({ groupId: "42" });
    return json({
      eventID: "abc",
      groupID: "42",
      title: "TypeError: x is undefined",
      tags: [{ key: "environment", value: "production" }],
      entries: [{ type: "exception", data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames: [
        { filename: "node_modules/lib.js", function: "wrap", lineNo: 1, inApp: false },
        { filename: "src/app.ts", function: "handler", lineNo: 10, inApp: true, context: [[10, "  return x.y;"]] },
      ] } }] } }],
    });
  });
  try {
    const result: any = await callSentryTool("sentry/get_issue_event", { issue_id: "API-1" }, JSON.stringify({ token: "t", organization: "acme" }));
    assert.equal(calls[1].url, "https://sentry.io/api/0/organizations/acme/issues/42/events/latest/");
    const ex = result.structuredContent.exceptions[0];
    assert.equal(ex.stacktrace.frames.length, 1);
    assert.equal(ex.stacktrace.frames[0].context_line, "  return x.y;");
    assert.equal(result.structuredContent.environment, "production");
  } finally {
    restore();
  }
});

test("update_issue requires a field and org", async () => {
  await assert.rejects(callSentryTool("sentry/update_issue", { issue_id: "1" }, "t"), /organization is required/);
  await assert.rejects(callSentryTool("sentry/update_issue", { issue_id: "1", organization: "acme" }, "t"), /at least one of status/);
});
