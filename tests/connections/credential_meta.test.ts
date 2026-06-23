import assert from "node:assert/strict";
import { test } from "node:test";

import { credentialMetadataForStorage, deriveCredentialHealth } from "../../src/connectors/credential_meta.js";
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

function patProviderKeys() {
  return listProviders()
    .filter((provider) => provider.authTypes.includes("pat"))
    .map((provider) => provider.key)
    .sort();
}

function patTokenForProvider(providerKey: string) {
  const jsonTokens: Record<string, string> = {
    aws: JSON.stringify({ accessKeyId: "AKIATEST", secretAccessKey: "secret", region: "us-east-1" }),
    customerio: JSON.stringify({ token: "cio-test-token", region: "us" }),
    godaddy: "godaddy-key:godaddy-secret",
    jira: JSON.stringify({ site: "https://acme.atlassian.net", email: "ops@example.com", token: "jira-test-token" }),
    microsoft_ads: JSON.stringify({ developer_token: "dev-token", access_token: "msads-token", customer_id: "customer", account_id: "account" }),
    railway: JSON.stringify({ token: "railway-test-token", token_type: "project" }),
    railway_api: "railway-api-test-token",
    salesforce: JSON.stringify({ instance_url: "https://acme.my.salesforce.com", token: "sf-test-token" }),
    shopify: JSON.stringify({ shop: "acme.myshopify.com", token: "shopify-test-token" }),
    snowflake: JSON.stringify({ account: "acme-test", token: "snowflake-test-token" }),
    wordpress: JSON.stringify({ site: "https://blog.example.com", username: "admin", app_password: "wp-test-token" }),
    zendesk: JSON.stringify({ subdomain: "acme", email: "ops@example.com", token: "zendesk-test-token" }),
  };
  if (jsonTokens[providerKey]) return jsonTokens[providerKey];
  if (providerKey === "mailchimp") return "mailchimp-test-us1";
  if (providerKey === "google_maps") return "google-maps-test-key";
  return "pat-test-token";
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
        "https://www.googleapis.com/auth/calendar.readonly",
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

function patSuccessResponse(call: FetchCall) {
  const { url } = call;
  if (url === "https://api.cloudflare.com/client/v4/user/tokens/verify") {
    return jsonResponse({ success: true, result: { id: "cf-token", status: "active" } });
  }
  if (url.startsWith("https://api.godaddy.com/v1/domains/available")) {
    return jsonResponse({ available: true, domain: "grantry-availability-check.com" });
  }
  if (url.startsWith("https://maps.googleapis.com/maps/api/geocode/json")) {
    return jsonResponse({ status: "OK", results: [] });
  }
  if (url === "https://graph.facebook.com/v21.0/me?fields=id,name,category") {
    return jsonResponse({ id: "page-id", name: "Page", category: "Business" });
  }
  if (url === "https://api.notion.com/v1/users/me") {
    return jsonResponse({ id: "notion-bot", type: "bot", name: "Grantry", bot: { workspace_name: "Root" } });
  }
  if (url === "https://api.hubapi.com/crm/v3/objects/contacts?limit=1") {
    return jsonResponse({ total: 1, results: [{ id: "contact-id" }] });
  }
  if (url === "https://app.attio.com/oauth/introspect") {
    return jsonResponse({ active: true, scope: "record:read-write object:read", workspace_id: "attio-ws", workspace_name: "Root" });
  }
  if (url === "https://api.attio.com/v2/objects") {
    return jsonResponse({ data: [] });
  }
  if (url === "https://api.heyreach.io/api/public/auth/CheckApiKey") {
    return jsonResponse({ workspaceId: "heyreach-ws" });
  }
  if (url === "https://api.apollo.io/api/v1/auth/health") {
    return jsonResponse({ account_id: "apollo-account", user_id: "apollo-user" });
  }
  if (url === "https://api.chatwork.com/v2/me") {
    return jsonResponse({ account_id: 1, name: "Ops", chatwork_id: "ops", organization_id: 2, organization_name: "Root" });
  }
  if (url === "https://backboard.railway.app/graphql/v2") {
    const body = JSON.parse(String(call.init?.body ?? "{}"));
    if (String(body.query ?? "").includes("projectToken")) {
      return jsonResponse({ data: { projectToken: { projectId: "project", environmentId: "env" } } });
    }
    return jsonResponse({ data: { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } } });
  }
  if (url === "https://discord.com/api/v10/users/@me") {
    return jsonResponse({ id: "bot-id", username: "grantry", global_name: "Grantry", bot: true });
  }
  if (url === "https://api.line.me/v2/bot/info") {
    return jsonResponse({ userId: "line-user", basicId: "@root", displayName: "Root", chatMode: "chat", markAsReadMode: "manual" });
  }
  if (url === "https://api.airtable.com/v0/meta/whoami") {
    return jsonResponse({ id: "airtable-user", scopes: ["data.records:read", "schema.bases:read"] });
  }
  if (url === "https://api.linear.app/graphql") {
    return jsonResponse({ data: { viewer: { id: "linear-user", name: "Ops", email: "ops@example.com" } } });
  }
  if (url === "https://api.sendgrid.com/v3/scopes") {
    return jsonResponse({ scopes: ["mail.send"] });
  }
  if (url === "https://api.vercel.com/v2/user") {
    return jsonResponse({ user: { uid: "vercel-user", username: "ops", email: "ops@example.com" } });
  }
  if (url === "https://api.stripe.com/v1/balance") {
    return jsonResponse({ object: "balance", available: [] });
  }
  if (url === "https://api.resend.com/domains") {
    return jsonResponse({ data: [] });
  }
  if (url === "https://api.webflow.com/v2/sites") {
    return jsonResponse({ sites: [{ id: "site-id", displayName: "Root" }] });
  }
  if (url === "https://api.intercom.io/me") {
    return jsonResponse({ type: "admin", email: "ops@example.com", name: "Ops", app: { name: "Root" } });
  }
  if (url === "https://api.customer.io/v1/campaigns") {
    return jsonResponse({ campaigns: [] });
  }
  if (url === "https://us1.api.mailchimp.com/3.0/") {
    return jsonResponse({ account_name: "Root", email: "ops@example.com" });
  }
  if (url === "https://acme.zendesk.com/api/v2/users/me.json") {
    return jsonResponse({ user: { name: "Ops", role: "admin" } });
  }
  if (url === "https://blog.example.com/wp-json/wp/v2/users/me?context=edit") {
    return jsonResponse({ id: 1, name: "Ops" });
  }
  if (url === "https://acme.myshopify.com/admin/api/2024-10/shop.json") {
    return jsonResponse({ shop: { name: "Root", domain: "acme.myshopify.com", plan_name: "basic" } });
  }
  if (url === "https://acme.atlassian.net/rest/api/3/myself") {
    return jsonResponse({ accountId: "jira-user", displayName: "Ops", emailAddress: "ops@example.com" });
  }
  if (url === "https://acme.my.salesforce.com/services/oauth2/userinfo") {
    return jsonResponse({ user_id: "sf-user", name: "Ops", email: "ops@example.com", organization_id: "sf-org" });
  }
  if (url === "https://api.linkedin.com/v2/userinfo") {
    return jsonResponse({ sub: "linkedin-user", name: "Ops", email: "ops@example.com" });
  }
  if (url === "https://business-api.tiktok.com/open_api/v1.3/user/info/") {
    return jsonResponse({ code: 0, message: "OK", data: { display_name: "Ops", email: "ops@example.com" } });
  }
  if (url === "https://sts.us-east-1.amazonaws.com/") {
    return new Response(
      "<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/Ops</Arn><UserId>AIDATEST</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>",
      { status: 200, headers: { "content-type": "application/xml" } },
    );
  }
  return oauthSuccessResponse(call);
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
      assert.ok(result.healthCheckedAt instanceof Date);
      assert.equal(result.healthMissingScopes, "[]");
      if (metadata.capabilities) {
        assert.notEqual(metadata.capabilities.status, "error");
      }
      if (!metadata.capabilities || metadata.capabilities.status === "ok") {
        assert.equal(result.healthStatus, "ok");
        assert.ok(result.healthLastOkAt instanceof Date);
        assert.equal(result.healthErrorCode, null);
        assert.equal(result.healthErrorMessage, null);
      } else {
        assert.equal(result.healthStatus, "unknown");
        assert.equal(result.healthErrorCode, "check_unavailable");
      }
    });
  }
});

