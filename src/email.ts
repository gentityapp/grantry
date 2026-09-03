import { t } from "./i18n.js";

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

// System (transactional) email via the Resend HTTP API.
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
