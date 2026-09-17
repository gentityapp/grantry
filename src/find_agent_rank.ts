// Pure ranking layer behind grantry/find_agent (#263). Moved verbatim from
// src/mcp.ts so regression tests can pin the three data-dependent behaviors —
// duplicate candidates collapse into one connection, target overlap reorders,
// confidence varies instead of saturating — without a DB.
import type { CapableAgentMatch } from "./policy.js";

export function rankCapableAgentCandidates(all: CapableAgentMatch[], task: string): CapableAgentMatch[] {
  // Tokens the task actually carries — used to score charter and, crucially,
  // the *target*: which connection's scope / label / project the task names.
  const taskWords = new Set(
    task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  );
  const overlap = (text: string | null, cap: number): number => {
    if (!text || !taskWords.size) return 0;
    const tw = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!tw.length) return 0;
    const hits = new Set(tw.filter((w) => taskWords.has(w))).size;
    return Math.min(cap, hits * 0.1);
  };
  // Dedupe by *connection*, not agent (issue #47): ~10 agents sharing the
  // same connection grants must not fill the result cap and hide the single
  // agent holding the connection that actually reaches the target. Key on (tool, scope, label);
  // keep the strongest representative agent per distinct connection.
  // The structural signal (credential freshness, explicit scope, single
  // connection) saturates at 0.95, so it crowns every duplicate equally. Give
  // it only half the range and let target/charter overlap fill the rest — that
  // headroom is what lets a real target match reorder candidates and produces
  // a confidence that varies instead of a constant.
  type Match = CapableAgentMatch & { targetScore: number; charterScore: number };
  const byConn = new Map<string, Match>();
  const rank = (x: Match) => 0.5 * x.confidence + x.targetScore + x.charterScore;
  for (const m of all) {
    const key = `${m.tool}::${m.connection.scope}::${m.connection.label}`;
    const enriched: Match = {
      ...m,
      // Scope/label/project overlap is the issue's core fix: a task naming
      // "production" / "agent-oauth" must rank the connection that reaches it.
      // Provider is deliberately excluded — every same-provider candidate
      // would match it equally, which discriminates nothing and would mask
      // the no-match penalty below.
      targetScore: overlap(`${m.connection.scope} ${m.connection.label}`, 0.3),
      charterScore: overlap(m.charter, 0.15),
    };
    const prev = byConn.get(key);
    if (!prev || rank(enriched) > rank(prev)) byConn.set(key, enriched);
  }
  // Target-aware confidence: a flat 0.95 overstates certainty on wrong
  // answers. When the task names a concrete target and some connection's
  // scope/label/project matches it, candidates that match *nothing* are the
  // likely-wrong ones — penalize them so the right connection rises.
  const matches = Array.from(byConn.values());
  const maxTarget = matches.reduce((mx, c) => Math.max(mx, c.targetScore), 0);
  return matches
    .map((m) => {
      let confidence = 0.5 * m.confidence + m.targetScore + m.charterScore;
      if (maxTarget > 0 && m.targetScore === 0) confidence -= 0.25;
      confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
      const { targetScore: _t, charterScore: _c, ...rest } = m;
      return { ...rest, confidence };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
}
