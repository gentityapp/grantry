// Connection dormancy nudge (issue #281): one "your connection is quiet"
// email per workspace that has an enabled connection but no successful
// connection call (ping excluded) in the last N days — the "come back" half
// for the segment past the onboarding nudge (#250): the connection exists,
// the first successful call just never happened.
//
// Design notes (mirrors src/onboarding_nudge.ts):
// - No schema change: the "already nudged" state rides in AuditLog with
//   provider "system" and tool "email/connection_dormant_nudge", scope =
//   workspaceId. A workspace gets at most one nudge ever.
// - The target pick is a pure function (pickConnectionDormancyTargets) so the
//   conditions (enabled connection, silent window, not yet nudged, one per
//   workspace) are testable without a database; the DB code here is a thin
//   wrapper.
// - Sending is off by default: CONNECTION_DORMANT_NUDGE_ENABLED must be
//   "true". The rollout is sequenced after #250's measurement window, so the
//   switch is flipped in production deliberately, not by the deploy itself.
// - requestArgs records only workspaceId/userId — never the email address.
// - Recipient is one admin per workspace: the owner when there is one, else a
//   single admin. Never fan-out to every admin.
import { prisma } from "./db.js";
import { connectionDormantNudgeEmail, sendSystemEmail } from "./email.js";

/** AuditLog.tool value under which sent nudges are recorded. */
export const CONNECTION_DORMANT_NUDGE_TOOL = "email/connection_dormant_nudge";

/** The AuditLog (tool, scope) key a sent nudge is recorded under. */
export function connectionDormantNudgeRecordKey(workspaceId: string): { tool: string; scope: string } {
  return { tool: CONNECTION_DORMANT_NUDGE_TOOL, scope: workspaceId };
}

export const DEFAULT_SILENT_DAYS = 30;

