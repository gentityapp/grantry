import assert from "node:assert/strict";
import { test } from "node:test";

import { ADMIN_TOOLS, adminToolDescriptor, isAdminTool } from "../../src/admin_tools.js";
import { getProvider } from "../../src/connectors/registry.js";

test("grantry admin provider exposes every admin tool", () => {
  const provider = getProvider("grantry");
  assert.ok(provider);
  assert.deepEqual([...provider.tools].sort(), [...ADMIN_TOOLS].sort());
});

test("person-to-agent assignment admin tools are described", () => {
  for (const tool of ["grantry/assign_agent", "grantry/unassign_agent"] as const) {
    assert.equal(isAdminTool(tool), true);
    const descriptor = adminToolDescriptor(tool);
    assert.ok(descriptor.description.includes("workspace"));
    assert.equal(descriptor.required.includes("agent_id"), true);
    assert.ok(descriptor.properties.user_id);
    assert.ok(descriptor.properties.user_email);
  }
});
