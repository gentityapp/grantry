// Request logs are metadata, never a secondary store for credentials or bodies.
const PRIVATE_KEYS = /(?:token|secret|password|passwd|credential|authorization|cookie|privatekey|apikey|accesskey|clientkey)/i;
const PRIVATE_CONTAINERS = new Set([
  "files", "content", "body", "text", "html", "headers", "query", "data", "payload", "variables", "config", "url", "uri", "key",
]);
const TOKEN = /(?:Bearer\s+\S+|(?:gh[pousr]_|github_pat_|ntn_|secret_|re_|gn_(?:agt|adm|grant)_|sk-|ya29\.)[A-Za-z0-9_./+\-=]+)/g;

export function auditErrorSummary(message: string): string {
  // Provider error bodies can echo credentials. Persist only classification.
  const code = message.match(/\b(provider_(?:auth_invalid|permission_missing|rate_limited|not_found|error)|invalid_grant|invalid_client)\b/)?.[1];
  const status = message.match(/\b([45][0-9]{2})\b/)?.[1];
  return [code ?? "provider_call_failed", status ? `HTTP ${status}` : ""].filter(Boolean).join(" ");
}

export function maskAuditArgs(args: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  function mask(value: unknown, depth: number): unknown {
    if (depth > 12) return "<redacted depth limit>";
    if (typeof value === "string") return value.replace(TOKEN, "<redacted token>").slice(0, 300);
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "<redacted repeated value>";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => mask(item, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => {
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      return [key, PRIVATE_KEYS.test(normalized) || PRIVATE_CONTAINERS.has(normalized)
        ? "<redacted>" : mask(item, depth + 1)];
    }));
  }
  return JSON.stringify(mask(args ?? {}, 0)).slice(0, 4000);
}
