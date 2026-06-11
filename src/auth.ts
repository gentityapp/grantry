// better-auth setup
// Email + password, with Google + GitHub OAuth
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db.js";
import { sendSystemEmail } from "./email.js";

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
    autoSignIn: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      await sendSystemEmail({
        to: user.email,
        subject: "Reset your agent-oauth password",
        text: `Hi ${user.name || user.email},

Someone requested a password reset for your agent-oauth account.
Open this link to choose a new password (valid for 1 hour):

${url}

If you didn't request this, you can safely ignore this email.`,
        html: `<p>Hi ${user.name || user.email},</p>
<p>Someone requested a password reset for your <b>agent-oauth</b> account.</p>
<p><a href="${url}">Choose a new password</a> (valid for 1 hour)</p>
<p style="color:#888;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`,
      });
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1h
    onPasswordReset: async ({ user }) => {
      console.log(`[auth] password was reset for ${user.email}`);
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
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
});

export type Auth = typeof auth;
