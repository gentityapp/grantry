import assert from "node:assert/strict";
import { test } from "node:test";

import { credentialMetadataForStorage } from "../../src/connectors/credential_meta.js";
import { getProvider, listProviders } from "../../src/connectors/registry.js";

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

function oauthProviderKeys() {
  return listProviders()
    .filter((provider) => provider.authTypes.includes("oauth"))
    .map((provider) => provider.key)
    .sort();
}

function oauthSuccessResponse({ url }: FetchCall) {
  if (url === "https://api.github.com/user") {
    return jsonResponse(
      { login: "octocat", id: 1, type: "User" },
      { headers: { "x-oauth-scopes": "repo, read:user" } },
    );
  }
  if (url.startsWith("https://oauth2.googleapis.com/tokeninfo?access_token=")) {
    return jsonResponse({
      email: "ops@example.com",
      sub: "google-subject",
      aud: "google-client",
      scope: [
        "https://www.googleapis.com/auth/webmasters.readonly",
        "https://www.googleapis.com/auth/analytics.readonly",
        "https://www.googleapis.com/auth/adwords",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/tagmanager.readonly",
        "https://www.googleapis.com/auth/cloud-platform.read-only",
        "https://www.googleapis.com/auth/admin.directory.user.readonly",
        "https://www.googleapis.com/auth/bigquery",
        "https://www.googleapis.com/auth/userinfo.email",
      ].join(" "),
    });
  }
  if (url.startsWith("https://www.googleapis.com/webmasters/v3/sites")) {
    return jsonResponse({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteFullUser" }] });
  }
  if (url.startsWith("https://searchconsole.googleapis.com/sites")) {
    return jsonResponse({ siteEntry: [] });
  }
  if (url === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
    return jsonResponse({ accountSummaries: [] });
  }
  if (url.startsWith("https://www.googleapis.com/tagmanager/v2/accounts")) {
    return jsonResponse({ account: [] });
  }
  if (url.startsWith("https://cloudresourcemanager.googleapis.com/v1/projects")) {
    return jsonResponse({ projects: [] });
  }
  if (url.startsWith("https://cloudbilling.googleapis.com/v1/billingAccounts")) {
    return jsonResponse({ billingAccounts: [] });
  }
  if (url.startsWith("https://cloudbilling.googleapis.com/v1/services")) {
    return jsonResponse({ services: [] });
  }
  if (url === "https://graph.facebook.com/v21.0/me?fields=id,name") {
    return jsonResponse({ id: "meta-user", name: "Meta User" });
  }
  if (url === "https://api.zoom.us/v2/users/me") {
    return jsonResponse({ email: "ops@example.com", account_id: "zoom-account", type: 2 });
  }
  if (url === "https://api.hubapi.com/oauth/v1/access-tokens/oauth-test-token") {
    return jsonResponse({ user: "ops@example.com", hub_id: 12345, app_id: 67890, scopes: ["oauth", "content", "crm.objects.deals.read", "crm.objects.contacts.read"] });
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
    return jsonResponse({ results: [] });
  }
  if (url === "https://api.freee.co.jp/api/1/users/me?companies=true") {
    return jsonResponse({ user: { id: 1, email: "ops@example.com", display_name: "Ops", companies: [{ id: 10, name: "Root", role: "admin" }] } });
  }
  if (url === "https://api-accounting.moneyforward.com/api/v3/offices") {
    return jsonResponse({ code: "office-code", name: "Main Office", type: "corporate", accounting_periods: [] });
  }
  if (url === "https://slack.com/api/auth.test") {
    return jsonResponse(
      { ok: true, team: "Root", team_id: "T123", user: "bot", user_id: "U123", bot_id: "B123", url: "https://root.slack.com/" },
      { headers: { "x-oauth-scopes": "channels:read,chat:write" } },
    );
  }
  if (url === "https://oauth.reddit.com/api/v1/me") {
    return jsonResponse({ name: "reddit_user", id: "reddit-id", total_karma: 100 });
  }
  if (url === "https://api.x.com/2/users/me") {
    return jsonResponse({ data: { id: "x-id", username: "x_user", name: "X User" } });
  }
  throw new Error(`unexpected fetch ${url}`);
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("all OAuth providers have complete registry metadata", () => {
  const oauthProviders = listProviders().filter((provider) => provider.authTypes.includes("oauth"));
  assert.ok(oauthProviders.length > 0);

  for (const provider of oauthProviders) {
    assert.ok(provider.authorizeUrl, `${provider.key} is missing authorizeUrl`);
    assert.ok(provider.oauthTokenUrl, `${provider.key} is missing oauthTokenUrl`);
    assert.ok((provider.oauthScopes ?? []).length > 0, `${provider.key} is missing oauthScopes`);
    if (provider.genericRequest) {
      assert.ok(provider.tools.includes(`${provider.key}/check_connection`), `${provider.key} is missing check_connection`);
      assert.ok(provider.tools.includes(`${provider.key}/list_capabilities`), `${provider.key} is missing list_capabilities`);
    }
  }
});

test("all OAuth providers can build successful credential metadata with mocked provider APIs", async (t) => {
  installFetchMock(oauthSuccessResponse);
  t.after(restoreFetch);

  for (const providerKey of oauthProviderKeys()) {
    await t.test(providerKey, async () => {
      const result = await credentialMetadataForStorage(providerKey, "oauth", "oauth-test-token");
      const metadata = JSON.parse(result.credentialMetadata);

      assert.equal(metadata.provider, providerKey);
      assert.equal(metadata.authType, "oauth");
      assert.equal(metadata.status, "ok");
      assert.ok(metadata.checkedAt);
      assert.ok(result.credentialValidatedAt instanceof Date);
      if (metadata.capabilities) {
        assert.notEqual(metadata.capabilities.status, "error");
      }
    });
  }
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
  restoreFetch();
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
  restoreFetch();
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
  restoreFetch();
});
