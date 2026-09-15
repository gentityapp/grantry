import assert from "node:assert/strict";
import { test } from "node:test";

import { callDataForSeoTool, resetTargetingListCacheForTests } from "../../src/connectors/dataforseo.js";

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;
const CREDENTIAL = "login@example.com:api-password";
const DATAFORSEO_API = "https://api.dataforseo.com";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function envelope(result: unknown[]) {
  return jsonResponse({ status_code: 20000, cost: 0, tasks: [{ status_code: 20000, result }] });
}

function installFetchMock(routes: Array<{ match: (call: FetchCall) => boolean; respond: (call: FetchCall) => Response }>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const route = routes.find((r) => r.match(call));
    if (!route) throw new Error(`unexpected fetch: ${call.url}`);
    return route.respond(call);
  }) as typeof fetch;
  return calls;
}

function postBodies(calls: FetchCall[], fragment: string) {
  return calls
    .filter((c) => c.url.includes(fragment) && c.init?.method === "POST")
    .map((c) => JSON.parse(String(c.init?.body))[0]);
}

const KEYWORDS_DATA_LISTS = [
  { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/keywords_data/google_ads/locations`, respond: () => envelope([{ location_code: 2392, location_name: "Japan" }, { location_code: 2840, location_name: "United States" }]) },
  { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/keywords_data/google_ads/languages`, respond: () => envelope([{ language_code: "ja" }, { language_code: "en" }]) },
];

const SERP_LISTS = [
  { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/serp/google/locations`, respond: () => envelope([{ location_code: 2392, location_name: "Japan" }, { location_code: 2840, location_name: "United States" }]) },
  { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/serp/google/languages`, respond: () => envelope([{ language_code: "ja" }, { language_code: "en" }]) },
];

const LABS_LISTS = [
  {
    match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/dataforseo_labs/locations_and_languages`,
    respond: () => envelope([
      { location_code: 2392, location_name: "Japan", available_languages: [{ language_code: "ja" }, { language_code: "en" }] },
      { location_code: 2840, location_name: "United States", available_languages: [{ language_code: "en" }] },
    ]),
  },
];

const SEARCH_VOLUME_OK = { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/keywords_data/google_ads/search_volume/live`, respond: () => envelope([{ keyword: "x", search_volume: 10 }]) };
const RANKED_KEYWORDS_OK = { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/dataforseo_labs/google/ranked_keywords/live`, respond: () => envelope([{ target: "example.com", total_count: 0, items_count: 0, metrics: { organic: {} }, items: [] }]) };
const SERP_OK = { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/serp/google/organic/live/advanced`, respond: () => envelope([{ keyword: "x", items: [] }]) };

test("keyword_search_volume rejects a location_code outside DataForSEO's keywords_data list before calling the API", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([...KEYWORDS_DATA_LISTS, SEARCH_VOLUME_OK]);

  await assert.rejects(
    callDataForSeoTool("dataforseo/keyword_search_volume", { keywords: ["x"], location_code: 2870, language_code: "ja" }, CREDENTIAL),
    (e: any) => {
      assert.match(String(e.message), /location_code 2870 is not in DataForSEO's Google Ads \(Keywords Data\) locations list/);
      assert.match(String(e.message), /location_name/);
      // The audit check counts upstream 40501 rows by substring; our rejection is a
      // different failure and must stay out of that bucket.
      assert.equal(String(e.message).includes("40501"), false);
      return true;
    }
  );
  assert.deepEqual(calls.map((c) => c.url), [
    `${DATAFORSEO_API}/v3/keywords_data/google_ads/locations`,
    `${DATAFORSEO_API}/v3/keywords_data/google_ads/languages`,
  ]);
});

test("serp_google_organic rejects a location_code outside the SERP locations list", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([...SERP_LISTS, SERP_OK]);

  await assert.rejects(
    callDataForSeoTool("dataforseo/serp_google_organic", { keyword: "x", location_code: 2910, language_code: "ja" }, CREDENTIAL),
    (e: any) => {
      assert.match(String(e.message), /location_code 2910 is not in DataForSEO's Google SERP locations list/);
      assert.equal(String(e.message).includes("40501"), false);
      return true;
    }
  );
  assert.equal(calls.filter((c) => c.url.includes("/serp/google/organic/live/advanced")).length, 0);
});

test("keyword_search_volume sends listed codes and canonicalizes language_code casing", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([...KEYWORDS_DATA_LISTS, SEARCH_VOLUME_OK]);

  const result = await callDataForSeoTool("dataforseo/keyword_search_volume", { keywords: ["x"], location_code: 2392, language_code: "JA" }, CREDENTIAL);

  const [body] = postBodies(calls, "/search_volume/live");
  assert.equal(body.location_code, 2392);
  assert.equal(body.language_code, "ja");
  assert.equal((result.structuredContent as any).keywords_count, 1);
});

