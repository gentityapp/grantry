import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QUICKSTART_AGENT_RE,
  QUICKSTART_SCOPE_RE,
  quickstartDefaults,
  quickstartSuccessTarget,
  quickstartValidate,
} from "../../src/ui.js";

test("quickstartDefaults fills the scope key and agent name defaults per provider key", () => {
  assert.deepEqual(quickstartDefaults("notion"), { scope: "notion", agentName: "notion-agent" });
  assert.deepEqual(quickstartDefaults("google_maps"), { scope: "google_maps", agentName: "google_maps-agent" });
});

test("quickstartDefaults sanitizes provider keys that are not valid scope keys", () => {
  assert.deepEqual(quickstartDefaults("My Provider!"), { scope: "myprovider", agentName: "myprovider-agent" });
  assert.deepEqual(quickstartDefaults("  "), { scope: "first-scope", agentName: "first-scope-agent" });
});

test("default values from quickstartDefaults pass the scope and agent patterns the POST enforces", () => {
  for (const provider of ["notion", "google_maps", "x", "agentmail", "langsmith"]) {
    const d = quickstartDefaults(provider);
    assert.match(d.scope, QUICKSTART_SCOPE_RE);
    assert.match(d.agentName, QUICKSTART_AGENT_RE);
  }
});

test("quickstartValidate accepts the one-credential create request when the defaults carry a pasted credential", () => {
  const d = quickstartDefaults("notion");
  assert.deepEqual(
    quickstartValidate({ provider: "notion", scope: d.scope, agent: d.agentName, credential: "pat-token" }),
    { ok: true }
  );
});

test("quickstartValidate rejects the create request missing provider, scope, agent, or credential", () => {
  const missingProvider = quickstartValidate({ provider: "", scope: "notion", agent: "notion-agent", credential: "k" });
  assert.equal(missingProvider.ok, false);
  if (!missingProvider.ok) assert.equal(missingProvider.error, "provider_required");

  const badScope = quickstartValidate({ provider: "notion", scope: "My Scope", agent: "notion-agent", credential: "k" });
  assert.equal(badScope.ok, false);
  if (!badScope.ok) assert.equal(badScope.error, "scope_invalid");

  const missingAgent = quickstartValidate({ provider: "notion", scope: "notion", agent: "", credential: "k" });
  assert.equal(missingAgent.ok, false);
  if (!missingAgent.ok) assert.equal(missingAgent.error, "agent_required");

  const badAgent = quickstartValidate({ provider: "notion", scope: "notion", agent: "notion agent", credential: "k" });
  assert.equal(badAgent.ok, false);
  if (!badAgent.ok) assert.equal(badAgent.error, "agent_invalid");

  // Without a credential the POST cannot create the connection, so it must
  // stop before any prisma write.
  const missingCredential = quickstartValidate({ provider: "notion", scope: "notion", agent: "notion-agent", credential: "" });
  assert.equal(missingCredential.ok, false);
  if (!missingCredential.ok) assert.equal(missingCredential.error, "credential_required");
});

test("after the one-shot create of scope, connection, agent, and grant, the response points at the agent smoke test", () => {
  // POST /quickstart creates the scope, then its connection, then the agent,
  // then grants the connection to that agent (AgentConnectionGrant rows) —
  // the success page links here so the next step is the MCP smoke test.
  assert.equal(quickstartSuccessTarget("agt_123"), "/agents/agt_123#smoke-test");
});
