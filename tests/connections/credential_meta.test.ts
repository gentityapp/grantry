import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { credentialMetadataForStorage } from "../../src/connectors/credential_meta.js";
import { getProvider } from "../../src/connectors/registry.js";

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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("GitHub PAT metadata records subject, scopes, and generic smoke-test capability", async () => {
  const calls = installFetchMock(({ url }) => {
    assert.equal(url, "https://api.github.com/user");
    return jsonResponse(
      { login: "octocat", id: 1, type: "User" },
      {
        status: 200,
        headers: {
          "x-oauth-scopes": "repo, read:user",
          "github-authentication-token-expiration": "2026-12-31 00:00:00 UTC",
        },
      },
    );
  });

  const result = await credentialMetadataForStorage("github", "pat", "ghp_test");
  const metadata = JSON.parse(result.credentialMetadata);

  assert.equal(metadata.provider, "github");
  assert.equal(metadata.authType, "pat");
  assert.equal(metadata.status, "ok");
  assert.deepEqual(metadata.scopes, ["repo", "read:user"]);
  assert.deepEqual(metadata.subject, { login: "octocat", id: 1, type: "User" });
  assert.equal(metadata.capabilities.status, "ok");
  assert.equal(metadata.capabilities.smokeTests[0].id, "viewer");
  assert.equal(metadata.capabilities.operations.length, 0);
  assert.ok(result.credentialValidatedAt instanceof Date);
  assert.equal(calls.length, 2);
});

test("Google OAuth tokeninfo failure is captured without a real provider token", async () => {
  installFetchMock(({ url }) => {
    assert.equal(url, "https://oauth2.googleapis.com/tokeninfo?access_token=expired-token");
    return jsonResponse({ error: "invalid_token", error_description: "Invalid Value" }, { status: 400 });
  });

  const result = await credentialMetadataForStorage("google_drive", "oauth", "expired-token");
  const metadata = JSON.parse(result.credentialMetadata);

  assert.equal(metadata.provider, "google_drive");
  assert.equal(metadata.authType, "oauth");
  assert.equal(metadata.status, "error");
  assert.match(metadata.error, /Google tokeninfo failed: 400/);
});

test("HubSpot manifest keeps content optional for OAuth and reports missing capability scopes", async () => {
  const hubspot = getProvider("hubspot");
  assert.ok(hubspot);
  assert.ok(hubspot.oauthOptionalScopes?.includes("content"));
  assert.ok(!hubspot.oauthScopes?.includes("content"));

  installFetchMock(({ url }) => {
    if (url === "https://api.hubapi.com/oauth/v1/access-tokens/pat-test") {
      return jsonResponse({ hub_id: 12345, user: "ops@example.com", scopes: ["oauth", "crm.objects.deals.read"] });
    }
    if (url === "https://api.hubapi.com/account-info/v3/details") {
      return jsonResponse({ portalId: 12345 });
    }
    if (url.startsWith("https://api.hubapi.com/crm/v3/objects/deals")) {
      return jsonResponse({ results: [] });
    }
    if (url.startsWith("https://api.hubapi.com/crm/v3/objects/contacts")) {
      return jsonResponse({ results: [] });
    }
    if (url.startsWith("https://api.hubapi.com/marketing/v3/emails")) {
      return jsonResponse(
        { message: "This request is missing the content scope" },
        { status: 403 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const result = await credentialMetadataForStorage("hubspot", "pat", "pat-test");
  const metadata = JSON.parse(result.credentialMetadata);

  assert.equal(metadata.provider, "hubspot");
  assert.equal(metadata.status, "ok");
  assert.equal(metadata.capabilities.status, "error");
  assert.ok(metadata.capabilities.missingScopes.includes("content"));
  assert.ok(metadata.capabilities.operations.some((op: any) => op.id === "marketing_emails"));
  assert.ok(metadata.capabilities.smokeTests.some((smoke: any) => smoke.id === "operation:marketing_emails" && smoke.status === "error"));
});
