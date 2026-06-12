// Simple symmetric encryption for storing credentials at rest.
// Uses Node's built-in crypto (AES-256-GCM). Key from FERNET_KEY env var.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  // FERNET_KEY is required: falling back to BETTER_AUTH_SECRET would make the
  // session-signing key double as the credential-encryption key, so rotating
  // one would silently break the other.
  const secret = process.env.FERNET_KEY ?? "";
  if (!secret) throw new Error("FERNET_KEY must be set (credential encryption key, kept separate from BETTER_AUTH_SECRET)");
  // Derive a 32-byte key from the secret using scrypt
  return scryptSync(secret, "agent-oauth-salt", 32);
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv || tag || ciphertext)
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
