// Build the MCP tools/call success result. Never truncate: clients that read
// only `content` (not `structuredContent`) must see the same full payload.
// Clients that read `structuredContent` (Claude Code) feed only that to the
// model, so the text copy does not add model tokens there.
export function providerToolResult(result: any, options: { compact?: boolean } = {}) {
  const structured = options.compact && result?.structuredContent !== undefined
    ? compactPayload(result.structuredContent)
    : result?.structuredContent;
  return {
    content: [{ type: "text", text: JSON.stringify(structured ?? result) }],
    structuredContent: structured,
    isError: false,
  };
}

// ---------- Lossless compact format (opt-in: ?format=compact) ----------
//
// Same information, fewer bytes (measured 2026-09-13 on real responses: Google
// Ads search -46%, Meta insights -37%, GitHub repo list -40%). Nothing is cut:
//   1. `null` values are omitted from objects (null and absent mean the same).
//   2. An array of 2+ plain objects becomes a table:
//        {"$cols": ["campaign.id", "metrics.costMicros"], "$rows": [["1", "0"], ...]}
//      Nested plain objects are flattened into dotted column names; a cell that
//      is null or missing in that row is null. Cells are compacted recursively.
// `expandPayload` restores the original (minus nulls) — tests prove the round trip.
// Arrays whose objects use a "." in a key, or objects that already use
// "$cols"/"$rows", are left as they are so the encoding stays unambiguous.

const COLS = "$cols";
const ROWS = "$rows";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasReservedOrDottedKey(o: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(o)) {
    if (k.includes(".") || k === COLS || k === ROWS) return true;
    if (isPlainObject(v) && Object.keys(v).length && hasReservedOrDottedKey(v)) return true;
  }
  return false;
}

function withoutNulls(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    out[k] = isPlainObject(v) ? withoutNulls(v) : v;
  }
  return out;
}

// Input must already be null-free, so an object that only held nulls stays `{}`.
function flatten(o: Record<string, unknown>, prefix: string, out: Map<string, unknown>) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + k;
    if (isPlainObject(v) && Object.keys(v).length) flatten(v, `${key}.`, out);
    else out.set(key, v);
  }
}

export function compactPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    const tableable = value.length >= 2
      && value.every((x) => isPlainObject(x) && !hasReservedOrDottedKey(x));
    if (!tableable) return value.map(compactPayload);
    const flatRows = value.map((x) => {
      const m = new Map<string, unknown>();
      flatten(withoutNulls(x as Record<string, unknown>), "", m);
      return m;
    });
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const row of flatRows) for (const k of row.keys()) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    // A column that is a prefix of another ("a" and "a.b") cannot be expanded unambiguously.
    if (cols.some((c) => cols.some((d) => d.startsWith(`${c}.`)))) return value.map(compactPayload);
    return { [COLS]: cols, [ROWS]: flatRows.map((row) => cols.map((c) => (row.has(c) ? compactPayload(row.get(c)) : null))) };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = compactPayload(v);
    }
    return out;
  }
  return value;
}

/** Inverse of compactPayload (used by tests and by clients that want plain JSON back). */
export function expandPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandPayload);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 2 && Array.isArray(value[COLS]) && Array.isArray(value[ROWS])) {
      const cols = value[COLS] as string[];
      return (value[ROWS] as unknown[][]).map((cells) => {
        const obj: Record<string, unknown> = {};
        cols.forEach((col, i) => {
          const cell = cells[i];
          if (cell === null || cell === undefined) return;
          const parts = col.split(".");
          let cur = obj;
          for (const part of parts.slice(0, -1)) {
            if (!isPlainObject(cur[part])) cur[part] = {};
            cur = cur[part] as Record<string, unknown>;
          }
          cur[parts[parts.length - 1]] = expandPayload(cell);
        });
        return obj;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandPayload(v);
    return out;
  }
  return value;
}

/** ?format=compact or header X-Grantry-Format: compact. */
export function compactResultsRequested(c: any): boolean {
  let q = "";
  try { q = String(c.req.query?.("format") ?? ""); } catch { q = ""; }
  return (q || String(c.req.header?.("x-grantry-format") ?? "")).trim().toLowerCase() === "compact";
}
