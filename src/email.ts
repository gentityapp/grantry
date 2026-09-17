import { t, runWithLocale, type Locale } from "./i18n.js";

// Local copy of the dashboard's escaper: email bodies are assembled here, and
// importing ui.ts (which registers every route on import) just for it would
// drag the whole dashboard into any module that sends mail.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;"
  );
}

export type AgentAssignedEmailInput = {
  recipientName: string | null;
  assignedByEmail: string;
  agentId: string;
  agentName: string;
  /** The agent's charter (`Agent.description`), when it has one. */
  charter: string | null;
  workspaceName: string;
  /** Dashboard origin, no trailing slash. */
  baseUrl: string;
};

/**
 * Body of the "an agent was assigned to you" notification.
 *
 * Pure so it can be asserted on directly: the link has to resolve to the
 * agent's own page (an assignee passes `userMayUseAgent`, so they can open it
 * without being a workspace admin), and untrusted display text — agent name,
 * charter, workspace name — has to be escaped in the HTML part.
 */
export function agentAssignedEmail(input: AgentAssignedEmailInput): { subject: string; text: string; html: string } {
  const base = input.baseUrl.replace(/\/+$/, "");
  const link = `${base}/agents/${encodeURIComponent(input.agentId)}`;
  const tokensLink = `${base}/mcp-tokens`;
  const greeting = input.recipientName ? t("Hi {name},", { name: input.recipientName }) : t("Hi,");
  const howTo = t("It is usable from your personal MCP token right away — no new token to copy. If you have not created one yet, do it on the MCP tokens page.");

  const subject = t("You've been assigned the agent {agent} on grantry", { agent: input.agentName });
  const headline = t("{admin} assigned you the agent {agent} in the {workspace} workspace on grantry.", {
    admin: input.assignedByEmail,
    agent: input.agentName,
    workspace: input.workspaceName,
  });

  const text = [
    greeting,
    "",
    headline,
    ...(input.charter ? ["", `${t("What it does")}: ${input.charter}`] : []),
    "",
    `${t("Agent details")}:`,
    link,
    "",
    howTo,
    tokensLink,
    "",
  ].join("\n");

  const html = `<p>${escapeHtml(greeting)}</p>
<p>${t("<b>{admin}</b> assigned you the agent <b>{agent}</b> in the <b>{workspace}</b> workspace on grantry.", {
    admin: escapeHtml(input.assignedByEmail),
    agent: escapeHtml(input.agentName),
    workspace: escapeHtml(input.workspaceName),
  })}</p>
${input.charter ? `<p style="color:#555;">${escapeHtml(input.charter)}</p>\n` : ""}<p><a href="${link}">${escapeHtml(t("Open the agent page"))}</a></p>
<p style="color:#888;font-size:13px;">${escapeHtml(howTo)}<br><a href="${tokensLink}">${tokensLink}</a></p>`;

  return { subject, text, html };
}

export type OnboardingNudgeEmailInput = {
  recipientName: string | null;
  workspaceName: string;
  /** Dashboard origin, no trailing slash. */
  baseUrl: string;
  /**
   * Force the locale the body is written in. Defaults to the active locale
   * (t() reads it from AsyncLocalStorage, same as agentAssignedEmail); the
   * onboarding sweep sends outside a request, so it passes this explicitly.
   */
  locale?: Locale;
};

/**
 * Body of the "your workspace has no scope yet" onboarding nudge (issue #250).
 *
 * Pure so it can be asserted on directly: the link is the quickstart entry
 * (issue #248) so the reader sees an example before committing to a scope key,
 * and the workspace name is untrusted display text that has to be escaped in
 * the HTML part.
 */