test("all PAT providers can build successful credential metadata with mocked provider APIs", async (t) => {
  installFetchMock(patSuccessResponse);
  t.after(restoreFetch);

  for (const providerKey of patProviderKeys()) {
    await t.test(providerKey, async () => {
      const result = await credentialMetadataForStorage(providerKey, "pat", patTokenForProvider(providerKey));
      const metadata = JSON.parse(result.credentialMetadata);

      assert.equal(metadata.provider, providerKey);
      assert.equal(metadata.authType, "pat");
      assert.equal(metadata.status, "ok");
      assert.ok(metadata.checkedAt);
      assert.ok(result.credentialValidatedAt instanceof Date);
      assert.ok(result.healthCheckedAt instanceof Date);
      assert.equal(result.healthMissingScopes, "[]");
      if (metadata.capabilities) {
        assert.notEqual(metadata.capabilities.status, "error");
      }
      if (!metadata.capabilities || metadata.capabilities.status === "ok") {
        assert.equal(result.healthStatus, "ok");
        assert.ok(result.healthLastOkAt instanceof Date);
        assert.equal(result.healthErrorCode, null);
        assert.equal(result.healthErrorMessage, null);
      } else {
        assert.equal(result.healthStatus, "unknown");
        assert.equal(result.healthErrorCode, "check_unavailable");
      }
    });
  }
});

