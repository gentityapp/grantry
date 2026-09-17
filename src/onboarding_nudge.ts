// Onboarding nudge (issue #250): one "get started" email per workspace that
// signed up, confirmed email, and then never came back to create a scope.
// The dashboard quickstart (#248) only helps people who return; this is the
// "come back" half of the same funnel (scope-creation rate).
//
// Design notes:
// - No schema change: the "already nudged" state rides in AuditLog with
//   provider "system" and tool "email/onboarding_nudge", scope = workspaceId.
//   Re-send prevention is "a row with this tool + scope already exists", so a
//   workspace gets at most one nudge ever, restarts and redeploys included.
// - The target pick is a pure function (pickOnboardingNudgeTargets) so the
//   conditions (age, zero scopes, not yet nudged, one per workspace) are
//   testable without a database; this module's DB code is a thin wrapper.
// - requestArgs records only workspaceId/userId — never the email address.
// - Recipient is one admin per workspace: the owner when there is one, else a
//   single admin. Never fan-out to every admin (issue: "系列で連続送信しない").
// - Scheduler follows the startHealthSweepScheduler pattern: first tick 90s
//   after boot, then daily, both unref'd so they never hold the process open.
//   Without RESEND_API_KEY (local dev) it warns once and starts nothing.
import { prisma } from "./db.js";
import { onboardingNudgeEmail, sendSystemEmail } from "./email.js";

/** AuditLog.tool value under which sent nudges are recorded. */
export const ONBOARDING_NUDGE_TOOL = "email/onboarding_nudge";

/** The AuditLog (tool, scope) key a sent nudge is recorded under. */
export function onboardingNudgeRecordKey(workspaceId: string): { tool: string; scope: string } {
  return { tool: ONBOARDING_NUDGE_TOOL, scope: workspaceId };
}

export const DEFAULT_MIN_AGE_DAYS = 3;

