// Built-in tool grantry_company_context (#252): turn a plain-language work
// description ("作業の言葉") into the repo / owner / prod-URL rows a workspace
// admin publishes into WorkspaceKnowledge. Pure layer — the caller loads rows
// for ONE workspace and passes them in, so tests run without a DB.

export type KnowledgeRow = {
  workspaceId: string;
  kind: string; // "repo_map" | "rule"
  key: string;
  title: string;
  body: string;
  sourceUrl?: string | null;
};

export type KnowledgeHit = {
  kind: string;
  key: string;
  title: string;
  lines: string[]; // matched body lines — rows come back line-wise, never as one blob
  sourceUrl: string | null;
  score: number;
};

const DEFAULT_LIMIT = 8;
const MAX_LINES_PER_ROW = 3;
const MAX_LINE_CHARS = 200;

function normalize(s: string): string {
  return String(s ?? "").toLowerCase();
}

// Japanese has no reliable word boundaries, so each fragment of the query is
// used as a plain substring needle (title > key > body for ranking). Particles
// glued to the fragment ("順位ループの", "持ち場を知りたい") would otherwise
// never substring-match, so each fragment also tries its hiragana-stripped
// core ("順位ループ", "持ち場").
function splitTerms(query: string): string[][] {
  return String(query ?? "")
    .split(/[\s,、。．・\t]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const core = t.replace(/^[ぁ-ゖー]+/, "").replace(/[ぁ-ゖー]+$/, "");
      return core.length >= 2 && core !== t ? [t, core] : [t];
    });
}

function matchedBodyLines(row: KnowledgeRow, needles: string[]): string[] {
  const out: string[] = [];
  for (const raw of String(row.body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !needles.some((n) => normalize(line).includes(n))) continue;
    out.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line);
    if (out.length >= MAX_LINES_PER_ROW) break;
  }
  return out;
}

// Tenant isolation is load-bearing: rows belonging to any other workspace are
// dropped before matching, so their existence is never observable.
export function searchWorkspaceKnowledge(args: { workspaceId: string; rows: KnowledgeRow[]; query: string; limit?: number }): KnowledgeHit[] {
  const wsId = String(args.workspaceId ?? "");
  if (!wsId) return [];
  const terms = splitTerms(args.query);
  if (!terms.length) return [];
  const own = args.rows.filter((r) => r.workspaceId === wsId);
  const hits: KnowledgeHit[] = [];
  for (const row of own) {
    let score = 0;
    const lines: string[] = [];
    for (const needles of terms) {
      if (needles.some((n) => normalize(row.title).includes(n))) score += 4;
      if (needles.some((n) => normalize(row.key).includes(n))) score += 2;
      if (needles.some((n) => normalize(row.body).includes(n))) {
        score += 1;
        for (const line of matchedBodyLines(row, needles)) {
          if (!lines.includes(line)) lines.push(line);
          if (lines.length >= MAX_LINES_PER_ROW) break;
        }
      }
    }
    if (score > 0) hits.push({ kind: row.kind, key: row.key, title: row.title, lines, sourceUrl: row.sourceUrl ?? null, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, args.limit ?? DEFAULT_LIMIT);
}

export function formatKnowledgeHits(hits: KnowledgeHit[]): string[] {
  const out: string[] = [];
  for (const h of hits) {
    out.push(`- [${h.kind}] ${h.title} (${h.sourceUrl ?? "no source url"})`);
    for (const line of h.lines) out.push(`  ${line}`);
  }
  return out;
}