test("ranked_keywords omits the default language_code when the Labs location does not list Japanese", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([...LABS_LISTS, RANKED_KEYWORDS_OK]);

  await callDataForSeoTool("dataforseo/ranked_keywords", { target: "example.com", location_code: 2840 }, CREDENTIAL);
  await callDataForSeoTool("dataforseo/ranked_keywords", { target: "example.com", location_code: 2392 }, CREDENTIAL);

  const bodies = postBodies(calls, "/ranked_keywords/live");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].location_code, 2840);
  assert.equal(bodies[0].language_code, undefined);
  assert.equal(bodies[1].location_code, 2392);
  assert.equal(bodies[1].language_code, "ja");
});

test("ranked_keywords rejects a language_code not available for the Labs location", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([...LABS_LISTS, RANKED_KEYWORDS_OK]);

  await assert.rejects(
    callDataForSeoTool("dataforseo/ranked_keywords", { target: "example.com", location_code: 2840, language_code: "ja" }, CREDENTIAL),
    (e: any) => {
      assert.match(String(e.message), /language_code "ja" is not available for location_code 2840 in DataForSEO Labs/);
      assert.match(String(e.message), /available: en/);
      assert.equal(String(e.message).includes("40501"), false);
      return true;
    }
  );
  assert.equal(calls.filter((c) => c.url.includes("/ranked_keywords/live")).length, 0);
});

test("targeting validation fails open when the lists cannot be fetched", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([
    { match: (c: FetchCall) => c.url.includes("google_ads/locations") || c.url.includes("google_ads/languages"), respond: () => jsonResponse({ status_code: 50000 }, { status: 500 }) },
    SEARCH_VOLUME_OK,
  ]);

  const result = await callDataForSeoTool("dataforseo/keyword_search_volume", { keywords: ["x"], location_code: 2870 }, CREDENTIAL);

  const [body] = postBodies(calls, "/search_volume/live");
  assert.equal(body.location_code, 2870);
  assert.equal((result.structuredContent as any).keywords_count, 1);
});

test("keyword_search_volume keeps the Japan/Japanese default and skips the list fetch when no targeting is given", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([...KEYWORDS_DATA_LISTS, SEARCH_VOLUME_OK]);

  await callDataForSeoTool("dataforseo/keyword_search_volume", { keywords: ["x"] }, CREDENTIAL);

  const [body] = postBodies(calls, "/search_volume/live");
  assert.equal(body.location_code, 2392);
  assert.equal(body.language_code, "ja");
  assert.deepEqual(calls.filter((c) => c.url.includes("/locations") || c.url.includes("/languages")).map((c) => c.url), []);
});

test("on_page_instant enables JavaScript rendering for browser presets", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetTargetingListCacheForTests();
  const calls = installFetchMock([
    { match: (c: FetchCall) => c.url === `${DATAFORSEO_API}/v3/on_page/instant_pages`, respond: () => envelope([{ url: "https://example.com", status_code: 200, checks: {}, meta: {} }]) },
  ]);

  await callDataForSeoTool("dataforseo/on_page_instant", { url: "https://example.com", browser_preset: "desktop" }, CREDENTIAL);

  const [body] = postBodies(calls, "/on_page/instant_pages");
  assert.equal(body.browser_preset, "desktop");
  assert.equal(body.enable_javascript, true);
});
