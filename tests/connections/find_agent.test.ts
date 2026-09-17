import assert from "node:assert/strict";
import { test } from "node:test";

import { rankCapableAgentCandidates } from "../../src/find_agent_rank.js";
import type { CapableAgentMatch } from "../../src/policy.js";

function m(opts: {
  name: string;
  confidence: number;
  tool?: string;
  scope?: string;
  label?: string;
  charter?: string;
}): CapableAgentMatch {
  return {
    agentId: `ag-${opts.name}`,
    name: opts.name,
    charter: opts.charter ?? null,
    grants: [],
    scopes: [],
    provider: "github",
    tool: opts.tool ?? "github/git_push_repo",
    connection: {
      authType: "oauth",
      scope: opts.scope ?? "main",
      enabled: true,
      label: opts.label ?? "conn-1",
      validatedAt: null,
    },
    confidence: opts.confidence,
  };
}

test("同じ接続を指す候補は 1 つに束ねられ、最も強い代表だけが残る", () => {
  const dupStrong = m({ name: "dup-strong", confidence: 0.9, scope: "webapp", label: "deploy-key" });
  const dupWeak = m({ name: "dup-weak", confidence: 0.7, scope: "webapp", label: "deploy-key" });
  const other = m({ name: "other-conn", confidence: 0.8, scope: "infra", label: "ops-key" });
  const out = rankCapableAgentCandidates([dupStrong, dupWeak, other], "push the site live");
  assert.equal(out.length, 2, "duplicates must collapse onto one entry per connection");
  const names = out.map((c) => c.name);
  assert.ok(names.includes("dup-strong"), "the strongest representative per connection survives");
  assert.ok(!names.includes("dup-weak"), "weaker duplicates are dropped");
  assert.ok(names.includes("other-conn"), "a distinct connection is kept");
});

test("作業の説明が接続の対象を指すと、構造的な自信が低い候補でも首位に上がる", () => {
  const prod = m({ name: "prod-agent", confidence: 0.6, scope: "production", label: "conn-prod" });
  const staging = m({ name: "staging-agent", confidence: 0.95, scope: "staging", label: "conn-staging" });
  const out = rankCapableAgentCandidates([staging, prod], "deploy the production site");
  assert.equal(out[0].name, "prod-agent", "target overlap must outrank raw structural confidence");
  assert.ok(out[0].confidence > out[1].confidence);
});

test("構造的な自信が同じ候補でも、対象との重なりの有無で confidence が分かれ一定にならない", () => {
  const a = m({ name: "matching", confidence: 0.9, scope: "production", label: "conn-prod" });
  const b = m({ name: "nomatch", confidence: 0.9, scope: "staging", label: "conn-staging" });
  const out = rankCapableAgentCandidates([a, b], "deploy to production");
  const confidences = out.map((c) => c.confidence);
  assert.ok(new Set(confidences).size > 1, "confidence must vary, not saturate at one constant");
  for (const c of confidences) {
    assert.ok(c >= 0 && c <= 1, `confidence ${c} out of [0,1]`);
  }
  assert.ok(
    confidences[0] - confidences[confidences.length - 1] >= 0.1,
    "a real target match must open a visible gap over a no-match candidate",
  );
});