export function onboardingNudgeMinAgeDays(): number {
  const raw = Number(process.env.ONBOARDING_NUDGE_MIN_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_AGE_DAYS;
}

export type NudgeWorkspace = {
  id: string;
  createdAt: Date;
  /** WorkspaceMember userId with role "owner", when the workspace has one. */
  ownerUserId: string | null;
};

export type NudgeTarget = NudgeWorkspace;

/**
 * Pure target pick: workspaces that are at least minAgeDays old, have zero
 * scopes, and have never been nudged. One entry per workspace (duplicate ids
 * in the input collapse to one), so a workspace can never get two mails in
 * one sweep.
 */
export function pickOnboardingNudgeTargets(args: {
  workspaces: NudgeWorkspace[];
  scopeCountsByWorkspace: Record<string, number>;
  nudgedWorkspaceIds: string[];
  now: Date;
  minAgeDays: number;
}): NudgeTarget[] {
  const nudged = new Set(args.nudgedWorkspaceIds);
  const seen = new Set<string>();
  const minAgeMs = args.minAgeDays * 24 * 60 * 60 * 1000;
  const targets: NudgeTarget[] = [];
  for (const ws of args.workspaces) {
    if (seen.has(ws.id)) continue; // one entry per workspace, ever
    seen.add(ws.id);
    if (nudged.has(ws.id)) continue; // already sent one
    if ((args.scopeCountsByWorkspace[ws.id] ?? 0) !== 0) continue; // already started
    if (args.now.getTime() - ws.createdAt.getTime() < minAgeMs) continue; // still fresh
    targets.push(ws);
  }
  return targets;
}

/**
 * Sweep once: pick eligible workspaces and send the nudge to one admin each.
 * A nudge is recorded in AuditLog only after sendSystemEmail actually sent
 * (non-null resend id) — under a missing RESEND_API_KEY nothing is recorded,
 * so the first real boot mails the backlogged workspaces exactly once.
 */
export async function runOnboardingNudgeSweep(opts?: {
  now?: Date;
  minAgeDays?: number;
}): Promise<{ targets: number; sent: number; noRecipient: number }> {
  const now = opts?.now ?? new Date();
  const minAgeDays = opts?.minAgeDays ?? onboardingNudgeMinAgeDays();
  const stats = { targets: 0, sent: 0, noRecipient: 0 };

  // Already-nudged workspaces: distinct AuditLog scopes for this tool.
  const nudged = await prisma.auditLog.findMany({
    where: { tool: ONBOARDING_NUDGE_TOOL },
    select: { scope: true },
    distinct: ["scope"],
  });
  const nudgedWorkspaceIds = nudged.map((row) => row.scope);

  // Members first: one recipient per workspace, owner preferred over admins.
  const workspaces = await prisma.workspace.findMany({
    select: {
      id: true,
      createdAt: true,
      displayName: true,
      members: {
        where: { role: { in: ["owner", "admin"] } },
        select: { role: true, user: { select: { id: true, email: true, name: true } } },
      },
    },
  });

  // Scope counts: a workspace's scopes are its tenants (the wire key agents
  // call `scope`); rows without a workspace belong to no workspace here.
  const counts = await prisma.tenant.groupBy({
    by: ["workspaceId"],
    _count: { _all: true },
    where: { workspaceId: { not: null } },
  });
  const scopeCountsByWorkspace: Record<string, number> = {};
  for (const row of counts) {
    if (row.workspaceId) scopeCountsByWorkspace[row.workspaceId] = row._count._all;
  }

  const targets = pickOnboardingNudgeTargets({
    workspaces: workspaces.map((ws) => {
      const owner = ws.members.find((m) => m.role === "owner") ?? ws.members[0] ?? null;
      return { id: ws.id, createdAt: ws.createdAt, ownerUserId: owner?.user.id ?? null };
    }),
    scopeCountsByWorkspace,
    nudgedWorkspaceIds,
    now,
    minAgeDays,
  });
  stats.targets = targets.length;
  if (!targets.length) return stats;

  const baseUrl = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  // The recipient's language is not stored on the user; default English,
  // overridable for a deployment whose audience is Japanese.
  const locale = process.env.ONBOARDING_NUDGE_LOCALE === "ja" ? "ja" : "en";

  for (const target of targets) {
    const ws = workspaces.find((w) => w.id === target.id)!;
    const owner = ws.members.find((m) => m.role === "owner") ?? ws.members[0] ?? null;
    if (!owner?.user.email) {
      stats.noRecipient += 1;
      continue;
    }
    try {
      const body = onboardingNudgeEmail({
        recipientName: owner.user.name || null,
        workspaceName: ws.displayName,
        baseUrl,
        locale,
      });
      const resendId = await sendSystemEmail({ to: owner.user.email, ...body });
      if (!resendId) continue; // RESEND_API_KEY unset — nothing sent, nothing recorded
      await prisma.auditLog.create({
        data: {
          provider: "system",
          tool: ONBOARDING_NUDGE_TOOL,
          scope: ws.id,
          status: "ok",
          userId: owner.user.id,
          requestArgs: JSON.stringify({ workspaceId: ws.id, userId: owner.user.id }),
        },
      });
      stats.sent += 1;
    } catch (e: any) {
      // One failed mail must not stop the sweep; it is retried next tick
      // because no AuditLog row was written.
      console.error(`[onboarding-nudge] send failed for workspace ${ws.id}: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
  console.log(`[onboarding-nudge] done: targets=${stats.targets} sent=${stats.sent} noRecipient=${stats.noRecipient}`);
  return stats;
}

const FIRST_NUDGE_DELAY_MS = 90 * 1000; // let the server settle after boot
const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export function startOnboardingNudgeScheduler() {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[onboarding-nudge] RESEND_API_KEY unset — onboarding nudge emails disabled");
    return;
  }
  const tick = () => {
    runOnboardingNudgeSweep().catch((e) => console.error("[onboarding-nudge] sweep crashed:", e));
  };
  setTimeout(tick, FIRST_NUDGE_DELAY_MS).unref?.();
  setInterval(tick, NUDGE_INTERVAL_MS).unref?.();
}
