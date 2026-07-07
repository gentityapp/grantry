// Runtime connection-health reflection. The dashboard's "active/broken" badge
// renders healthStatusSnapshot, which historically was written only at
// connect-time and on manual Recheck — a PAT that expired after that stayed
// "active" until a human clicked Check now. This module lets the MCP runtime
// (mcp.ts tools/call) push what it actually observed into the same snapshot:
// an auth failure marks the connection broken immediately, and a later
// successful call heals it back to ok. Best-effort: never throws, never blocks
// the tool-call response.
import { healthErrorCodeFromAuthFailure, parseProviderErrorCode } from "./connectors/credential_meta.js";
import { rotateSharedCredential } from "./provider_credentials.js";

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