test("PAT providers with safe read probes report concrete capability status", async () => {
  const providers = ["attio", "chatwork", "heyreach", "resend", "stripe"];
  const calls = installFetchMock(patSuccessResponse);

  for (const providerKey of providers) {
    const provider = getProvider(providerKey);
    assert.ok(provider?.genericRequest?.smokeTests?.length, `${providerKey} is missing a read-only smoke test`);

    const result = await credentialMetadataForStorage(providerKey, "pat", patTokenForProvider(providerKey));
    const metadata = JSON.parse(result.credentialMetadata);
    assert.equal(metadata.capabilities?.status, "ok", `${providerKey} capability check should be concrete`);
  }

  const stripeBalanceCalls = calls.filter((call) => call.url === "https://api.stripe.com/v1/balance");
  assert.ok(stripeBalanceCalls.length >= 2);
  assert.ok(stripeBalanceCalls.every((call) => call.init?.headers && "Stripe-Version" in (call.init.headers as Record<string, string>)));
  restoreFetch();
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

test("Railway provider variants use distinct token headers", async (t) => {
  const calls = installFetchMock((call) => {
    assert.equal(call.url, "https://backboard.railway.app/graphql/v2");
    const body = JSON.parse(String(call.init?.body ?? "{}"));
    if (String(body.query ?? "").includes("projectToken")) {
      return jsonResponse({ data: { projectToken: { projectId: "project", environmentId: "env" } } });
    }
    return jsonResponse({ data: { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" } } } });
  });
  t.after(restoreFetch);

  const project = await credentialMetadataForStorage("railway", "pat", "project-token");
  const api = await credentialMetadataForStorage("railway_api", "pat", "api-token");

  assert.equal(JSON.parse(project.credentialMetadata).status, "ok");
  assert.equal(JSON.parse(api.credentialMetadata).status, "ok");
  assert.equal((calls[0].init?.headers as Record<string, string>)["Project-Access-Token"], "project-token");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, undefined);
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer api-token");
  assert.equal((calls[1].init?.headers as Record<string, string>)["Project-Access-Token"], undefined);
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
  assert.equal(result.healthStatus, "error");
  assert.equal(result.healthErrorCode, "invalid_token");
  assert.match(String(result.healthErrorMessage), /Google tokeninfo failed: 400/);
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
  assert.equal(result.healthStatus, "warn");
  assert.equal(result.healthErrorCode, "missing_scope");
  assert.deepEqual(JSON.parse(result.healthMissingScopes), ["content"]);
  restoreFetch();
});

test("credential health treats broken probes as unknown instead of credential errors", () => {
  const checkedAt = new Date("2026-06-22T01:00:00.000Z");
  const result = deriveCredentialHealth({
    credentialValidatedAt: checkedAt,
    credentialMetadata: {
      provider: "google_search_console",
      authType: "oauth",
      status: "ok",
      checkedAt: checkedAt.toISOString(),
      capabilities: {
        status: "error",
        checkedAt: checkedAt.toISOString(),
        smokeTests: [
          {
            id: "sites",
            status: "error",
            error: "provider_request_failed: google_gsc GET /sites returned 400 {\"error\":\"Invalid limit query param\"}",
          },
        ],
      },
    },
  });

  assert.equal(result.healthStatus, "unknown");
  assert.equal(result.healthErrorCode, "check_unavailable");
  assert.match(String(result.healthErrorMessage), /Invalid limit query param/);
  assert.equal(result.healthCheckedAt, checkedAt);
});
