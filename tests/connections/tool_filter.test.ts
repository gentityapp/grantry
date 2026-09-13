import assert from "node:assert/strict";
import { test } from "node:test";

import { applyToolFilter, consolidateHelperTools, expandConsolidatedHelper, parseToolFilter, toolAllowedByFilter, toolFilterFromRequest } from "../../src/tool_filter.js";

// Shape of an authorized tools/list result: already limited to the agent's grants.
const AUTHORIZED = [
  "ping",
  "grantry_get_skill",
  "grantry_get_runbook",
  "google_ads_search",
  "google_ads_mutate",
  "google_ads_list_accessible_customers",
  "meta_ads_get_insights",
  "meta_ads_update_campaign",
  "openai_ads_request",
  "openai_ads_list_campaigns",
  "openai_request",
  "openai_generate_image",
  "github_get_file_contents",
  "github_create_repo",
  "notion_create_page",
].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));

const names = (tools: { name: string }[]) => tools.map((t) => t.name);

function fakeContext(query: Record<string, string[]>, headers: Record<string, string> = {}) {
  return {
    req: {
      queries: (key: string) => query[key],
      header: (key: string) => headers[key.toLowerCase()],
    },
  };
}

test("no filter keeps tools/list unchanged (backward compatible)", () => {
  assert.equal(parseToolFilter({ providers: [], tools: [undefined, ""] }), null);
  assert.equal(toolFilterFromRequest(fakeContext({})), null);
  assert.deepEqual(applyToolFilter(AUTHORIZED, null), AUTHORIZED);
});

test("providers= returns only that provider's tools plus ping", () => {
  const filter = toolFilterFromRequest(fakeContext({ providers: ["google_ads,meta_ads"] }));
  assert.deepEqual(names(applyToolFilter(AUTHORIZED, filter)), [
    "ping",
    "google_ads_search",
    "google_ads_mutate",
    "google_ads_list_accessible_customers",
    "meta_ads_get_insights",
    "meta_ads_update_campaign",
  ]);
});

test("provider prefix does not bleed into a longer provider key (openai vs openai_ads)", () => {
  const filter = parseToolFilter({ providers: ["openai_ads"] });
  assert.deepEqual(names(applyToolFilter(AUTHORIZED, filter)), ["ping", "openai_ads_request", "openai_ads_list_campaigns"]);
  const openaiOnly = parseToolFilter({ providers: ["openai"] });
  assert.deepEqual(names(applyToolFilter(AUTHORIZED, openaiOnly)), ["ping", "openai_request", "openai_generate_image"]);
});

test("tools= and providers= combine; public and canonical names both accepted", () => {
  const filter = toolFilterFromRequest(
    fakeContext(
      { providers: ["openai_ads"], tools: ["github_get_file_contents"] },
      { "x-grantry-tools": "google_ads/search, GRANTRY_GET_RUNBOOK" },
    ),
  );
  assert.deepEqual(names(applyToolFilter(AUTHORIZED, filter)), [
    "ping",
    "grantry_get_runbook",
    "google_ads_search",
    "openai_ads_request",
    "openai_ads_list_campaigns",
    "github_get_file_contents",
  ]);
});

test("naming a tool the agent is not granted never makes it appear", () => {
  const filter = parseToolFilter({ tools: ["slack_post_message", "google_ads_search"], providers: ["hubspot"] });
  assert.deepEqual(names(applyToolFilter(AUTHORIZED, filter)), ["ping", "google_ads_search"]);
});

test("tools/call gate matches the advertised subset", () => {
  const filter = parseToolFilter({ providers: ["meta_ads"], tools: ["github_get_file_contents"] });
  assert.equal(toolAllowedByFilter(filter, "meta_ads_get_insights"), true);
  assert.equal(toolAllowedByFilter(filter, "meta_ads/get_insights"), true);
  assert.equal(toolAllowedByFilter(filter, "github_get_file_contents"), true);
  assert.equal(toolAllowedByFilter(filter, "github_create_repo"), false);
  assert.equal(toolAllowedByFilter(filter, "google_ads_mutate"), false);
  assert.equal(toolAllowedByFilter(filter, "ping"), true);
  assert.equal(toolAllowedByFilter(null, "google_ads_mutate"), true);
});

test("per-provider helpers collapse into grantry_check_connection / grantry_list_capabilities", () => {
  const withHelpers = [
    ...AUTHORIZED,
    { name: "slack_check_connection", description: "", inputSchema: { type: "object", properties: { scope: { enum: ["cs"] } } } },
    { name: "openai_ads_check_connection", description: "", inputSchema: { type: "object", properties: { scope: { enum: ["seo-marketer"] } } } },
    { name: "openai_ads_list_capabilities", description: "", inputSchema: { type: "object", properties: { scope: { enum: ["seo-marketer"] } } } },
  ];
  const out = consolidateHelperTools(withHelpers);
  const outNames = names(out);
  assert.ok(!outNames.includes("slack_check_connection"));
  assert.ok(!outNames.includes("openai_ads_list_capabilities"));
  assert.ok(outNames.includes("openai_ads_request"), "request tools are kept");
  const check = out.find((t: any) => t.name === "grantry_check_connection");
  assert.deepEqual(check.inputSchema.properties.provider.enum, ["openai_ads", "slack"]);
  assert.deepEqual(check.inputSchema.properties.scope.enum, ["cs", "seo-marketer"]);
  const caps = out.find((t: any) => t.name === "grantry_list_capabilities");
  assert.deepEqual(caps.inputSchema.properties.provider.enum, ["openai_ads"]);
  // No helpers in -> no consolidated tool out.
  assert.equal(consolidateHelperTools(AUTHORIZED).length, AUTHORIZED.length);
});

test("consolidated helper calls expand to the provider tool", () => {
  assert.equal(expandConsolidatedHelper("grantry/check_connection", { provider: "Slack" }), "slack/check_connection");
  assert.equal(expandConsolidatedHelper("grantry/list_capabilities", { provider: "openai_ads" }), "openai_ads/list_capabilities");
  assert.equal(expandConsolidatedHelper("grantry/check_connection", {}), "grantry/check_connection");
  assert.equal(expandConsolidatedHelper("slack/post_message", { provider: "x" }), "slack/post_message");
});