export function onboardingNudgeEmail(input: OnboardingNudgeEmailInput): { subject: string; text: string; html: string } {
  const build = (): { subject: string; text: string; html: string } => {
    const base = input.baseUrl.replace(/\/+$/, "");
    const link = `${base}/quickstart`;
    const greeting = input.recipientName ? t("Hi {name},", { name: input.recipientName }) : t("Hi,");
    const why = t("A scope is what an agent acts through — until one exists there is nothing for your agents to do. The quickstart sets one up in a single step: paste one credential and you get a scope, a connection and a test agent.");

    const subject = t("Get started with grantry — create the first scope in {workspace}", { workspace: input.workspaceName });
    const headline = t("The {workspace} workspace on grantry has no scope yet.", { workspace: input.workspaceName });

    const text = [
      greeting,
      "",
      headline,
      "",
      why,
      "",
      `${t("Open quickstart")}:`,
      link,
      "",
      t("If now is not the right time, feel free to ignore this note."),
      "",
    ].join("\n");

    const html = `<p>${escapeHtml(greeting)}</p>
<p>${t("The <b>{workspace}</b> workspace on grantry has no scope yet.", { workspace: escapeHtml(input.workspaceName) })}</p>
<p style="color:#555;">${escapeHtml(why)}</p>
<p><a href="${link}">${escapeHtml(t("Open quickstart"))}</a></p>
<p style="color:#888;font-size:13px;">${escapeHtml(t("If now is not the right time, feel free to ignore this note."))}</p>`;

    return { subject, text, html };
  };

  return input.locale ? runWithLocale(input.locale, build) : build();
}
export type ConnectionDormantNudgeEmailInput = {
  recipientName: string | null;
  workspaceName: string;
  /** Dashboard origin, no trailing slash. */
  baseUrl: string;
  locale?: Locale;
};

/**
 * Body of the "your connection went quiet" dormancy nudge (issue #281).
 *
 * Separate body from the onboarding nudge (#250): this segment already has a
 * connection, so the one step shown is "attach it to an agent, paste the MCP
 * settings, run the first call" (the agent-page smoke test), not the
 * quickstart. Pure so it can be asserted on directly; the workspace name is
 * untrusted display text and has to be escaped in the HTML part.
 */
export function connectionDormantNudgeEmail(input: ConnectionDormantNudgeEmailInput): { subject: string; text: string; html: string } {
  const build = (): { subject: string; text: string; html: string } => {
    const base = input.baseUrl.replace(/\/+$/, "");
    const link = `${base}/agents`;
    const greeting = input.recipientName ? t("Hi {name},", { name: input.recipientName }) : t("Hi,");
    const why = t("One step brings it back: open (or create) an agent, attach the connection to it, paste the MCP settings into your agent host, and run the first call — the smoke test on the agent page checks the call for you.");

    const subject = t("Your connection in {workspace} has not made a successful call yet", { workspace: input.workspaceName });
    const headline = t("The {workspace} workspace on grantry already has a connection set up, but no successful agent call has gone through it recently.", { workspace: input.workspaceName });

    const text = [
      greeting,
      "",
      headline,
      "",
      why,
      "",
      `${t("Open your agents")}:`,
      link,
      "",
      t("If now is not the right time, feel free to ignore this note."),
      "",
    ].join("\n");

    const html = `<p>${escapeHtml(greeting)}</p>
<p>${t("The <b>{workspace}</b> workspace on grantry already has a connection set up, but no successful agent call has gone through it recently.", { workspace: escapeHtml(input.workspaceName) })}</p>
<p style="color:#555;">${escapeHtml(why)}</p>
<p><a href="${link}">${escapeHtml(t("Open your agents"))}</a></p>
<p style="color:#888;font-size:13px;">${escapeHtml(t("If now is not the right time, feel free to ignore this note."))}</p>`;

    return { subject, text, html };
  };

  return input.locale ? runWithLocale(input.locale, build) : build();
}
//
// This is the service's own outbound mail — password resets and similar —
// authenticated by RESEND_API_KEY, independent of any tenant Connection.
// When RESEND_API_KEY is unset (local dev), the mail is not sent; the text
// body is logged instead so flows that embed links remain testable.
export async function sendSystemEmail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SYSTEM_EMAIL_FROM ?? "grantry <noreply@app.grantry.ai>";

  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY unset — NOT sending to ${args.to} (${args.subject}). Body:\n${args.text}`);
    return null;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: args.subject,
      text: args.text,
      ...(args.html ? { html: args.html } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend send failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const body = await res.json().catch(() => null) as { id?: string } | null;
  return body?.id ?? null;
}
