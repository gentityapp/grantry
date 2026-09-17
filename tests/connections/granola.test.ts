import assert from "node:assert/strict";
import { test } from "node:test";

import { callGranolaTool } from "../../src/connectors/granola.js";

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

test("granola/list_notes sends the Granola headers and maps the response", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(({ url }) => {
    if (url === "https://public-api.granola.ai/v1/notes?page_size=20") {
      return jsonResponse({
        notes: [
          { id: "n1", title: "Standup", created_at: "2026-09-01T09:00:00Z" },
          { id: "n2", title: "Planning", created_at: "2026-09-02T10:00:00Z" },
        ],
        next_cursor: "cur2",
      });
    }
    return jsonResponse({ message: "Not Found" }, { status: 404 });
  });

  const result = await callGranolaTool("granola/list_notes", { page_size: 20 }, "grn_tok");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://public-api.granola.ai/v1/notes?page_size=20");
  assert.equal(calls[0].init?.method, "GET");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer grn_tok");
  assert.equal(headers.Accept, "application/json");
  assert.deepEqual(result.structuredContent, {
    notes: [
      { id: "n1", title: "Standup", created_at: "2026-09-01T09:00:00Z" },
      { id: "n2", title: "Planning", created_at: "2026-09-02T10:00:00Z" },
    ],
    next_cursor: "cur2",
  });
});

test("granola/get_note requests /v1/notes/{note_id} with the include query", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(({ url }) => {
    if (url === "https://public-api.granola.ai/v1/notes/note%2B42?include=transcript") {
      return jsonResponse({
        id: "note+42",
        title: "Design review",
        summary: "Reviewed the connector layer",
        transcript: [{ speaker: "A", text: "Let's start" }],
      });
    }
    return jsonResponse({ message: "Not Found" }, { status: 404 });
  });

  const result = await callGranolaTool(
    "granola/get_note",
    { note_id: "note+42", include: "transcript" },
    "grn_tok"
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://public-api.granola.ai/v1/notes/note%2B42?include=transcript");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer grn_tok"
  );
  assert.equal((result.structuredContent as any).id, "note+42");
  assert.equal((result.structuredContent as any).title, "Design review");
});

test("granola/list_notes maps a 401 to an error carrying the status and body", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(() =>
    jsonResponse({ message: "Invalid API key" }, { status: 401 })
  );

  await assert.rejects(
    callGranolaTool("granola/list_notes", {}, "expired_key"),
    (e: any) => {
      assert.match(String(e.message), /^Granola granola\/list_notes failed: 401 /);
      assert.ok(String(e.message).includes("Invalid API key"));
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("granola/list_notes maps an abort to the Granola timeout error", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(() => {
    // Same shape the connector's own AbortController timeout produces.
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    throw aborted;
  });

  await assert.rejects(
    callGranolaTool("granola/list_notes", {}, "grn_tok"),
    (e: any) => {
      assert.equal(String(e.message), "Granola request timed out after 12000ms");
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("granola/list_notes rethrows non-abort network errors as-is", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(() => {
    throw new Error("socket hang up");
  });

  await assert.rejects(
    callGranolaTool("granola/list_notes", {}, "grn_tok"),
    (e: any) => {
      assert.equal(String(e.message), "socket hang up");
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("granola rejects an unknown tool without fetching", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = installFetchMock(() => jsonResponse({}));

  await assert.rejects(
    callGranolaTool("granola/nope", {}, "grn_tok"),
    (e: any) => {
      assert.equal(String(e.message), "Unknown Granola tool: granola/nope");
      return true;
    }
  );
  assert.equal(calls.length, 0);
});
