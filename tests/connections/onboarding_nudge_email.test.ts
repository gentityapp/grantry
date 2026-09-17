// Issue #250: onboarding nudge mail. These tests cover the pure parts only —
// the target pick (age / zero scopes / not already nudged / one per
// workspace), the mail body in both locales (workspace name embedded and
// escaped), and the AuditLog record key used to prevent re-sends. The DB
// wrapper and the scheduler are deliberately not exercised here (no prisma
// calls in tests).
import assert from "node:assert/strict";
import { test } from "node:test";

import { onboardingNudgeEmail } from "../../src/email.js";
import {
  ONBOARDING_NUDGE_TOOL,
  onboardingNudgeRecordKey,
  pickOnboardingNudgeTargets,
} from "../../src/onboarding_nudge.js";

const now = new Date("2026-09-17T00:00:00Z");
const day = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(now.getTime() - n * day);

const workspaces = [
  { id: "ws_eligible", createdAt: daysAgo(10), ownerUserId: "user_1" },
  { id: "ws_fresh", createdAt: daysAgo(1), ownerUserId: "user_2" }, // younger than minAgeDays
  { id: "ws_started", createdAt: daysAgo(10), ownerUserId: "user_3" }, // has scopes
  { id: "ws_nudged", createdAt: daysAgo(10), ownerUserId: "user_4" }, // already sent one
];
const scopeCounts = { ws_started: 2 };
const nudged = ["ws_nudged"];

test("pickOnboardingNudgeTargets picks one target per eligible workspace, once ever", () => {
  const targets = pickOnboardingNudgeTargets({
    workspaces: [...workspaces, { id: "ws_eligible", createdAt: daysAgo(10), ownerUserId: "user_1" }],
    scopeCountsByWorkspace: scopeCounts,
    nudgedWorkspaceIds: nudged,
    now,
    minAgeDays: 3,
  });
  // The same workspace id twice in the input still yields a single entry:
  // one workspace, one mail.
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "ws_eligible");
  assert.equal(targets[0].ownerUserId, "user_1");
});

test("excludes workspaces younger than minAgeDays, with scopes, or already nudged", () => {
  const targets = pickOnboardingNudgeTargets({
    workspaces,
    scopeCountsByWorkspace: scopeCounts,
    nudgedWorkspaceIds: nudged,
    now,
    minAgeDays: 3,
  });
  assert.deepEqual(targets.map((t) => t.id), ["ws_eligible"]);
});

test("boundary: a workspace exactly minAgeDays old is eligible, one second younger is not", () => {
  const exact = pickOnboardingNudgeTargets({
    workspaces: [{ id: "ws_exact", createdAt: daysAgo(3), ownerUserId: null }],
    scopeCountsByWorkspace: {},
    nudgedWorkspaceIds: [],
    now,
    minAgeDays: 3,
  });
  assert.equal(exact.length, 1);

  const fresh = pickOnboardingNudgeTargets({
    workspaces: [{ id: "ws_fresh", createdAt: new Date(now.getTime() - 3 * day + 1000), ownerUserId: null }],
    scopeCountsByWorkspace: {},
    nudgedWorkspaceIds: [],
    now,
    minAgeDays: 3,
  });
  assert.equal(fresh.length, 0);
});

test("nudge record key is the AuditLog tool + scope pair a resend check looks up", () => {
  const key = onboardingNudgeRecordKey("ws_eligible");
  assert.equal(key.tool, ONBOARDING_NUDGE_TOOL);
  assert.equal(key.tool, "email/onboarding_nudge");
  // scope is the workspaceId itself and nothing else, so distinct-scope
  // lookups by this tool return workspace ids directly.
  assert.equal(key.scope, "ws_eligible");
});

test("embeds the workspace name in both locales and escapes it in the html part", () => {
  const evil = "<script>alert(1)</script>";
  const en = onboardingNudgeEmail({ recipientName: null, workspaceName: evil, baseUrl: "https://app.grantry.ai", locale: "en" });
  const ja = onboardingNudgeEmail({ recipientName: null, workspaceName: evil, baseUrl: "https://app.grantry.ai", locale: "ja" });
  for (const body of [en, ja]) {
    assert.ok(body.text.includes(evil), "plain text part carries the workspace name verbatim");
    assert.equal(body.html.includes("<script>"), false, "html part must not carry an unescaped workspace name");
    assert.ok(body.html.includes("&lt;script&gt;"), "html part must carry the escaped workspace name");
  }
  assert.ok(ja.subject.includes("スコープ"), "ja subject is translated");
  assert.ok(ja.html.includes("スコープ"), "ja html body is translated");
  assert.ok(en.subject.startsWith("Get started with grantry"), "en subject is the source string");
});

test("links to the quickstart entry and trims a trailing slash on the base url", () => {
  const { text, html } = onboardingNudgeEmail({
    recipientName: "sample owner",
    workspaceName: "ROOT TEAM",
    baseUrl: "https://app.grantry.ai/",
    locale: "en",
  });
  assert.ok(text.includes("https://app.grantry.ai/quickstart"), text);
  assert.equal(text.includes("//quickstart"), false);
  assert.ok(html.includes('href="https://app.grantry.ai/quickstart"'));
});
