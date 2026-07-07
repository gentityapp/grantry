// Periodic connection-health sweep. The dashboard badge is a snapshot written
// at connect-time / manual Recheck / runtime failures (connection_health.ts);
// connections nobody calls would still go stale. This sweep re-validates every
// enabled connection whose last check is older than STALE_AFTER_MS, so a PAT
// that quietly expired shows "broken" within a day even if no agent touched it.
//
// Design notes:
// - Hourly tick + per-connection staleness filter instead of a fixed daily
//   time: restarts/redeploys are harmless (recently-checked connections are
//   skipped) and no scheduler state needs to be persisted.
// - Shared credentials (credentialId) are checked once; rotateSharedCredential
//   fans the result out to every sibling connection.
// - A result of "unknown" (no introspection path, or the check itself timed
//   out) is never written: it must not overwrite a stronger ok/error signal.
// - Sequential with a delay between checks — this is a background janitor, not
//   a load test against 60 provider APIs.
import { prisma } from "./db.js";
import { decrypt } from "./crypto.js";
import { recordRuntimeCallHealth } from "./connection_health.js";
import { deriveCredentialHealth } from "./connectors/credential_meta.js";
import { PROVIDERS, getProviderForWorkspace } from "./connectors/registry.js";
import { invalidateDwdToken, mintDwdAccessToken, type ServiceAccountCredential } from "./google_dwd.js";
import { rotateSharedCredential } from "./provider_credentials.js";
import { credentialForConnection } from "./mcp.js";
import { credentialMetadataForProviderDef } from "./ui.js";
import type { Connection } from "@prisma/client";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly tick
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // re-check each connection daily
const FIRST_SWEEP_DELAY_MS = 60 * 1000; // let the server settle after boot
const PER_CHECK_DELAY_MS = 1_500;
const MAX_CHECKS_PER_SWEEP = 200;

let sweepRunning = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastCheckedAt(conn: Connection): number {
  return Math.max(
    conn.healthCheckedAtSnapshot?.getTime() ?? 0,
    conn.credentialValidatedAt?.getTime() ?? 0,
  );
}

function safeJsonObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Validate one connection and return the credentialMetadata + health fields to
// persist, or null when the check produced no usable signal.
async function checkConnection(conn: Connection) {
  // Service account (DWD): validity means Google will still mint a token for
  // the stored key + subject — same probe as the dashboard Recheck button.
  if (conn.authType === "service_account") {
    let ok = false;
    let errorMsg = "";
    try {
      const cred = JSON.parse(decrypt(conn.encryptedCredential)) as ServiceAccountCredential;
      const scopes = PROVIDERS[conn.provider]?.dwdScopes ?? [];
      invalidateDwdToken(conn.id);
      await mintDwdAccessToken(conn.id, cred, scopes);
      ok = true;
    } catch (e: any) {
      errorMsg = String(e?.message ?? e);
    }
    const meta = safeJsonObject(conn.credentialMetadata);
    delete meta.error;
    const newMeta = JSON.stringify({ ...meta, status: ok ? "ok" : "error", ...(ok ? {} : { error: errorMsg.slice(0, 300) }) });
    const checkedAt = new Date();
    return {
      credentialMetadata: newMeta,
      credentialValidatedAt: checkedAt,
      ...deriveCredentialHealth({ credentialMetadata: newMeta, credentialValidatedAt: checkedAt }),
    };
  }

  // OAuth + PAT-like: resolve a live token first. For OAuth this refreshes an
  // expiring access token (and a refresh rejection = genuinely broken); for
  // PATs it just decrypts. Then run the same introspection used at connect-time.
  const token = await credentialForConnection(conn);
  const providerDef = await getProviderForWorkspace(conn.provider, conn.workspaceId);
  if (!providerDef) return null;
  return credentialMetadataForProviderDef(providerDef, conn.authType, token);
}

export async function runConnectionHealthSweep(): Promise<{ checked: number; updated: number; failed: number }> {
  if (sweepRunning) return { checked: 0, updated: 0, failed: 0 };
  sweepRunning = true;
  const stats = { checked: 0, updated: 0, failed: 0 };
  try {
    const connections = await prisma.connection.findMany({ where: { enabled: true } });
    const now = Date.now();
    const seenCredentials = new Set<string>();
    const due = connections
      .filter((conn) => now - lastCheckedAt(conn) >= STALE_AFTER_MS)
      .sort((a, b) => lastCheckedAt(a) - lastCheckedAt(b))
      .filter((conn) => {
        if (!conn.credentialId) return true;
        if (seenCredentials.has(conn.credentialId)) return false; // siblings updated via rotateSharedCredential
        seenCredentials.add(conn.credentialId);
        return true;
      })
      .slice(0, MAX_CHECKS_PER_SWEEP);
    if (!due.length) return stats;
    console.log(`[health-sweep] checking ${due.length} stale connection(s)`);

    for (const conn of due) {
      stats.checked += 1;
      try {
        const result = await checkConnection(conn);
        // "unknown" = the check couldn't tell anything (no introspection path,
        // transient timeout). Persisting it would clobber a stronger snapshot.
        if (result && result.healthStatus !== "unknown") {
          await rotateSharedCredential({ credentialId: conn.credentialId, connectionId: conn.id, data: result });
          stats.updated += 1;
          if (result.healthStatus !== "ok") {
            console.log(`[health-sweep] ${conn.provider} ${conn.label}: ${result.healthStatus} (${result.healthErrorCode ?? ""})`);
          }
        }
      } catch (e: any) {
        stats.failed += 1;
        const errMsg = String(e?.message ?? e);
        console.error(`[health-sweep] check failed for ${conn.provider} ${conn.label}: ${errMsg.slice(0, 300)}`);
        // A thrown check is usually credentialForConnection failing before the
        // provider is reached (dead refresh token, unauthorized_client). Run it
        // through the same classifier as runtime failures so a genuine auth
        // failure still lands in the snapshot instead of staying "active".
        await recordRuntimeCallHealth(conn, { ok: false, errorMessage: errMsg });
      }
      await sleep(PER_CHECK_DELAY_MS);
    }
    console.log(`[health-sweep] done: checked=${stats.checked} updated=${stats.updated} failed=${stats.failed}`);
    return stats;
  } finally {
    sweepRunning = false;
  }
}

export function startHealthSweepScheduler() {
  if (process.env.HEALTH_SWEEP_DISABLED === "1") {
    console.log("[health-sweep] disabled via HEALTH_SWEEP_DISABLED=1");
    return;
  }
  const tick = () => {
    runConnectionHealthSweep().catch((e) => console.error("[health-sweep] sweep crashed:", e));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref?.();
  setInterval(tick, SWEEP_INTERVAL_MS).unref?.();
}