export function connectionDormancySilentDays(): number {
  const raw = Number(process.env.CONNECTION_DORMANT_NUDGE_SILENT_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENT_DAYS;
}

/** Master switch: unset or anything but "true" (any case) never sends. */
export function isConnectionDormancyNudgeEnabled(): boolean {
  return String(process.env.CONNECTION_DORMANT_NUDGE_ENABLED ?? "").trim().toLowerCase() === "true";
}

export type DormancyWorkspace = {
  id: string;
  /** WorkspaceMember userId with role "owner", when the workspace has one. */
  ownerUserId: string | null;
};

export type DormancyTarget = DormancyWorkspace;

/**
 * Pure target pick: workspaces with at least one enabled connection whose
 * last successful connection call (ping excluded) is at least silentDays old
 * (or never happened), and that have never been nudged. One entry per
 * workspace (duplicate ids in the input collapse to one), so a workspace can
 * never get two mails in one sweep.
 */
export function pickConnectionDormancyTargets(args: {
  workspaces: DormancyWorkspace[];
  /** Enabled-connection count per workspace id. */
  enabledConnectionCounts: Record<string, number>;
  /** When each workspace last had a successful connection call (ping excluded). Missing = never called. */
  lastOkCallAt: Record<string, Date>;
  /** Workspace ids that already received one (AuditLog scopes for this tool). */
  nudgedWorkspaceIds: string[];
  now: Date;
  /** Silent-window length in days (CONNECTION_DORMANT_NUDGE_SILENT_DAYS). */
  silentDays: number;
}): DormancyTarget[] {
  const nudged = new Set(args.nudgedWorkspaceIds);
  const seen = new Set<string>();
  const silentMs = args.silentDays * 24 * 60 * 60 * 1000;
  const targets: DormancyTarget[] = [];
  for (const ws of args.workspaces) {
    if (seen.has(ws.id)) continue; // one entry per workspace, ever
    seen.add(ws.id);
    if (nudged.has(ws.id)) continue; // already sent one
    if ((args.enabledConnectionCounts[ws.id] ?? 0) <= 0) continue; // nothing to use
    const lastOk = args.lastOkCallAt[ws.id];
    if (lastOk && args.now.getTime() - lastOk.getTime() < silentMs) continue; // active recently
    targets.push(ws);
  }
  return targets;
}

/**
 * Sweep once: pick eligible workspaces and send the nudge to one admin each.
 * A nudge is recorded in AuditLog only after sendSystemEmail actually sent
 * (non-null resend id) — without that, nothing is recorded, so the first
 * enabled boot mails the backlogged workspaces exactly once.
 */
export async function runConnectionDormancyNudgeSweep(opts?: {
  now?: Date;
  silentDays?: number;
}): Promise<{ targets: number; sent: number; noRecipient: number }> {
  const stats = { targets: 0, sent: 0, noRecipient: 0 };
  if (!isConnectionDormancyNudgeEnabled()) {
    console.log("[dormancy-nudge] CONNECTION_DORMANT_NUDGE_ENABLED not true — sweep skipped");
    return stats;
  }
  const now = opts?.now ?? new Date();
  const silentDays = opts?.silentDays ?? connectionDormancySilentDays();

  // Already-nudged workspaces: distinct AuditLog scopes for this tool.
  const nudged = await prisma.auditLog.findMany({
    where: { tool: CONNECTION_DORMANT_NUDGE_TOOL },
    select: { scope: true },
    distinct: ["scope"],
  });
  const nudgedWorkspaceIds = nudged.map((row) => row.scope);

  // Only workspaces that actually have an enabled connection, with recipients
  // (owner preferred over admins, one recipient per workspace).
  const workspaces = await prisma.workspace.findMany({
    where: { connections: { some: { enabled: true } } },
    select: {
      id: true,
      displayName: true,
      members: {
        where: { role: { in: ["owner", "admin"] } },
        select: { role: true, user: { select: { id: true, email: true, name: true } } },
      },
      connections: { where: { enabled: true }, select: { id: true } },
    },
  });
  const enabledConnectionCounts: Record<string, number> = {};
  for (const ws of workspaces) enabledConnectionCounts[ws.id] = ws.connections.length;

  // Last successful connection call (ping excluded), per connection first
  // (AuditLog has no workspaceId), then rolled up to the connection's
  // workspace. Rows whose connection is gone cannot be attributed and are
  // skipped — erring on the side of not mailing.
  const okCalls = await prisma.auditLog.groupBy({
    by: ["connectionId"],
    _max: { createdAt: true },
    where: { connectionId: { not: null }, status: "ok", tool: { not: "ping" } },
  });
  const connectionIds = okCalls
    .map((row) => row.connectionId)
    .filter((id): id is string => id !== null);
  const connections = connectionIds.length
    ? await prisma.connection.findMany({
        where: { id: { in: connectionIds } },
        select: { id: true, workspaceId: true },
      })
    : [];
  const workspaceIdByConnection = new Map(connections.map((c) => [c.id, c.workspaceId]));
  const lastOkCallAt: Record<string, Date> = {};
  for (const row of okCalls) {
    const wsId = row.connectionId ? workspaceIdByConnection.get(row.connectionId) : null;
    const at = row._max.createdAt;
    if (!wsId || !at) continue;
    if (!lastOkCallAt[wsId] || at > lastOkCallAt[wsId]) lastOkCallAt[wsId] = at;
  }

  const targets = pickConnectionDormancyTargets({
    workspaces: workspaces.map((ws) => {
      const owner = ws.members.find((m) => m.role === "owner") ?? ws.members[0] ?? null;
      return { id: ws.id, ownerUserId: owner?.user.id ?? null };
    }),
    enabledConnectionCounts,
    lastOkCallAt,
    nudgedWorkspaceIds,
    now,
    silentDays,
  });
  stats.targets = targets.length;
  if (!targets.length) return stats;

  const baseUrl = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  // Same locale handling as the onboarding nudge: the recipient's language is
  // not stored on the user; default English, overridable per deployment.
  const locale = process.env.ONBOARDING_NUDGE_LOCALE === "ja" ? "ja" : "en";

  for (const target of targets) {
    const ws = workspaces.find((w) => w.id === target.id)!;
    const owner = ws.members.find((m) => m.role === "owner") ?? ws.members[0] ?? null;
    if (!owner?.user.email) {
      stats.noRecipient += 1;
      continue;
    }
    try {
      const body = connectionDormantNudgeEmail({
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
          tool: CONNECTION_DORMANT_NUDGE_TOOL,
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
      console.error(`[dormancy-nudge] send failed for workspace ${ws.id}: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
  console.log(`[dormancy-nudge] done: targets=${stats.targets} sent=${stats.sent} noRecipient=${stats.noRecipient}`);
  return stats;
}

const FIRST_SWEEP_DELAY_MS = 90 * 1000; // let the server settle after boot
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export function startConnectionDormancyNudgeScheduler() {
  if (!isConnectionDormancyNudgeEnabled()) {
    console.warn("[dormancy-nudge] CONNECTION_DORMANT_NUDGE_ENABLED not true — connection dormancy nudge disabled");
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn("[dormancy-nudge] RESEND_API_KEY unset — connection dormancy nudge emails disabled");
    return;
  }
  const tick = () => {
    runConnectionDormancyNudgeSweep().catch((e) => console.error("[dormancy-nudge] sweep crashed:", e));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref?.();
  setInterval(tick, SWEEP_INTERVAL_MS).unref?.();
}
