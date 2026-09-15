import assert from "node:assert/strict";
import { test } from "node:test";

import { callTwentyTool } from "../../src/connectors/twenty.js";

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const TWENTY_TIMEOUT_MS = 12_000; // mirrors src/connectors/twenty.ts

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function installFetchMock(handler: (call: FetchCall, attempt: number) => Response) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    const attempt = calls.length;
    calls.push(call);
    return handler(call, attempt);
  }) as typeof fetch;
  return calls;
}

// Records every setTimeout delay and fires it immediately, so the retry/backoff
// path is exercised without real waits. The per-request abort timer is harmless
// here (the mock fetch ignores the signal and fetchTwenty clears it in finally).
function fastTimeout(waits: number[]) {
  globalThis.setTimeout = ((cb: any, ms?: number, ...rest: any[]) => {
    waits.push(ms ?? 0);
    return originalSetTimeout(cb, 0, ...rest);
  }) as typeof setTimeout;
}

function retryWaits(waits: number[]) {
  return waits.filter((ms) => ms !== TWENTY_TIMEOUT_MS);
}

test("twenty/create_record sends the bearer token and the JSON body", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const calls = installFetchMock(() => jsonResponse({ id: "rec_1", name: "Ada" }));
  fastTimeout([]);

  const result = await callTwentyTool("twenty/create_record", { object: "people", data: { name: "Ada" } }, "k");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.twenty.com/rest/people");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as any).Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { name: "Ada" });
  assert.equal((result.structuredContent as any).id, "rec_1");
});

test("twenty request retries a 429 honoring retry-after and then succeeds", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const calls = installFetchMock((_call, attempt) =>
    attempt === 0
      ? jsonResponse({ statusCode: 429, error: "HttpException" }, { status: 429, headers: { "retry-after": "1" } })
      : jsonResponse({ id: "rec_2" })
  );
  const waits: number[] = [];
  fastTimeout(waits);

  const result = await callTwentyTool("twenty/create_record", { object: "people", data: { name: "Grace" } }, "k");

  assert.equal(calls.length, 2);
  assert.deepEqual(retryWaits(waits), [1000]); // retry-after: 1 (seconds)
  assert.equal((result.structuredContent as any).id, "rec_2");
});

test("twenty request retries a 429 without a retry-after header on capped backoff", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const calls = installFetchMock(() => jsonResponse({ statusCode: 429 }, { status: 429 }));
  const waits: number[] = [];
  fastTimeout(waits);

  await assert.rejects(
    callTwentyTool("twenty/create_record", { object: "people", data: { name: "Hopper" } }, "k"),
    (e: any) => {
      assert.match(String(e.message), /rate limited by upstream: gave up after 5 attempts/);
      // The verify for issue #184 counts audit_log rows whose errorMessage
      // contains "failed: 429" as unhandled upstream rate limits; the final
      // error after the retry cap must stay out of that bucket.
      assert.equal(String(e.message).includes("failed: 429"), false);
      return true;
    }
  );
  assert.equal(calls.length, 5);
  assert.deepEqual(retryWaits(waits), [1000, 2000, 4000, 8000]); // backoff, capped at 30s
});

test("twenty request keeps non-429 errors as-is", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const calls = installFetchMock(() => jsonResponse({ message: "boom" }, { status: 500 }));
  fastTimeout([]);

  await assert.rejects(
    callTwentyTool("twenty/get_record", { object: "people", record_id: "rec_3" }, "k"),
    /failed: 500/
  );
  assert.equal(calls.length, 1);
});
