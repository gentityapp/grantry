// Issue #281: connection dormancy nudge. These tests cover the pure parts
// only — the target pick (enabled connection / silent window / not already
// nudged / one per workspace), the enable switch and silent-days parsing, the
// mail body in both locales (workspace name embedded and escaped, distinct
// from the #250 onboarding body), and the AuditLog record key used to prevent
// re-sends. The DB wrapper and the scheduler are deliberately not exercised
// here (no prisma calls in tests).
import assert from "node:assert/strict";
import { test } from "node:test";

import { connectionDormantNudgeEmail, onboardingNudgeEmail } from "../../src/email.js";
import {
  CONNECTION_DORMANT_NUDGE_TOOL,
  connectionDormantNudgeRecordKey,
  connectionDormancySilentDays,
  isConnectionDormancyNudgeEnabled,
  pickConnectionDormancyTargets,
} from "../../src/connection_dormancy_nudge.js";

const now = new Date("2026-09-17T00:00:00Z");
const day = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(now.getTime() - n * day);

const workspaces = [
  { id: "ws_dormant", ownerUserId: "user_1" },
  { id: "ws_no_connection", ownerUserId: "user_2" }, // zero enabled connections
  { id: "ws_active", ownerUserId: "user_3" }, // ok call inside the window
  { id: "ws_nudged", ownerUserId: "user_4" }, // already sent one
];

function pick(overrides: Partial<Parameters<typeof pickConnectionDormancyTargets>[0]> = {}) {
  return pickConnectionDormancyTargets({
    workspaces,
    enabledConnectionCounts: {
      ws_dormant: 2,
      ws_no_connection: 0,
      ws_active: 1,
      ws_nudged: 1,
    },
    lastOkCallAt: { ws_active: daysAgo(5) },
    nudgedWorkspaceIds: ["ws_nudged"],
    now,
    silentDays: 30,
    ...overrides,
  });
}

test("pickConnectionDormancyTargets picks workspaces with an enabled connection that stayed silent", () => {
  const targets = pick();
  assert.deepEqual(targets.map((t) => t.id), ["ws_dormant"]);
  assert.equal(targets[0].ownerUserId, "user_1");
});

test("one mail per workspace: a duplicate id in the input collapses to a single target", () => {
  const targets = pick({
    workspaces: [
      ...workspaces,
      { id: "ws_dormant", ownerUserId: "user_1" }, // same workspace twice
    ],
  });
  const ids = targets.map((t) => t.id);
  assert.equal(ids.length, new Set(ids).size, "no workspace appears twice");
  assert.equal(ids.filter((id) => id === "ws_dormant").length, 1);
});

test("boundary: last ok call exactly silentDays ago is dormant, one second inside the window is not; never-called is dormant", () => {
  const exact = pick({
    workspaces: [{ id: "ws_exact", ownerUserId: null }],
    enabledConnectionCounts: { ws_exact: 1 },
    lastOkCallAt: { ws_exact: daysAgo(30) },
  });
  assert.equal(exact.length, 1, "a workspace silent for exactly silentDays is eligible");

  const fresh = pick({
    workspaces: [{ id: "ws_fresh", ownerUserId: null }],
    enabledConnectionCounts: { ws_fresh: 1 },
    lastOkCallAt: { ws_fresh: new Date(now.getTime() - 30 * day + 1000) },
  });
  assert.equal(fresh.length, 0, "an ok call one second inside the window keeps it quiet");

  const never = pick({
    workspaces: [{ id: "ws_never", ownerUserId: null }],
    enabledConnectionCounts: { ws_never: 1 },
    lastOkCallAt: {},
  });
  assert.equal(never.length, 1, "created a connection but never got a successful call");
});

test("enable switch: only the literal true (any case) enables; silent days falls back on junk", () => {
  const savedEnabled = process.env.CONNECTION_DORMANT_NUDGE_ENABLED;
  const savedDays = process.env.CONNECTION_DORMANT_NUDGE_SILENT_DAYS;
  try {
    for (const value of [undefined, "", "false", "1", "yes"]) {
      if (value === undefined) delete process.env.CONNECTION_DORMANT_NUDGE_ENABLED;
      else process.env.CONNECTION_DORMANT_NUDGE_ENABLED = value;
      assert.equal(isConnectionDormancyNudgeEnabled(), false, `enabled must stay false for ${JSON.stringify(value)}`);
    }
    for (const value of ["true", "TRUE", " true "]) {
      process.env.CONNECTION_DORMANT_NUDGE_ENABLED = value;
      assert.equal(isConnectionDormancyNudgeEnabled(), true, `enabled must be true for ${JSON.stringify(value)}`);
    }

    delete process.env.CONNECTION_DORMANT_NUDGE_SILENT_DAYS;
    assert.equal(connectionDormancySilentDays(), 30, "default silent window is 30 days");
    for (const [value, want] of [["14", 14], ["0", 30], ["-3", 30], ["abc", 30]] as const) {
      process.env.CONNECTION_DORMANT_NUDGE_SILENT_DAYS = value;
      assert.equal(connectionDormancySilentDays(), want, `silent days for ${JSON.stringify(value)} must be ${want}`);
    }
  } finally {
    if (savedEnabled === undefined) delete process.env.CONNECTION_DORMANT_NUDGE_ENABLED;
    else process.env.CONNECTION_DORMANT_NUDGE_ENABLED = savedEnabled;
    if (savedDays === undefined) delete process.env.CONNECTION_DORMANT_NUDGE_SILENT_DAYS;
    else process.env.CONNECTION_DORMANT_NUDGE_SILENT_DAYS = savedDays;
  }
});

test("dormancy record key is the AuditLog tool + scope pair a resend check looks up", () => {
  const key = connectionDormantNudgeRecordKey("ws_dormant");
  assert.equal(key.tool, CONNECTION_DORMANT_NUDGE_TOOL);
  assert.equal(key.tool, "email/connection_dormant_nudge");
  // scope is the workspaceId itself and nothing else, so distinct-scope
  // lookups by this tool return workspace ids directly.
  assert.equal(key.scope, "ws_dormant");
});

test("mail body is distinct from the onboarding nudge, points at /agents, and escapes the workspace name", () => {
  const evil = "<script>alert(1)</script>";
  const en = connectionDormantNudgeEmail({ recipientName: null, workspaceName: evil, baseUrl: "https://app.grantry.ai", locale: "en" });
  const ja = connectionDormantNudgeEmail({ recipientName: null, workspaceName: evil, baseUrl: "https://app.grantry.ai", locale: "ja" });
  for (const body of [en, ja]) {
    assert.ok(body.text.includes(evil), "plain text part carries the workspace name verbatim");
    assert.equal(body.html.includes("<script>"), false, "html part must not carry an unescaped workspace name");
    assert.ok(body.html.includes("&lt;script&gt;"), "html part must carry the escaped workspace name");
    assert.ok(body.text.includes("https://app.grantry.ai/agents"), "links to the agents list, not the quickstart");
    assert.equal(body.text.includes("/quickstart"), false);
  }
  assert.ok(ja.subject !== en.subject && ja.subject.includes("呼び出し"), "ja subject is translated");
  assert.ok(ja.html.includes("接続テスト"), "ja html mentions the smoke test in plain words");

  // Distinct body from #250: different subject and no quickstart pitch.
  const onboard = onboardingNudgeEmail({ recipientName: null, workspaceName: "WS", baseUrl: "https://app.grantry.ai", locale: "en" });
  assert.notEqual(en.subject, onboard.subject);
  assert.equal(en.text.includes("quickstart"), false);
});
