// Google Workspace Domain-Wide Delegation (DWD) token minting.
//
// For providers that act on a Workspace domain's user data (google_admin, gmail,
// google_drive, google_calendar, google_sheets) we authenticate with a Google
// service account JSON key and impersonate a domain admin ("subject") rather than
// running a per-user OAuth flow. The customer's Workspace admin authorizes our
// service account's client_id + scopes once in their Admin console
// (Security → API controls → Domain-wide delegation). No Google verification /
// CASA review, no 7-day refresh-token expiry.
//
// Flow: build an RS256-signed JWT assertion (iss=client_email, sub=subject,
// scope=<DWD scopes>, aud=token_uri) and exchange it at the OAuth token endpoint
// using the jwt-bearer grant. Minted access tokens are cached in-process per
// connection until shortly before expiry (mirrors the OAuth-refresh behaviour in
// mcp.ts; nothing is written to the DB).
import { createSign } from "node:crypto";

const TOKEN_URI_DEFAULT = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_TTL_SEC = 3600;
const MINT_TIMEOUT_MS = 8_000;
// Re-mint this long before the token actually expires, so an in-flight call never
// races the expiry. Matches TOKEN_REFRESH_SKEW_MS in mcp.ts.
const CACHE_SKEW_MS = 60_000;

/** Shape of the relevant fields in a Google service account JSON key. */
export type ServiceAccountKey = {
  type?: string;
  client_email?: string;
  client_id?: string;
  private_key?: string;
  token_uri?: string;
  project_id?: string;
};

/** Decoded form of the stored service_account credential blob. */
export type ServiceAccountCredential = {
  sa_key: ServiceAccountKey;
  subject: string;
};

/**
 * Parse and validate the JSON a user pasted into the service-account field.
 * Accepts either a bare SA key (and a separately supplied subject) or a
 * pre-wrapped { sa_key, subject } blob. Throws on anything unusable so the UI
 * can surface a clear error before storing it.
 */
export function parseServiceAccountInput(rawKey: string, subject: string): ServiceAccountCredential {
  let parsed: any;
  try {
    parsed = JSON.parse(rawKey);
  } catch {
    throw new Error("Service account key must be valid JSON (paste the full JSON key file)");
  }
  const key: ServiceAccountKey = parsed?.sa_key && typeof parsed.sa_key === "object" ? parsed.sa_key : parsed;
  const subj = String(subject || parsed?.subject || "").trim();
  if (!key || typeof key !== "object") throw new Error("Service account key JSON is empty or malformed");
  if (key.type && key.type !== "service_account") {
    throw new Error(`Expected a service_account key, got type="${key.type}"`);
  }
  if (!key.client_email) throw new Error("Service account key is missing client_email");
  if (!key.client_id) throw new Error("Service account key is missing client_id (needed for Admin console delegation)");
  if (!key.private_key) throw new Error("Service account key is missing private_key");
  if (!subj) throw new Error("An admin email to impersonate (subject) is required");
  return { sa_key: key, subject: subj };
}

/** Non-secret metadata describing a stored SA credential (for UI / audit). Never includes the private key. */
export function serviceAccountPublicMeta(cred: ServiceAccountCredential, scopes: string[]) {
  return {
    client_id: cred.sa_key.client_id ?? null,
    client_email: cred.sa_key.client_email ?? null,
    project_id: cred.sa_key.project_id ?? null,
    subject: cred.subject,
    scopes,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Build and RS256-sign the JWT assertion. nowSec is injectable for testing.
function signAssertion(cred: ServiceAccountCredential, scopes: string[], nowSec: number): string {
  const tokenUri = cred.sa_key.token_uri || TOKEN_URI_DEFAULT;
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: cred.sa_key.client_email,
    sub: cred.subject,
    scope: scopes.join(" "),
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + ASSERTION_TTL_SEC,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(cred.sa_key.private_key as string);
  return `${signingInput}.${base64url(signature)}`;
}

type CacheEntry = { token: string; expiresAtMs: number };
// connectionId -> minted token. Process-local; lost on restart (then re-minted).
const tokenCache = new Map<string, CacheEntry>();

/**
 * Mint (or return cached) a DWD access token for a connection.
 * @param connectionId stable cache key
 * @param cred decoded service-account credential
 * @param scopes the Google API scopes to request (the customer must have
 *   authorized these exact scopes for the SA client_id in their Admin console)
 */
export async function mintDwdAccessToken(
  connectionId: string,
  cred: ServiceAccountCredential,
  scopes: string[],
): Promise<string> {
  if (!scopes.length) throw new Error("no DWD scopes configured for this provider");

  const cached = tokenCache.get(connectionId);
  if (cached && cached.expiresAtMs > Date.now() + CACHE_SKEW_MS) return cached.token;

  const nowSec = Math.floor(Date.now() / 1000);
  const assertion = signAssertion(cred, scopes, nowSec);
  const tokenUri = cred.sa_key.token_uri || TOKEN_URI_DEFAULT;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
  try {
    const resp = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!resp.ok || json.error || !json.access_token) {
      // Surface Google's error verbatim — for DWD the usual cause is
      // "unauthorized_client" (admin hasn't registered the client_id+scopes) or
      // an invalid subject. Keep it actionable.
      const detail = json.error_description || json.error || JSON.stringify(json).slice(0, 400);
      throw new Error(
        `Google DWD token mint failed (${resp.status}): ${detail}. ` +
        `Confirm the admin registered client_id=${cred.sa_key.client_id} with these scopes in ` +
        `Admin console → Security → API controls → Domain-wide delegation, and that subject=${cred.subject} is a valid admin.`,
      );
    }
    const expiresInSec = Number(json.expires_in) || ASSERTION_TTL_SEC;
    const entry: CacheEntry = { token: json.access_token, expiresAtMs: Date.now() + expiresInSec * 1000 };
    tokenCache.set(connectionId, entry);
    return entry.token;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`Google DWD token mint timed out after ${MINT_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/** Drop any cached token for a connection (call when the credential is rotated/removed). */
export function invalidateDwdToken(connectionId: string): void {
  tokenCache.delete(connectionId);
}
