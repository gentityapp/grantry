// better-auth setup
// Email + password, with Google + GitHub OAuth
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { mcp } from "better-auth/plugins";
import { prisma } from "./db.js";
import { sendSystemEmail } from "./email.js";
import { t, htmlLang } from "./i18n.js";

const googleSignInClientId =
  process.env.AUTH_GOOGLE_CLIENT_ID
  || process.env.GRANTRY_AUTH_GOOGLE_CLIENT_ID
  || "";

const googleSignInClientSecret =
  process.env.AUTH_GOOGLE_CLIENT_SECRET
  || process.env.GRANTRY_AUTH_GOOGLE_CLIENT_SECRET
  || "";

// grantry's own Google OAuth client (the one behind "Sign in with Google").
// Application features that talk to Google as grantry itself — the Google
// Workspace directory link used for member invites — reuse this client instead
// of a customer-supplied provider connection.
export const googleSignInClient = {
  clientId: googleSignInClientId,
  clientSecret: googleSignInClientSecret,
};

// Consent screen for MCP OAuth (claude.ai / Claude Desktop connecting via
// dynamic client registration). Rendered by the /mcp/authorize endpoint when
// the logged-in user still has to approve the client. The page also lets the
// user pick which grantry Agent this connector should act as — the binding is
// stored via POST /oauth-consent/bind (see ui.ts) before consent is submitted.
function consentHTML(props: {
  clientId: string;
  clientName: string;
  clientIcon?: string | undefined;
  code: string;
  scopes: string[];
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const clientName = esc(props.clientName || t("Unknown MCP client"));
  return `<!doctype html>
<html lang="${htmlLang()}"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(t("{client} wants to connect", { client: clientName }))} — grantry</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;max-width:440px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h1{font-size:18px;margin:0 0 8px}
  p{color:#555;font-size:14px;line-height:1.6}
  .scopes{background:#f6f7f9;border-radius:8px;padding:10px 14px;font-size:13px;color:#444;margin:12px 0}
  label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}
  select{width:100%;padding:10px;border:1px solid #ccd0d5;border-radius:8px;font-size:14px;background:#fff}
  .note{font-size:12px;color:#888;margin-top:8px}
  .row{display:flex;gap:10px;margin-top:24px}
  button{flex:1;padding:11px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent}
  .approve{background:#1a7f37;color:#fff}
  .approve:disabled{background:#9fc7ab;cursor:not-allowed}
  .deny{background:#fff;color:#444;border-color:#ccd0d5}
  .err{color:#b42318;font-size:13px;margin-top:12px;display:none}
</style></head>
<body><div class="card">
  <h1>${esc(t("{client} wants to connect", { client: clientName }))}</h1>
  <p>${esc(t("This MCP client is asking to access your grantry tools. It will act as the agent you choose below, using that agent's granted connections exactly as configured in your dashboard (changes there apply immediately)."))}</p>
  <div class="scopes">${esc(t("Requested scopes: {scopes}", { scopes: props.scopes.join(", ") || t("(default)") }))}</div>
  <label for="agent">${esc(t("Act as agent"))}</label>
  <select id="agent" disabled><option>${esc(t("Loading agents…"))}</option></select>
  <p class="note">${esc(t("The connector gets this agent's permissions — nothing more. You can revoke access anytime from the grantry dashboard."))}</p>
  <div class="row">
    <button class="deny" id="deny">${esc(t("Deny"))}</button>
    <button class="approve" id="approve" disabled>${esc(t("Approve"))}</button>
  </div>
  <p class="err" id="err"></p>
</div>
<script>
  const clientId = ${JSON.stringify(props.clientId)};
  const code = ${JSON.stringify(props.code)};
  const sel = document.getElementById("agent");
  const approve = document.getElementById("approve");
  const deny = document.getElementById("deny");
  const err = document.getElementById("err");
  function fail(msg){ err.textContent = msg; err.style.display = "block"; }
  fetch("/oauth-consent/agents", { credentials: "include" })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(${JSON.stringify(t("Could not load your agents — are you logged in?"))})))
    .then(d => {
      const agents = d.agents || [];
      if (!agents.length) { fail(${JSON.stringify(t("You have no enabled agents. Create one in the dashboard first."))}); return; }
      sel.innerHTML = agents.map(a => '<option value="' + a.id + '">' + a.name.replace(/</g,"&lt;") + '</option>').join("");
      sel.disabled = false; approve.disabled = false;
    })
    .catch(e => fail(e.message));
  async function submitConsent(accept){
    approve.disabled = true; deny.disabled = true;
    try {
      if (accept) {
        const bind = await fetch("/oauth-consent/bind", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, agentId: sel.value }),
        });
        if (!bind.ok) throw new Error(${JSON.stringify(t("Failed to bind agent"))});
      }
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, consent_code: code }),
      });
      if (!res.ok) throw new Error(${JSON.stringify(t("Consent request failed"))});
      const data = await res.json();
      if (data.redirectURI) { window.location.href = data.redirectURI; return; }
      throw new Error(${JSON.stringify(t("No redirect URI returned"))});
    } catch (e) {
      approve.disabled = false; deny.disabled = false;
      fail(e.message);
    }
  }
  approve.addEventListener("click", () => submitConsent(true));
  deny.addEventListener("click", () => submitConsent(false));
</script>
</body></html>`;
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  // Extra origins that may serve the dashboard (e.g. the legacy Railway
  // domain while BETTER_AUTH_URL points at the canonical custom domain).
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      await sendSystemEmail({
        to: user.email,
        subject: "Reset your grantry password",
        text: `Hi ${user.name || user.email},

Someone requested a password reset for your grantry account.
Open this link to choose a new password (valid for 1 hour):

${url}

If you didn't request this, you can safely ignore this email.`,
        html: `<p>Hi ${user.name || user.email},</p>
<p>Someone requested a password reset for your <b>grantry</b> account.</p>
<p><a href="${url}">Choose a new password</a> (valid for 1 hour)</p>
<p style="color:#888;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`,
      });
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1h
    onPasswordReset: async ({ user }) => {
      console.log(`[auth] password was reset for ${user.email}`);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    expiresIn: 60 * 60 * 24, // 24h
    sendVerificationEmail: async ({ user, url }) => {
      await sendSystemEmail({
        to: user.email,
        subject: "Verify your grantry email",
        text: `Hi ${user.name || user.email},

Open this link to verify your grantry email address (valid for 24 hours):

${url}

If you didn't create a grantry account, you can safely ignore this email.`,
        html: `<p>Hi ${user.name || user.email},</p>
<p>Open this link to verify your <b>grantry</b> email address:</p>
<p><a href="${url}">Verify email address</a> (valid for 24 hours)</p>
<p style="color:#888;font-size:13px;">If you didn't create a grantry account, you can safely ignore this email.</p>`,
      });
    },
  },
  socialProviders: {
    google: {
      clientId: googleSignInClientId,
      clientSecret: googleSignInClientSecret,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      requireLocalEmailVerified: false,
      updateUserInfoOnLink: true,
    },
  },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24, // 24h
    updateAge: 60 * 60, // refresh after 1h
  },
  plugins: [
    // OAuth 2.1 authorization server for remote MCP clients (claude.ai,
    // Claude Desktop, ...). Adds /.well-known discovery, dynamic client
    // registration (/mcp/register), /mcp/authorize, /mcp/token and the
    // /oauth2/consent endpoint. The static gn_agt_ token path in mcp.ts is
    // unaffected — both auth styles work side by side.
    mcp({
      loginPage: "/login",
      // RFC 9728: the resource identifier must match the MCP server URL the
      // client connects to (origin alone fails strict client validation).
      resource: `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/mcp`,
      oidcConfig: {
        loginPage: "/login",
        allowDynamicClientRegistration: true,
        requirePKCE: true,
        scopes: ["openid", "profile", "email", "offline_access"],
        defaultScope: "openid",
        accessTokenExpiresIn: 60 * 60, // 1h; clients refresh silently
        refreshTokenExpiresIn: 60 * 60 * 24 * 60, // 60d before re-consent
        codeExpiresIn: 600,
        getConsentHTML: (props) =>
          consentHTML({
            clientId: props.clientId,
            clientName: props.clientName,
            clientIcon: props.clientIcon,
            code: props.code,
            scopes: props.scopes,
          }),
      },
    }),
  ],
});

export type Auth = typeof auth;
