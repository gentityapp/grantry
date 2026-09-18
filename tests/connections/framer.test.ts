import assert from "node:assert/strict";
import { test } from "node:test";

import { callFramerTool, parseFramerCredential, type FramerClient } from "../../src/connectors/framer.js";
import { getProvider } from "../../src/connectors/registry.js";

const CREDENTIAL = JSON.stringify({ project: "https://framer.com/projects/Site--abc123", api_key: "framer-secret-key" });

function fakeClient(overrides: { activeBranch?: unknown } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let active: unknown = overrides.activeBranch ?? { id: "main" };
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const client: FramerClient = {
    async getProjectInfo() { record("getProjectInfo"); return { id: "abc123", name: "Site" }; },
    async disconnect() { record("disconnect"); },
    agent: {
      async getSystemPrompt() { record("getSystemPrompt"); return "COMMANDS"; },
      async getContext() { record("getContext"); return "FONTS"; },
      async getActiveBranch() { record("getActiveBranch"); return active; },
      async getBranches() { record("getBranches"); return [{ id: "main" }, { id: "b1" }]; },
      async createBranch(title?: string) { record("createBranch", title); active = { id: "b-new", title }; return active; },
      async switchBranch(branchId: string) { record("switchBranch", branchId); active = { id: branchId }; },
      async readProject(queries, options) { record("readProject", queries, options); return { results: [1] }; },
      async applyChanges(dsl, options) { record("applyChanges", dsl, options); return { status: "ok", errors: [] }; },
      async publish(input) { record("publish", input); return { status: "ok", input }; },
    },
  };
  return { client, calls, connect: async () => client };
}

test("framer credential accepts JSON and pipe formats and rejects partial input", () => {
  assert.deepEqual(parseFramerCredential(CREDENTIAL), { project: "https://framer.com/projects/Site--abc123", apiKey: "framer-secret-key" });
  assert.deepEqual(parseFramerCredential("https://framer.com/projects/Site--abc123|k-1"), { project: "https://framer.com/projects/Site--abc123", apiKey: "k-1" });
  assert.throws(() => parseFramerCredential("just-a-key"), /both the project and its API key/);
  assert.throws(() => parseFramerCredential(JSON.stringify({ api_key: "x" })), /both the project and its API key/);
  assert.throws(() => parseFramerCredential(""), /required/);
});

test("framer provider exposes no code execution or production publish tool", () => {
  const provider = getProvider("framer");
  assert.ok(provider);
  assert.deepEqual(provider.authTypes, ["pat"]);
  for (const tool of provider.tools) {
    assert.doesNotMatch(tool, /exec|eval|deploy|production/);
  }
  assert.ok(provider.tools.includes("framer/apply_changes"));
  assert.ok(provider.tools.includes("framer/publish_preview"));
});

test("framer/apply_changes passes dsl and page, and always disconnects", async () => {
  const { calls, connect } = fakeClient();
  const out = await callFramerTool("framer/apply_changes", { dsl: "add FrameNode {}", page_path: "/lp/a", branch_id: "b1" }, CREDENTIAL, connect);
  const apply = calls.find((c) => c.method === "applyChanges");
  assert.deepEqual(apply?.args, ["add FrameNode {}", { pagePath: "/lp/a" }]);
  assert.deepEqual(calls.find((c) => c.method === "switchBranch")?.args, ["b1"]);
  assert.equal(calls.at(-1)?.method, "disconnect");
  assert.deepEqual((out.structuredContent as any).result, { status: "ok", errors: [] });
});

test("framer/apply_changes requires dsl and still disconnects on error", async () => {
  const { calls, connect } = fakeClient();
  await assert.rejects(callFramerTool("framer/apply_changes", {}, CREDENTIAL, connect), /dsl is required/);
  assert.equal(calls.at(-1)?.method, "disconnect");
});

test("framer/publish_preview refuses the main branch and never deploys to production", async () => {
  const main = fakeClient({ activeBranch: { id: "main" } });
  await assert.rejects(callFramerTool("framer/publish_preview", { confirm: true }, CREDENTIAL, main.connect), /only publishes a branch preview/);
  assert.equal(main.calls.filter((c) => c.method === "publish").length, 0);

  const branch = fakeClient({ activeBranch: { id: "b1" } });
  const preview = await callFramerTool("framer/publish_preview", {}, CREDENTIAL, branch.connect);
  assert.equal((preview.structuredContent as any).confirmed, false);
  assert.deepEqual(branch.calls.filter((c) => c.method === "publish").map((c) => c.args[0]), [{ action: "preview" }]);

  const confirmed = fakeClient({ activeBranch: { id: "b1" } });
  await callFramerTool("framer/publish_preview", { confirm: true }, CREDENTIAL, confirmed.connect);
  const actions = confirmed.calls.filter((c) => c.method === "publish").map((c) => (c.args[0] as any).action);
  assert.deepEqual(actions, ["preview", "confirm_publish"]);
  assert.ok(!actions.includes("deploy_to_production"));
});

test("framer errors never echo the API key", async () => {
  const connect = async () => { throw new Error("handshake failed for token framer-secret-key"); };
  await assert.rejects(callFramerTool("framer/get_project_info", {}, CREDENTIAL, connect as any), (error: Error) => {
    assert.doesNotMatch(error.message, /framer-secret-key/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("framer/read_project validates queries and forwards the page", async () => {
  const { calls, connect } = fakeClient();
  await assert.rejects(callFramerTool("framer/read_project", { queries: [] }, CREDENTIAL, connect), /non-empty array/);
  await callFramerTool("framer/read_project", { queries: [{ type: "fonts" }], page_path: "/" }, CREDENTIAL, connect);
  assert.deepEqual(calls.find((c) => c.method === "readProject")?.args, [[{ type: "fonts" }], { pagePath: "/" }]);
});
