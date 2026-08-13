import assert from "node:assert/strict";
import { test } from "node:test";

import { agentAssignedEmail } from "../../src/email.js";
import { runWithLocale } from "../../src/i18n.js";

const base = {
  recipientName: "sample owner",
  assignedByEmail: "cs-lead-1@example.com",
  agentId: "cmsrqw7kh07101431285ekp2k",
  agentName: "seminar-thumbnail-agent",
  charter: "セミナーサムネイル生成L1。",
  workspaceName: "ROOT TEAM",
  baseUrl: "https://app.grantry.ai",
};

test("links to the assigned agent's own detail page", () => {
  const { text, html } = agentAssignedEmail(base);
  const link = "https://app.grantry.ai/agents/cmsrqw7kh07101431285ekp2k";
  assert.ok(text.includes(link), "plain-text part must carry the agent link");
  assert.ok(html.includes(`href="${link}"`), "html part must link the agent page");
});

test("a trailing slash on the base url does not produce a double slash", () => {
  const { text } = agentAssignedEmail({ ...base, baseUrl: "https://app.grantry.ai/" });
  assert.ok(text.includes("https://app.grantry.ai/agents/"), text);
  assert.equal(text.includes("//agents/"), false);
});

test("names the agent, the assigner and the workspace", () => {
  const { subject, text } = agentAssignedEmail(base);
  assert.ok(subject.includes("seminar-thumbnail-agent"));
  assert.ok(text.includes("cs-lead-1@example.com"));
  assert.ok(text.includes("ROOT TEAM"));
  assert.ok(text.includes("セミナーサムネイル生成L1。"), "charter should be included when set");
});

test("omits the charter block when the agent has none", () => {
  const { text, html } = agentAssignedEmail({ ...base, charter: null });
  assert.equal(text.includes("What it does"), false);
  assert.equal(html.includes("color:#555"), false);
});

test("falls back to a nameless greeting", () => {
  const { text } = agentAssignedEmail({ ...base, recipientName: null });
  assert.ok(text.startsWith("Hi,"), text.slice(0, 40));
});

test("escapes untrusted display text in the html part", () => {
  const { html } = agentAssignedEmail({
    ...base,
    agentName: '<img src=x onerror=alert(1)>',
    workspaceName: "R&D",
    charter: '</p><script>alert(1)</script>',
  });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("&lt;img src=x"));
  assert.ok(html.includes("R&amp;D"));
});

test("renders in Japanese under the ja locale", () => {
  const { subject, html } = runWithLocale("ja", () => agentAssignedEmail(base));
  assert.ok(subject.includes("割り当てられました"), subject);
  assert.ok(html.includes("ワークスペース"), html.slice(0, 400));
  // The bolded placeholders must survive translation.
  assert.ok(html.includes("<b>seminar-thumbnail-agent</b>"), html.slice(0, 400));
});

test("defaults to English with no locale context", () => {
  const { subject } = agentAssignedEmail(base);
  assert.ok(subject.startsWith("You've been assigned the agent"), subject);
});
