import assert from "node:assert/strict";
import { test } from "node:test";

import { callGenericProviderRequest } from "../../src/connectors/generic_request.js";
import { getProvider, type ProviderDef } from "../../src/connectors/registry.js";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

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

test("built-in generic requests pass POST JSON bodies through to the provider", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const provider = getProvider("hubspot");
  assert.ok(provider?.genericRequest);
  assert.ok(provider.genericRequest.defaultMethods.includes("POST"));

  const calls = installFetchMock(() => jsonResponse({ id: "flow-1" }, { status: 201 }));
  const result = await callGenericProviderRequest({
    provider,
    toolName: "hubspot/request",
    credential: "hubspot-token",
    requestArgs: {
      method: "POST",
      path: "/automation/v4/flows",
      body: { name: "Lifecycle flow" },
      query: { archived: false },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.hubapi.com/automation/v4/flows?archived=false");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer hubspot-token");
  assert.equal((calls[0].init?.headers as Record<string, string>)["Content-Type"], "application/json");
  assert.equal(calls[0].init?.body, JSON.stringify({ name: "Lifecycle flow" }));
  assert.equal((result.structuredContent as any).status, 201);
});

test("generic request keeps explicit method policies for restricted manifests", async () => {
  const provider: ProviderDef = {
    key: "restricted",
    label: "Restricted",
    authTypes: ["pat"],
    helpText: "",
    tools: ["restricted/request"],
    genericRequest: {
      baseUrl: "https://api.example.com",
      defaultMethods: ["GET"],
      allowedPathPrefixes: ["/"],
    },
  };

  await assert.rejects(
    () => callGenericProviderRequest({
      provider,
      toolName: "restricted/request",
      credential: "token",
      requestArgs: { method: "POST", path: "/items", body: { name: "x" } },
    }),
    /currently allows GET only/,
  );
});

test("generic request blocks overriding authentication headers", async () => {
  const provider = getProvider("hubspot");
  assert.ok(provider?.genericRequest);

  await assert.rejects(
    () => callGenericProviderRequest({
      provider,
      toolName: "hubspot/request",
      credential: "hubspot-token",
      requestArgs: {
        method: "POST",
        path: "/automation/v4/flows",
        body: { name: "x" },
        headers: { Authorization: "Bearer attacker" },
      },
    }),
    /provider_header_not_allowed: Authorization cannot be overridden/,
  );
});

test("generic request supports API keys in query parameters without auth headers", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const provider: ProviderDef = {
    key: "query_auth",
    label: "Query Auth",
    authTypes: ["pat"],
    helpText: "",
    tools: ["query_auth/request"],
    genericRequest: {
      baseUrl: "https://api.example.com",
      defaultMethods: ["GET"],
      allowedPathPrefixes: ["/"],
      authScheme: "api_key_query",
      apiKeyQueryParam: "api_key",
    },
  };

  const calls = installFetchMock(() => jsonResponse([{ id: "one" }, { id: "two" }]));
  const result = await callGenericProviderRequest({
    provider,
    toolName: "query_auth/request",
    credential: "query-token",
    requestArgs: {
      path: "/items",
      query: { limit: 2 },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/items?limit=2&api_key=query-token");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, undefined);
  assert.deepEqual((result.structuredContent as any).body, [{ id: "one" }, { id: "two" }]);
  assert.equal((result.structuredContent as any).provider, "query_auth");
  assert.equal((result.structuredContent as any).status, 200);
});
