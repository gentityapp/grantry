// Runtime connection-health reflection. The dashboard's "active/broken" badge
// renders healthStatusSnapshot, which historically was written only at
// connect-time and on manual Recheck — a PAT that expired after that stayed
// "active" until a human clicked Check now. This module lets the MCP runtime
// (mcp.ts tools/call) push what it actually observed into the same snapshot:
// an auth failure marks the connection broken immediately, and a later
// successful call heals it back to ok. Best-effort: never throws, never blocks
// the tool-call response.
import { credentialMetadataForStorage, deriveCredentialHealth, healthErrorCodeFromAuthFailure, parseProviderErrorCode } from "./connectors/credential_meta.js";
import { callGenericCheckConnection, callGenericListCapabilities } from "./connectors/generic_request.js";
import { getProvider } from "./connectors/registry.js";
import { rotateSharedCredential } from "./provider_credentials.js";

// Validate a credential for any provider definition — built-in providers via
// their introspection path, workspace custom providers via the generic
// connection-check manifest. Returns the credentialMetadata + health fields to
// persist. (Moved from ui.ts so both the dashboard and the health sweep can
// use it without an import cycle.)
export async function credentialMetadataForProviderDef(providerDef: any, authType: string, token: string) {
  if (!providerDef?.genericRequest || getProvider(providerDef.key)) return credentialMetadataForStorage(providerDef.key, authType, token);
  const checkedAt = new Date().toISOString();
  const metadata: any = { provider: providerDef.key, authType, status: "unknown", notes: ["Custom provider credentials are validated through the configured connection check path when available."], checkedAt };
  try {
    const [check, capabilities] = await Promise.all([callGenericCheckConnection({ provider: providerDef, credential: token }), callGenericListCapabilities({ provider: providerDef })]);
    const checkContent: any = check.structuredContent ?? {};
    const capabilityContent: any = capabilities.structuredContent ?? {};
    const smokeTests = Array.isArray(checkContent.tests) ? checkContent.tests : [];
    const operations = Array.isArray(capabilityContent.operations) ? capabilityContent.operations : [];
    metadata.status = checkContent.status === "ok" ? "ok" : checkContent.status === "error" ? "error" : "unknown";
    metadata.capabilities = { status: metadata.status, message: typeof checkContent.message === "string" ? checkContent.message : undefined, smokeTests, operations, missingScopes: Array.from(new Set(smokeTests.flatMap((test: any) => Array.isArray(test.missingScopes) ? test.missingScopes.map(String) : []))), checkedAt };
  } catch (e: any) { metadata.status = "unknown"; metadata.capabilities = { status: "unknown", checkedAt, error: String(e?.message ?? e).slice(0, 500) }; }
  const credentialValidatedAt = new Date();
  return {
    credentialMetadata: JSON.stringify(metadata).slice(0, 16000),
    credentialValidatedAt,
    ...deriveCredentialHealth({ credentialMetadata: metadata, credentialValidatedAt }),
  };
}

export type RuntimeHealthConnection = {
  id: string;
  provider: string;
  credentialId: string | null;
  accessTokenExpiresAt: Date | null;
  healthStatusSnapshot: string | null;
};

// OAuth refresh failures (thrown by credentialForConnection before the provider
// is even reached) don't carry the provider_* code prefixes that
// parseProviderErrorCode looks for, so classify them separately. Only a token
// the provider rejected (invalid_grant & friends) counts — network flakiness
// must not mark a connection broken.
function refreshFailureIsAuthInvalid(message: string) {
  if (!/oauth refresh (failed|timed out)/i.test(message)) return false;
  return /invalid_grant|invalid_client|unauthorized|expired|\b40[013]\b/i.test(message);
}

export async function recordRuntimeCallHealth(
  conn: RuntimeHealthConnection,
  result: { ok: boolean; errorMessage?: string },
): Promise<void> {
  try {
    const now = new Date();
    if (result.ok) {
      // Heal: only write when the snapshot currently says broken/partial, so
      // the common all-good path costs zero extra DB writes per tool call.
      if (conn.healthStatusSnapshot !== "error" && conn.healthStatusSnapshot !== "warn") return;
      await rotateSharedCredential({
        credentialId: conn.credentialId,
        connectionId: conn.id,
        data: {
          healthStatus: "ok",
          healthCheckedAt: now,
          healthLastOkAt: now,
          healthErrorCode: null,
          healthErrorMessage: null,
        },
      });
      return;
    }

    const message = String(result.errorMessage ?? "");
    const code = parseProviderErrorCode(conn.provider, message);
    const authInvalid = code === "provider_auth_invalid" || refreshFailureIsAuthInvalid(message);
    const scopeMissing = code === "provider_scope_missing";
    // Anything else (bad arguments, rate limits, provider 5xx, timeouts) says
    // nothing about the credential — leave the snapshot alone.
    if (!authInvalid && !scopeMissing) return;
    await rotateSharedCredential({
      credentialId: conn.credentialId,
      connectionId: conn.id,
      data: {
        healthStatus: authInvalid ? "error" : "warn",
        healthCheckedAt: now,
        healthErrorCode: authInvalid
          ? healthErrorCodeFromAuthFailure(message, conn.accessTokenExpiresAt)
          : "missing_scope",
        healthErrorMessage: message.slice(0, 1000),
      },
    });
  } catch (e) {
    console.error("[connection-health] failed to record runtime health", {
      connectionId: conn.id,
      provider: conn.provider,
      error: String((e as any)?.message ?? e),
    });
  }
}
