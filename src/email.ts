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
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SYSTEM_EMAIL_FROM ?? "agent-oauth <noreply@app.grantry.ai>";

  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY unset — NOT sending to ${args.to} (${args.subject}). Body:\n${args.text}`);
    return;
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
}
