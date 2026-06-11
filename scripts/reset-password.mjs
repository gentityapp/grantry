// Operator escape hatch: reset a dashboard user's password directly against
// the database. Use when someone is locked out (there is no email-based reset
// flow). Run with the production env, e.g.:
//
//   railway run npm run user:reset-password -- user@example.com 'new-password'
//
// or locally with DATABASE_URL exported. Hashes with better-auth's own scrypt
// (better-auth/crypto), so the result verifies identically to a normal signup.
// All existing sessions for the user are revoked.
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";

const [email, newPassword] = process.argv.slice(2);
if (!email || !newPassword) {
  console.error("usage: node scripts/reset-password.mjs <email> <new-password>");
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error("error: password must be at least 8 characters (better-auth minPasswordLength)");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { accounts: true },
  });
  if (!user) {
    console.error(`error: no user with email ${email}`);
    process.exit(1);
  }

  const hash = await hashPassword(newPassword);
  const credential = user.accounts.find((a) => a.providerId === "credential");
  if (credential) {
    await prisma.account.update({
      where: { id: credential.id },
      data: { password: hash },
    });
  } else {
    // Social-only user: attach a credential account so email+password works.
    await prisma.account.create({
      data: {
        id: randomUUID(),
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: hash,
      },
    });
  }

  const revoked = await prisma.session.deleteMany({ where: { userId: user.id } });
  console.log(`password reset for ${email} (${credential ? "updated credential" : "created credential account"}, ${revoked.count} session(s) revoked)`);
} finally {
  await prisma.$disconnect();
}
