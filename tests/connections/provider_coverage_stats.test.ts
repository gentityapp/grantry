import assert from "node:assert/strict";
import test from "node:test";
import { providerCoverageStats, listProviders } from "../../src/connectors/registry.js";

test("provider coverage stats are derived from implemented runtime providers", () => {
  const providers = listProviders();
  const expectedToolNames = new Set(providers.flatMap((provider) => provider.tools));

  assert.deepEqual(providerCoverageStats(), {
    implementedProviderCount: providers.length,
    runtimeMcpToolNameCount: expectedToolNames.size,
  });
});
