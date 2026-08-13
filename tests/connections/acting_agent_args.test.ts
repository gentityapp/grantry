import assert from "node:assert/strict";
import { test } from "node:test";

import { agentIdIsToolTarget, stripActingAgentSelector } from "../../src/acting_agent_args.js";

test("agent-token mode keeps agent_id for admin tools", () => {
  const args = stripActingAgentSelector(
    { scope: "agent", agent_id: "cmsrqw7kh07101431285ekp2k" },
    { userMode: false, toolName: "grantry/rotate_agent_token" },
  );
  assert.equal(args.agent_id, "cmsrqw7kh07101431285ekp2k");
  assert.equal(args.scope, "agent");
});

test("agent-token mode keeps agent_id for non-admin provider tools too", () => {
  const args = stripActingAgentSelector(
    { agent_id: "agt_1", agentId: "agt_1" },
    { userMode: false, toolName: "slack/post_message" },
  );
  assert.equal(args.agent_id, "agt_1");
  assert.equal(args.agentId, "agt_1");
});

test("user mode strips agent_id only when it was the acting-agent selector", () => {
  const provider = stripActingAgentSelector(
    { agent_id: "agt_1", agentId: "agt_1", channel: "#general" },
    { userMode: true, toolName: "slack/post_message" },
  );
  assert.equal("agent_id" in provider, false);
  assert.equal("agentId" in provider, false);
  assert.equal(provider.channel, "#general");

  const admin = stripActingAgentSelector(
    { agent_id: "agt_1", runbook: "..." },
    { userMode: true, toolName: "grantry/set_runbook" },
  );
  assert.equal(admin.agent_id, "agt_1");
});

test("acting_agent_id is always stripped", () => {
  for (const userMode of [true, false]) {
    for (const toolName of ["grantry/set_runbook", "slack/post_message"]) {
      const args = stripActingAgentSelector(
        { acting_agent_id: "agt_actor", actingAgentId: "agt_actor", agent_id: "agt_target" },
        { userMode, toolName },
      );
      assert.equal("acting_agent_id" in args, false);
      assert.equal("actingAgentId" in args, false);
    }
  }
});

test("agent_id is the tool target for delegate and admin tools, not for provider tools", () => {
  assert.equal(agentIdIsToolTarget("grantry/delegate"), true);
  assert.equal(agentIdIsToolTarget("grantry/grant_scope"), true);
  assert.equal(agentIdIsToolTarget("grantry/update_agent"), true);
  assert.equal(agentIdIsToolTarget("slack/post_message"), false);
});

test("stripActingAgentSelector does not mutate its input", () => {
  const original: Record<string, unknown> = { agent_id: "agt_1", acting_agent_id: "agt_actor" };
  stripActingAgentSelector(original, { userMode: true, toolName: "slack/post_message" });
  assert.deepEqual(original, { agent_id: "agt_1", acting_agent_id: "agt_actor" });
});
