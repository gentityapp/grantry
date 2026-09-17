import { test } from "node:test";
import assert from "node:assert/strict";
import { formatKnowledgeHits, searchWorkspaceKnowledge, type KnowledgeRow } from "../../src/company_context.js";

function row(over: Partial<KnowledgeRow>): KnowledgeRow {
  return {
    workspaceId: "ws_a",
    kind: "repo_map",
    key: "k",
    title: "title",
    body: "",
    sourceUrl: null,
    ...over,
  };
}

test("company_context: rows of other workspaces are never visible (tenant isolation)", () => {
  const rows: KnowledgeRow[] = [
    row({ workspaceId: "ws_b", key: "b-billing", title: "請求書まわり 持ち場", body: "リポジトリ: agentic-group/billing\n担当: 請求 PO" }),
    row({ workspaceId: "ws_b", key: "b-secret", title: "超強力に一致する請求書の行", body: "請求書 請求書 請求書" }),
    row({ workspaceId: "ws_a", key: "a-canon", title: "請求書の社内ルール", body: "請求書は月末にまとめる" }),
  ];
  const hits = searchWorkspaceKnowledge({ workspaceId: "ws_a", rows, query: "請求書" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "a-canon");
  assert.ok(hits.every((h) => h.key !== "b-billing" && h.key !== "b-secret"));
  const none = searchWorkspaceKnowledge({ workspaceId: "ws_c", rows, query: "請求書" });
  assert.deepEqual(none, []);
  const emptyWs = searchWorkspaceKnowledge({ workspaceId: "", rows, query: "請求書" });
  assert.deepEqual(emptyWs, []);
});

test("company_context: Japanese partial match returns the repo_map row with matched body lines", () => {
  const rows: KnowledgeRow[] = [
    row({ key: "po-ledger", kind: "rule", title: "台帳の運用ルール", body: "台帳は毎周 1 行" }),
    row({
      key: "rank-loop-map",
      kind: "repo_map",
      title: "順位ループ 持ち場マップ",
      body: [
        "リポジトリ: agentic-group/rank-loop",
        "担当: 順位ループの担当エージェント",
        "本番 URL: https://example.com",
      ].join("\n"),
      sourceUrl: "https://example.com/map",
    }),
  ];
  const hits = searchWorkspaceKnowledge({ workspaceId: "ws_a", rows, query: "順位ループの 持ち場を知りたい" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "repo_map");
  assert.equal(hits[0].title, "順位ループ 持ち場マップ");
  assert.ok(hits[0].lines.some((l) => l.includes("担当: 順位ループ")));
  assert.equal(hits[0].sourceUrl, "https://example.com/map");
});

test("company_context: response is line-wise and never dumps the whole body", () => {
  const longBody = Array.from({ length: 12 }, (_, i) => `順位ループの行 ${i}`).join("\n");
  const rows: KnowledgeRow[] = [
    row({ key: "m1", title: "順位ループ 持ち場", body: longBody }),
    row({ key: "m2", title: "順位ループ 別の持ち場", body: `短い行\n${"あ".repeat(300)}順位ループ` }),
  ];
  const hits = searchWorkspaceKnowledge({ workspaceId: "ws_a", rows, query: "順位ループ" });
  const lines = formatKnowledgeHits(hits);
  // 2 hits × (1 header + ≤3 body lines) — the 12-line body is not dumped.
  assert.ok(lines.length <= 2 * (1 + 3), `expected ≤8 lines, got ${lines.length}`);
  for (const line of lines) {
    assert.ok(line.length <= 205, `line too long: ${line.length}`);
  }
  assert.ok(lines.some((l) => l.startsWith("- [repo_map] ")));
});

test("company_context: empty query or no match yields no rows", () => {
  const rows: KnowledgeRow[] = [row({ key: "a", title: "請求書", body: "請求書" })];
  assert.deepEqual(searchWorkspaceKnowledge({ workspaceId: "ws_a", rows, query: "" }), []);
  assert.deepEqual(searchWorkspaceKnowledge({ workspaceId: "ws_a", rows, query: "   " }), []);
  assert.deepEqual(searchWorkspaceKnowledge({ workspaceId: "ws_a", rows, query: "存在しない語" }), []);
});
