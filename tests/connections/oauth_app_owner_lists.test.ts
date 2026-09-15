import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../../src/connectors/registry.ts";
// @ts-ignore plain ESM script module
import { PLATFORM_OAUTH_PROVIDERS, WORKSPACE_OAUTH_APP_PROVIDERS } from "../../scripts/oauth-app-owner-lists.mjs";

const workspaceOwned = Object.values(PROVIDERS).filter((p) => p.oauthAppOwner === "workspace").map((p) => p.key);

test("the boot script never disables a provider whose OAuth app is workspace-owned", () => {
  const wrong = PLATFORM_OAUTH_PROVIDERS.filter((k: string) => workspaceOwned.includes(k));
  assert.deepEqual(wrong, [], `these need a workspace OAuth app but the boot script disables it on every deploy: ${wrong.join(", ")}`);
});

test("every workspace-owned provider is on the restore list", () => {
  const missing = workspaceOwned.filter((k) => !WORKSPACE_OAUTH_APP_PROVIDERS.includes(k));
  assert.deepEqual(missing, []);
});
