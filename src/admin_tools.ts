// grantry self-management (control-plane) tools, dispatched as a normal
// provider ("grantry") through the standard connection/grant policy path.
//
// grantry dogfoods its own model: the credential behind a grantry connection
// is a gn_adm_ admin API key that a human mints on the dashboard (/api-keys),
// exactly like a GitHub PAT from github.com/settings. The key IS the admin
// capability — its workspace decides what these tools can touch, regardless
// of which agent presents it.
//
// Anti-self-replication, by construction rather than by flag:
//   - keys are minted on the dashboard only; no tool can mint or list keys
//   - agents never see connection plaintext, so an admin-granted agent cannot
//     copy its own key into new connections
//   - create_connection refuses provider="grantry" and grant_scope skips
//     grantry connections: placing/spreading the admin credential stays a
//     human dashboard action
//   - grant_connection (the precise, single-connection door) additionally
//     refuses money/mail/identity/infrastructure providers, because a quiet
//     one-line grant of those is the hard case to catch in an audit log
//   - rotating/disabling the key on /api-keys kills every connection using it
//
// Minted agent tokens (gn_agt_) are returned exactly once in the tool result
// and must never appear in audit logs; callers audit `summary`, not payload.
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { encrypt } from "./crypto.js";
import { ensureTenant } from "./tenants.js";
import { getProviderForWorkspace } from "./connectors/registry.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";
import { connectionCredentialData, createTenantConnectionFromCredential } from "./provider_credentials.js";
import { agentAssignedEmail, sendSystemEmail } from "./email.js";

export const ADMIN_TOOLS = [
  "grantry/list_agents",
  "grantry/list_tenants",
  "grantry/list_connections",
  "grantry/create_tenant",
  "grantry/create_agent",
  "grantry/update_agent",
  "grantry/delete_agent",
  "grantry/assign_agent",
  "grantry/unassign_agent",
  "grantry/set_runbook",
  "grantry/rotate_agent_token",
  "grantry/grant_scope",
  "grantry/revoke_scope",
  "grantry/grant_connection",
  "grantry/revoke_connection",
  "grantry/create_connection",
  "grantry/set_connection_enabled",
  "grantry/get_connect_url",
] as const;

/** Public dashboard origin used to build human-facing connect links. */
function dashboardOrigin(): string {
  return String(process.env.BETTER_AUTH_URL || process.env.APP_ORIGIN || "https://app.grantry.ai").replace(/\/+$/, "");
}

export type AdminToolName = (typeof ADMIN_TOOLS)[number];

export function isAdminTool(name: string): name is AdminToolName {
  return (ADMIN_TOOLS as readonly string[]).includes(name);
}

/** The boundary the presented admin API key is authorized for. */
export type AdminContext = {
  ownerId: string;
  workspaceId: string | null;
};

export type AdminToolResult = {
  /** Tool payload returned to the caller (may contain a one-time token). */
  payload: Record<string, unknown>;
  /** Token-free one-liner for the audit log's responseSummary. */
  summary: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function credentialStatusFromMetadata(raw: string | null | undefined): string {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return typeof parsed?.status === "string" ? parsed.status : "unknown";
  } catch {
    return "unknown";
  }
}

function boundaryWhere(ctx: AdminContext): Record<string, unknown> {
  return ctx.workspaceId ? { workspaceId: ctx.workspaceId } : { ownerId: ctx.ownerId };
}

function mintAgentToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `gn_agt_${randomUUID().replace(/-/g, "")}`;
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    tokenPrefix: token.slice(0, 16),
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`'${key}' is required`);
  return v.trim();
}

function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new Error(`'${key}' must be a boolean`);
  return v;
}

/** Resolve a target agent inside the key's boundary. */
async function targetAgent(ctx: AdminContext, agentId: string) {
  const target = await prisma.agent.findFirst({
    where: { id: agentId, ...boundaryWhere(ctx) },
  });
  if (!target) throw new Error(`agent not found in this workspace: ${agentId}`);
  return target;
}

function requireWorkspace(ctx: AdminContext): string {
  if (!ctx.workspaceId) {
    throw new Error("agent assignment requires a workspace-scoped grantry admin key");
  }
  return ctx.workspaceId;
}

async function targetWorkspaceMember(ctx: AdminContext, args: Record<string, unknown>) {
  const workspaceId = requireWorkspace(ctx);
  const userId = typeof args.user_id === "string" ? args.user_id.trim() : "";
  const userEmail = typeof args.user_email === "string" ? args.user_email.trim().toLowerCase() : "";
  if (!userId && !userEmail) throw new Error("'user_id' or 'user_email' is required");

  const member = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId,
      user: userId ? { id: userId } : { email: userEmail },
    },
    include: { user: { select: { id: true, email: true, name: true } }, workspace: { select: { displayName: true } } },
  });
  if (!member) {
    throw new Error(
      userId
        ? `user is not a member of this workspace: ${userId}`
        : `user is not a member of this workspace: ${userEmail}`,
    );
  }
  return member;
}

async function agentScopes(agentId: string): Promise<string[]> {
  const grants = await prisma.agentConnectionGrant.findMany({
    where: { agentId },
    select: { connection: { select: { scope: true } } },
  });
  return Array.from(new Set(grants.map((g) => g.connection.scope))).sort();
}

/**
 * Enabled connections at `scope` that admin tools may grant. grantry-provider
 * connections are excluded: spreading the admin credential to more agents is
 * a human dashboard action, not something admin tools can do to themselves.
 */
async function grantableConnectionsAtScope(ctx: AdminContext, scope: string) {
  return prisma.connection.findMany({
    where: { ...boundaryWhere(ctx), enabled: true, scope, provider: { not: "grantry" } },
    select: { id: true, provider: true },
  });
}

/**
 * Providers a tool call may not hand to an agent one connection at a time.
 *
 * Rationale: `grant_connection` is the precise door, and precision is exactly
 * what makes a hijacked admin-key agent dangerous — a single quiet grant of a
 * money/mail/identity/infrastructure credential is easy to miss in an audit
 * log, where a whole-scope grant is loud. Scope-level grants keep working for
 * these (they are visible as such), and the dashboard can always grant them:
 * a human is looking at the screen there.
 *
 * This is the same shape as the existing anti-self-replication rule for
 * provider="grantry" — placing the highest-leverage credentials stays a human
 * action, by construction rather than by flag.
 */
const CONNECTION_GRANT_DENYLIST = new Set([
  "grantry",
  "stripe",
  "gmail",
  "google_admin",
  "cloudflare",
  "godaddy",
  "railway",
  "railway_api",
  "aws",
  "supabase",
  "snowflake",
  "bigquery",
  "salesforce",
  "vercel",
  "resend",
  "sendgrid",
]);

function assertConnectionGrantable(provider: string): void {
  if (CONNECTION_GRANT_DENYLIST.has(provider)) {
    throw new Error(
      `provider '${provider}' cannot be granted connection-by-connection over MCP — it controls money, mail, identity, or infrastructure. Grant it from the dashboard (a human confirms it there), or use grantry_grant_scope, which records the whole scope in the audit log.`,
    );
  }
}

/** Resolve one connection inside the admin key's boundary. */
async function targetConnection(ctx: AdminContext, connectionId: string) {
  const conn = await prisma.connection.findFirst({
    where: { id: connectionId, ...boundaryWhere(ctx) },
    select: { id: true, provider: true, scope: true, enabled: true, label: true },
  });
  if (!conn) throw new Error(`connection not found in this workspace: ${connectionId}`);
  return conn;
}

export async function callAdminTool(
  toolName: AdminToolName,
  args: Record<string, unknown>,
  ctx: AdminContext,
): Promise<AdminToolResult> {
  if (toolName === "grantry/list_agents") {
    const agents = await prisma.agent.findMany({
      where: boundaryWhere(ctx),
      orderBy: { createdAt: "asc" },
      select: {
        id: true, name: true, description: true, enabled: true,
        fullScopeManager: true, tokenPrefix: true,
        expiresAt: true, lastUsedAt: true, createdAt: true,
        connectionGrants: { select: { connection: { select: { scope: true, provider: true } } } },
      },
    });
    const payload = {
      agents: agents.map((a) => ({
        agent_id: a.id,
        name: a.name,
        charter: a.description,
        enabled: a.enabled,
        full_scope_manager: a.fullScopeManager,
        grantry_admin: a.connectionGrants.some((g) => g.connection.provider === "grantry"),
        token_prefix: a.tokenPrefix,
        expires_at: a.expiresAt?.toISOString() ?? null,
        last_used_at: a.lastUsedAt?.toISOString() ?? null,
        created_at: a.createdAt.toISOString(),
        scopes: Array.from(new Set(a.connectionGrants.map((g) => g.connection.scope))).sort(),
      })),
      count: agents.length,
    };
    return { payload, summary: `listed ${agents.length} agent(s)` };
  }

  if (toolName === "grantry/list_tenants") {
    const tenants = await prisma.tenant.findMany({
      where: boundaryWhere(ctx),
      orderBy: { slug: "asc" },
      select: {
        slug: true, displayName: true, description: true, createdAt: true,
        connections: { select: { provider: true, enabled: true } },
      },
    });
    const payload = {
      tenants: tenants.map((t) => ({
        scope: t.slug,
        display_name: t.displayName,
        description: t.description,
        created_at: t.createdAt.toISOString(),
        providers: Array.from(new Set(t.connections.filter((c) => c.enabled).map((c) => c.provider))).sort(),
        connection_count: t.connections.length,
      })),
      count: tenants.length,
    };
    return { payload, summary: `listed ${tenants.length} tenant(s)` };
  }

  if (toolName === "grantry/list_connections") {
    const scope = args.target_scope == null ? "" : String(args.target_scope).trim();
    const connections = await prisma.connection.findMany({
      where: { ...boundaryWhere(ctx), ...(scope ? { scope } : {}) },
      orderBy: [{ scope: "asc" }, { provider: "asc" }],
      select: {
        id: true, provider: true, authType: true, scope: true, label: true,
        enabled: true, credentialValidatedAt: true, createdAt: true,
      },
    });
    const payload = {
      connections: connections.map((cn) => ({
        connection_id: cn.id,
        provider: cn.provider,
        auth_type: cn.authType,
        scope: cn.scope,
        label: cn.label,
        enabled: cn.enabled,
        credential_validated_at: cn.credentialValidatedAt?.toISOString() ?? null,
        created_at: cn.createdAt.toISOString(),
      })),
      count: connections.length,
    };
    return { payload, summary: `listed ${connections.length} connection(s)${scope ? ` for scope ${scope}` : ""}` };
  }

  if (toolName === "grantry/create_tenant") {
    const slug = requireString(args, "target_scope").toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error(`invalid scope: must match ${SLUG_RE} (lowercase letters, digits, '-', '_')`);
    const displayName = args.display_name == null ? undefined : String(args.display_name).trim() || undefined;
    // Match ensureTenant's resolution (workspace-first) so `created` is accurate.
    const existing = await prisma.tenant.findFirst({
      where: ctx.workspaceId ? { workspaceId: ctx.workspaceId, slug } : { ownerId: ctx.ownerId, slug, workspaceId: null },
      select: { id: true },
    });
    const tenant = await ensureTenant(ctx.ownerId, slug, displayName, ctx.workspaceId);
    const payload = {
      scope: tenant.slug,
      display_name: tenant.displayName,
      created: !existing,
      note: existing
        ? "tenant already existed; left untouched"
        : "tenant created. Add a connection with grantry_create_connection (PAT providers) or the dashboard (OAuth providers), then grant it with grantry_grant_scope.",
    };
    return { payload, summary: `${existing ? "found existing" : "created"} tenant ${tenant.slug}` };
  }

  if (toolName === "grantry/create_agent") {
    const name = requireString(args, "name");
    if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid name: must match ${AGENT_NAME_RE}`);
    const charter = args.charter == null ? null : String(args.charter).trim() || null;
    const scopes = Array.isArray(args.scopes) ? args.scopes.map((s) => String(s)) : [];
    if ((args as any).full_scope_manager) {
      throw new Error("full_scope_manager agents can only be created from the dashboard");
    }
    const existing = await prisma.agent.findUnique({ where: { name }, select: { id: true } });
    if (existing) throw new Error(`agent name already exists: ${name} — pick another name`);

    const { token, tokenHash, tokenPrefix } = mintAgentToken();
    const agentRow = await prisma.agent.create({
      data: {
        name,
        description: charter,
        hashedToken: tokenHash,
        tokenPrefix,
        ownerId: ctx.ownerId,
        workspaceId: ctx.workspaceId,
      },
    });
    let granted = 0;
    for (const scope of scopes) {
      const conns = await grantableConnectionsAtScope(ctx, scope);
      if (!conns.length) continue;
      const res = await prisma.agentConnectionGrant.createMany({
        data: conns.map((cn) => ({ agentId: agentRow.id, connectionId: cn.id })),
        skipDuplicates: true,
      });
      granted += res.count;
    }
    const grantedScopes = await agentScopes(agentRow.id);
    const missing = scopes.filter((s) => !grantedScopes.includes(s));
    const payload = {
      agent_id: agentRow.id,
      name: agentRow.name,
      charter: agentRow.description,
      token,
      token_note: "shown once — store it now; only its hash is persisted",
      granted_connections: granted,
      scopes: grantedScopes,
      ...(missing.length ? { scopes_without_connections: missing.sort() } : {}),
    };
    return { payload, summary: `created agent ${agentRow.name} (${granted} connection grant(s), scopes: ${grantedScopes.join(", ") || "none"})` };
  }

  if (toolName === "grantry/update_agent") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const data: Record<string, unknown> = {};
    if (typeof args.enabled === "boolean") data.enabled = args.enabled;
    if (args.charter !== undefined) {
      data.description = args.charter == null ? null : String(args.charter).trim() || null;
    }
    if ((args as any).full_scope_manager !== undefined) {
      throw new Error("full_scope_manager can only be changed from the dashboard");
    }
    if (!Object.keys(data).length) throw new Error("nothing to update: pass 'enabled' and/or 'charter'");
    const updated = await prisma.agent.update({ where: { id: target.id }, data });
    const payload = {
      agent_id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      charter: updated.description,
    };
    return { payload, summary: `updated agent ${updated.name} (${Object.keys(data).join(", ")})` };
  }

  if (toolName === "grantry/delete_agent") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));

    // Deletion is the one admin action with no undo: the token hash goes with
    // the row, so a deleted agent can never be re-enabled — only recreated with
    // a new token. Three refusals keep that from happening by accident.
    if (target.enabled) {
      throw new Error(
        `agent ${target.name} is still enabled — disable it first (grantry_update_agent enabled:false), confirm nothing broke, then delete. Deletion cannot be undone.`,
      );
    }
    // grantry_admin is not a column: it means "holds a grantry-provider
    // connection", i.e. this agent can drive these admin tools itself.
    const holdsAdminKey = await prisma.agentConnectionGrant.count({
      where: { agentId: target.id, connection: { provider: "grantry" } },
    });
    if (target.fullScopeManager || holdsAdminKey > 0) {
      throw new Error(
        `agent ${target.name} holds workspace-wide authority (${target.fullScopeManager ? "full_scope_manager" : "grantry admin key"}) — delete it from the dashboard, where a human confirms it.`,
      );
    }

    // AuditLog.agentId is SetNull on delete, so the agent's history survives the
    // row but loses its name. Record who this was *before* deleting, otherwise
    // those entries become anonymous and the trail is unreadable.
    const scopes = await agentScopes(target.id);
    const grants = await prisma.agentConnectionGrant.count({ where: { agentId: target.id } });
    const assignments = await prisma.agentAssignment.count({ where: { agentId: target.id } });

    await prisma.agent.delete({ where: { id: target.id } });

    const payload = {
      agent_id: target.id,
      name: target.name,
      token_prefix: target.tokenPrefix,
      last_used_at: target.lastUsedAt,
      deleted: true,
      removed_connection_grants: grants,
      removed_assignments: assignments,
      scopes_at_deletion: scopes,
    };
    return {
      payload,
      // The summary is what stays legible in the audit log after agentId is nulled.
      summary: `deleted agent ${target.name} (${target.id}, token ${target.tokenPrefix}…, last used ${target.lastUsedAt ? target.lastUsedAt.toISOString() : "never"}; removed ${grants} connection grant(s), ${assignments} assignment(s), scopes: ${scopes.join(", ") || "none"})`,
    };
  }

  if (toolName === "grantry/assign_agent") {
    const workspaceId = requireWorkspace(ctx);
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    if (target.workspaceId !== workspaceId) throw new Error(`agent is not in this workspace: ${target.id}`);
    if (!target.enabled) throw new Error(`agent is disabled: ${target.name} (${target.id})`);
    const member = await targetWorkspaceMember(ctx, args);
    const notify = optionalBoolean(args, "notify", true);
    const created = await prisma.agentAssignment
      .create({ data: { agentId: target.id, userId: member.userId } })
      .then(() => true)
      .catch((err: any) => {
        if (err?.code === "P2002") return false;
        throw err;
      });

    let notification: "sent" | "skipped" | "already_assigned" | "failed" = created ? "skipped" : "already_assigned";
    if (created && notify) {
      try {
        const admin = await prisma.user.findUnique({ where: { id: ctx.ownerId }, select: { email: true } });
        const body = agentAssignedEmail({
          recipientName: member.user.name || null,
          assignedByEmail: admin?.email ?? "grantry admin",
          agentId: target.id,
          agentName: target.name,
          charter: target.description,
          workspaceName: member.workspace.displayName,
          baseUrl: dashboardOrigin(),
        });
        await sendSystemEmail({ to: member.user.email, ...body });
        notification = "sent";
      } catch (err) {
        notification = "failed";
        console.error("[grantry admin] assignment email failed:", err);
      }
    }

    const payload = {
      agent_id: target.id,
      name: target.name,
      user_id: member.user.id,
      user_email: member.user.email,
      user_name: member.user.name,
      assigned: true,
      created,
      already_assigned: !created,
      notification,
    };
    return {
      payload,
      summary: `${created ? "assigned" : "already assigned"} agent ${target.name} to ${member.user.email}`,
    };
  }

  if (toolName === "grantry/unassign_agent") {
    const workspaceId = requireWorkspace(ctx);
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    if (target.workspaceId !== workspaceId) throw new Error(`agent is not in this workspace: ${target.id}`);
    const member = await targetWorkspaceMember(ctx, args);
    const res = await prisma.agentAssignment.deleteMany({
      where: { agentId: target.id, userId: member.userId, agent: { workspaceId } },
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      user_id: member.user.id,
      user_email: member.user.email,
      user_name: member.user.name,
      assigned: false,
      revoked: res.count > 0,
      already_unassigned: res.count === 0,
    };
    return {
      payload,
      summary: `${res.count > 0 ? "unassigned" : "already unassigned"} agent ${target.name} from ${member.user.email}`,
    };
  }

  if (toolName === "grantry/set_runbook") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    if (args.markdown === undefined) {
      throw new Error("'markdown' is required (pass an empty string to clear the runbook)");
    }
    const markdown = (args.markdown == null ? "" : String(args.markdown)).trim();
    const updated = await prisma.agent.update({
      where: { id: target.id },
      // Setting a single-file SKILL.md replaces the runbook wholesale: clear any
      // previously uploaded skill bundle so grantry_get_runbook serves exactly
      // this text and doesn't list stale bundled files. Multi-file bundles stay
      // a dashboard-only upload.
      data: { runbookMarkdown: markdown || null, runbookBundle: null },
    });
    const payload = {
      agent_id: updated.id,
      name: updated.name,
      runbook_chars: markdown.length,
      cleared: markdown.length === 0,
    };
    return {
      payload,
      summary: markdown.length
        ? `set runbook for agent ${updated.name} (${markdown.length} chars; any skill bundle cleared)`
        : `cleared runbook for agent ${updated.name}`,
    };
  }

  if (toolName === "grantry/rotate_agent_token") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const { token, tokenHash, tokenPrefix } = mintAgentToken();
    await prisma.agent.update({
      where: { id: target.id },
      data: { hashedToken: tokenHash, tokenPrefix, lastUsedAt: null },
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      token,
      token_note: "shown once — the previous token is now invalid",
    };
    return { payload, summary: `rotated token for agent ${target.name}` };
  }

  if (toolName === "grantry/grant_scope") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const scope = requireString(args, "target_scope");
    const conns = await grantableConnectionsAtScope(ctx, scope);
    if (!conns.length) throw new Error(`no grantable enabled connection at scope ${scope} — create one first (grantry_create_connection or dashboard). Note: grantry admin connections can only be granted from the dashboard.`);
    const res = await prisma.agentConnectionGrant.createMany({
      data: conns.map((cn) => ({ agentId: target.id, connectionId: cn.id })),
      skipDuplicates: true,
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      scope,
      granted_connections: res.count,
      already_granted: conns.length - res.count,
      scopes: await agentScopes(target.id),
    };
    return { payload, summary: `granted scope ${scope} to agent ${target.name} (${res.count} new grant(s))` };
  }

  if (toolName === "grantry/grant_connection") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const conn = await targetConnection(ctx, requireString(args, "target_connection_id"));
    assertConnectionGrantable(conn.provider);
    if (!conn.enabled) throw new Error(`connection ${conn.id} (${conn.provider} @ ${conn.scope}) is disabled`);
    const res = await prisma.agentConnectionGrant.createMany({
      data: [{ agentId: target.id, connectionId: conn.id }],
      skipDuplicates: true,
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      connection_id: conn.id,
      provider: conn.provider,
      scope: conn.scope,
      granted: res.count > 0,
      already_granted: res.count === 0,
      scopes: await agentScopes(target.id),
    };
    return {
      payload,
      summary: `granted connection ${conn.provider} @ ${conn.scope} (${conn.id}) to agent ${target.name}`,
    };
  }

  if (toolName === "grantry/revoke_connection") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const conn = await targetConnection(ctx, requireString(args, "target_connection_id"));
    const res = await prisma.agentConnectionGrant.deleteMany({
      where: { agentId: target.id, connectionId: conn.id },
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      connection_id: conn.id,
      provider: conn.provider,
      scope: conn.scope,
      revoked: res.count > 0,
      scopes: await agentScopes(target.id),
    };
    return {
      payload,
      summary: `revoked connection ${conn.provider} @ ${conn.scope} (${conn.id}) from agent ${target.name}`,
    };
  }

  if (toolName === "grantry/set_connection_enabled") {
    const conn = await targetConnection(ctx, requireString(args, "target_connection_id"));
    if (typeof args.enabled !== "boolean") throw new Error("enabled must be a boolean");
    const enabled = args.enabled;
    if (conn.enabled === enabled) {
      return {
        payload: { connection_id: conn.id, provider: conn.provider, scope: conn.scope, label: conn.label, enabled, changed: false },
        summary: `connection ${conn.provider} @ ${conn.scope} (${conn.id}) already enabled=${enabled}`,
      };
    }
    // 同じ (provider, scope) を有効に戻すと、他方も有効なら checkPolicy が
    // ambiguous を返すようになる。戻す側で気づけるよう件数を返す。
    const siblingsEnabled = await prisma.connection.count({
      where: { ...boundaryWhere(ctx), provider: conn.provider, scope: conn.scope, enabled: true, id: { not: conn.id } },
    });
    await prisma.connection.update({ where: { id: conn.id }, data: { enabled } });
    const payload = {
      connection_id: conn.id,
      provider: conn.provider,
      scope: conn.scope,
      label: conn.label,
      enabled,
      changed: true,
      other_enabled_at_same_scope: siblingsEnabled,
    };
    return {
      payload,
      summary: `set connection ${conn.provider} @ ${conn.scope} (${conn.id}) enabled=${enabled}`,
    };
  }

  if (toolName === "grantry/revoke_scope") {
    const target = await targetAgent(ctx, requireString(args, "agent_id"));
    const scope = requireString(args, "target_scope");
    const res = await prisma.agentConnectionGrant.deleteMany({
      where: { agentId: target.id, connection: { scope, ...boundaryWhere(ctx) } },
    });
    const payload = {
      agent_id: target.id,
      name: target.name,
      scope,
      revoked_connections: res.count,
      scopes: await agentScopes(target.id),
    };
    return { payload, summary: `revoked scope ${scope} from agent ${target.name} (${res.count} grant(s) removed)` };
  }

  if (toolName === "grantry/create_connection") {
    const provider = requireString(args, "provider").toLowerCase();
    const scope = requireString(args, "target_scope").toLowerCase();
    const reuseConnectionId = String(args.reuse_connection_id ?? "").trim();
    if (reuseConnectionId && String(args.credential ?? "").trim()) {
      throw new Error("pass either credential (a new key) or reuse_connection_id (share an existing connection's key), not both");
    }
    const credential = reuseConnectionId ? "" : requireString(args, "credential");
    if (!SLUG_RE.test(scope)) throw new Error(`invalid scope: must match ${SLUG_RE}`);
    if (provider === "grantry") {
      throw new Error("grantry admin connections are created from the dashboard only (mint a key on /api-keys and add it via the connection wizard) — admin access cannot be spread by admin tools");
    }
    const providerDef = await getProviderForWorkspace(provider, ctx.workspaceId);
    if (!providerDef || providerDef.implemented === false) throw new Error(`provider not implemented: ${provider}`);

    if (reuseConnectionId) {
      // Same thing the dashboard's "Use existing: <label> (<scope>)" option
      // does: a new connection at the target scope that shares the source
      // connection's ProviderCredential. The key never travels through the
      // agent — only the source connection id does.
      const source = await prisma.connection.findFirst({
        where: { id: reuseConnectionId, ...boundaryWhere(ctx) },
      });
      if (!source) throw new Error(`connection not found in this workspace: ${reuseConnectionId}`);
      if (source.provider !== provider) throw new Error(`reuse_connection_id ${source.id} is a ${source.provider} connection, not ${provider}`);
      if (source.authType === "oauth") throw new Error("existing connection reuse is only supported for PAT/API-key connections; OAuth connections need their own consent flow (dashboard)");
      if (!source.enabled) throw new Error(`connection ${source.id} (${source.provider} @ ${source.scope}) is disabled`);
      const tenant = await ensureTenant(ctx.ownerId, scope, undefined, ctx.workspaceId);
      const conn = await createTenantConnectionFromCredential({ tenant, sourceConnection: source, createdById: ctx.ownerId });
      // Dashboard parity: every agent that already reaches this scope gets the
      // new connection too, so a rotated/deleted provider comes back for the
      // whole scope instead of one agent. Pass grant_to_scope_agents=false to
      // create it ungranted.
      const grantedAgents: Array<{ agent_id: string; name: string }> = [];
      if (args.grant_to_scope_agents !== false) {
        const agents = await prisma.agent.findMany({
          where: { ...boundaryWhere(ctx), enabled: true, connectionGrants: { some: { connection: { scope } } } },
          select: { id: true, name: true },
        });
        for (const agent of agents) {
          const res = await prisma.agentConnectionGrant.createMany({
            data: [{ agentId: agent.id, connectionId: conn.id }],
            skipDuplicates: true,
          });
          if (res.count > 0) grantedAgents.push({ agent_id: agent.id, name: agent.name });
        }
      }
      const payload = {
        connection_id: conn.id,
        provider: conn.provider,
        auth_type: conn.authType,
        scope: conn.scope,
        label: conn.label,
        reused_from: { connection_id: source.id, label: source.label, scope: source.scope },
        credential_status: credentialStatusFromMetadata(conn.credentialMetadata),
        granted_agents: grantedAgents,
        note: grantedAgents.length
          ? "shares the source connection's stored credential; granted to every enabled agent that already had a connection at this scope."
          : "shares the source connection's stored credential. Grant it to an agent with grantry_grant_scope or grantry_grant_connection.",
      };
      return { payload, summary: `created ${provider} connection at scope ${scope} reusing ${source.label} (${source.scope}); granted to ${grantedAgents.length} agent(s)` };
    }
    const authType = args.auth_type ? String(args.auth_type) : (providerDef.authTypes.find((t) => t !== "oauth") ?? "pat");
    if (authType === "oauth") {
      throw new Error(`oauth connections require a browser consent flow — use the dashboard (/tenants/${scope}/edit). Pass a PAT/API key here instead${providerDef.tokenUrl ? ` (get one at ${providerDef.tokenUrl})` : ""}.`);
    }
    if (!providerDef.authTypes.includes(authType as any)) {
      throw new Error(`provider ${provider} does not support auth_type=${authType} (supported: ${providerDef.authTypes.join(", ")})`);
    }
    const label = args.label ? String(args.label).trim() : `${provider}-${scope}-${authType}`;

    const tenant = await ensureTenant(ctx.ownerId, scope, undefined, ctx.workspaceId);
    // Multiple connections per (provider, scope) are allowed, but an
    // agent-driven create refuses duplicates unless it labels them —
    // unlabeled duplicates just make every call ambiguous (checkPolicy would
    // demand connection_id).
    const existing = await prisma.connection.findFirst({
      where: { ...boundaryWhere(ctx), provider, scope, authType, enabled: true },
      select: { id: true, label: true },
    });
    if (existing && !args.label) {
      throw new Error(`a ${provider} (${authType}) connection already exists at scope ${scope} (connection_id=${existing.id}, label=${existing.label}) — pass a distinct 'label' to add another, or rotate the existing one from the dashboard`);
    }
    const credentialMeta = await credentialMetadataForStorage(provider, authType, credential);
    const conn = await prisma.connection.create({
      data: {
        provider,
        authType,
        label,
        scope,
        tenantId: tenant.id,
        ownerId: ctx.ownerId,
        workspaceId: tenant.workspaceId ?? ctx.workspaceId,
        encryptedCredential: encrypt(credential),
        ...connectionCredentialData(credentialMeta),
      },
    });
    const payload = {
      connection_id: conn.id,
      provider: conn.provider,
      auth_type: conn.authType,
      scope: conn.scope,
      label: conn.label,
      credential_status: (credentialMeta as any)?.status ?? "unknown",
      note: "credential stored encrypted. Grant it to an agent with grantry_grant_scope.",
    };
    return { payload, summary: `created ${provider} (${authType}) connection at scope ${scope}` };
  }

  if (toolName === "grantry/get_connect_url") {
    const provider = requireString(args, "provider").toLowerCase();
    const scope = requireString(args, "target_scope").toLowerCase();
    if (!SLUG_RE.test(scope)) throw new Error(`invalid scope: must match ${SLUG_RE}`);
    const origin = dashboardOrigin();

    // grantry admin keys are minted + connected on the dashboard only.
    if (provider === "grantry") {
      return {
        payload: {
          provider,
          scope,
          url: `${origin}/api-keys`,
          auth: "dashboard-only",
          instructions: `Open ${origin}/api-keys, mint a gn_adm_ admin key, then add it as a connection at scope "${scope}" from the dashboard. grantry admin access is never wired up over MCP.`,
        },
        summary: `connect url (grantry admin) for scope ${scope}`,
      };
    }

    const providerDef = await getProviderForWorkspace(provider, ctx.workspaceId);
    if (!providerDef || providerDef.implemented === false) throw new Error(`provider not implemented: ${provider}`);

    const supportsOauth = providerDef.authTypes.includes("oauth");
    // 既に同じ scope に有効な OAuth 接続があるなら「付け直し（reconnect）」の URL を返す。新規接続の URL を渡すと
    // 同じ (provider, scope) に有効な接続が 2 本並び、connection_id を渡さない呼び出しが全部 ambiguous で落ちる
    // （2026-09-15 google_gsc@seo-marketer で実測。書き込みスコープ付与のための付け直しが新規作成になった）。
    if (supportsOauth) {
      const existing = await prisma.connection.findMany({
        where: { ...boundaryWhere(ctx), provider, scope, authType: "oauth", enabled: true },
        orderBy: { createdAt: "desc" },
        select: { id: true, label: true },
      });
      if (existing.length === 1) {
        const cn = existing[0];
        const reconnectUrl = `${origin}/oauth/${encodeURIComponent(provider)}/start?tenant=${encodeURIComponent(scope)}&reauth=1&connection_id=${encodeURIComponent(cn.id)}`;
        return {
          payload: {
            provider,
            scope,
            url: reconnectUrl,
            auth: "oauth-reconnect",
            connection_id: cn.id,
            label: cn.label,
            new_connection_url: `${origin}/tenants/${encodeURIComponent(scope)}/connect/${encodeURIComponent(provider)}`,
            instructions: `An enabled ${providerDef.label} OAuth connection already exists at scope "${scope}" (${cn.label}). Send this URL to a human: it re-runs consent and refreshes that exact connection (new scopes included), so no duplicate connection is created. Use new_connection_url only to add a different account, then disable the old one.`,
          },
          summary: `reconnect url for ${provider} at scope ${scope}`,
        };
      }
    }
    const url = `${origin}/tenants/${encodeURIComponent(scope)}/connect/${encodeURIComponent(provider)}`;
    const supportsPat = providerDef.authTypes.includes("pat");
    const primary = supportsPat ? "paste-credential" : "oauth-consent";
    const instructions = supportsPat
      ? `Send this URL to a human. They sign in to grantry (if needed), paste the ${providerDef.label} credential, and save. The connection is created at scope "${scope}" and auto-granted to that scope's agents.${supportsOauth ? ` (This provider also supports OAuth — append ?method=oauth to the URL to authorize instead of pasting.)` : ""}`
      : `Send this URL to a human. They sign in to grantry (if needed) and click through the ${providerDef.label} authorization. On success the connection is created at scope "${scope}" and granted to that scope's agents.`;

    return {
      payload: {
        provider,
        scope,
        url,
        auth: primary,
        auth_types: providerDef.authTypes,
        token_url: providerDef.tokenUrl ?? null,
        help_text: providerDef.helpText,
        instructions,
      },
      summary: `connect url for ${provider} at scope ${scope}`,
    };
  }

  throw new Error(`Unknown admin tool: ${toolName}`);
}

// ---------- tools/list metadata ----------

export function adminToolDescriptor(toolName: AdminToolName): { description: string; properties: Record<string, unknown>; required: string[] } {
  switch (toolName) {
    case "grantry/list_agents":
      return {
        description: "grantry admin: list every agent in the admin key's workspace with its charter, status, and granted scopes.",
        properties: {},
        required: [],
      };
    case "grantry/list_tenants":
      return {
        description: "grantry admin: list every tenant (scope) in the workspace with its connected providers.",
        properties: {},
        required: [],
      };
    case "grantry/list_connections":
      return {
        description: "grantry admin: list connections in the workspace (id, provider, scope, enabled). Credentials are never returned.",
        properties: {
          target_scope: { type: "string", description: "Optional: only list connections at this scope. (Named target_scope because 'scope' selects the admin connection itself.)" },
        },
        required: [],
      };
    case "grantry/create_tenant":
      return {
        description: "grantry admin: create a tenant (scope). Idempotent — an existing tenant is returned untouched. The scope string is the immutable wire key agents pass in tools/call.",
        properties: {
          target_scope: { type: "string", description: "Immutable slug of the scope to create, e.g. 'acme-prod' (lowercase letters, digits, '-', '_'). (Named target_scope because 'scope' selects the admin connection itself.)" },
          display_name: { type: "string", description: "Optional human-readable name (renameable later). Defaults to the slug." },
        },
        required: ["target_scope"],
      };
    case "grantry/create_agent":
      return {
        description: "grantry admin: create a new agent and mint its gn_agt_ token (returned once — store it immediately). Optionally grant it every enabled connection at the given scopes (grantry admin connections are never auto-granted). Cannot create full_scope_manager agents.",
        properties: {
          name: { type: "string", description: "Globally unique agent name, e.g. 'acme-support-bot'." },
          charter: { type: "string", description: "What this agent is for, in plain language. Surfaced to grantry_find_agent for routing." },
          scopes: { type: "array", items: { type: "string" }, description: "Tenant scopes to grant: the agent gets every enabled non-admin connection at each scope. Omit to create with no grants." },
        },
        required: ["name"],
      };
    case "grantry/update_agent":
      return {
        description: "grantry admin: enable/disable an agent or update its charter.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          enabled: { type: "boolean", description: "Enable or disable the agent's token." },
          charter: { type: "string", description: "New charter text (empty string clears it)." },
        },
        required: ["agent_id"],
      };
    case "grantry/delete_agent":
      return {
        description: "grantry admin: permanently delete a disabled agent. There is no undo — the token hash goes with the row, so the agent can only be recreated with a new token. Refuses an agent that is still enabled (disable it first with grantry_update_agent, confirm nothing broke, then delete), and refuses full_scope_manager / grantry_admin agents (delete those from the dashboard). The agent's audit-log entries are kept; the deletion itself is recorded with the agent's name and token prefix so the trail stays readable.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents). The agent must already be disabled." },
        },
        required: ["agent_id"],
      };
    case "grantry/assign_agent":
      return {
        description: "grantry admin: assign an enabled agent to one workspace member so that person's user-mode MCP token may act through it. Idempotent. Sends the same assignment email as the dashboard unless notify=false.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents). The agent must live in the admin key's workspace." },
          user_id: { type: "string", description: "Workspace member user id. Pass either user_id or user_email." },
          user_email: { type: "string", description: "Workspace member email. Pass either user_id or user_email." },
          notify: { type: "boolean", description: "Whether to email the assigned user on a new assignment. Defaults to true. Duplicate assignments never email." },
        },
        required: ["agent_id"],
      };
    case "grantry/unassign_agent":
      return {
        description: "grantry admin: remove one person's assignment to an agent in this workspace. The person's existing user-mode MCP token loses access on the next request. Idempotent.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents). The agent must live in the admin key's workspace." },
          user_id: { type: "string", description: "Workspace member user id. Pass either user_id or user_email." },
          user_email: { type: "string", description: "Workspace member email. Pass either user_id or user_email." },
        },
        required: ["agent_id"],
      };
    case "grantry/set_runbook":
      return {
        description: "grantry admin: set an agent's single-file runbook — the SKILL.md served over grantry_get_runbook so the agent is usable by its MCP token alone (no repo handoff). Pass the full Markdown; it replaces any existing runbook and clears any uploaded skill bundle. An empty string clears the runbook. To attach a multi-file .skill/.zip bundle, use the dashboard.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          markdown: { type: "string", description: "The full runbook Markdown (a Claude Code SKILL.md). Empty string clears it. Any previously uploaded skill bundle is removed." },
        },
        required: ["agent_id", "markdown"],
      };
    case "grantry/rotate_agent_token":
      return {
        description: "grantry admin: rotate an agent's token. The new gn_agt_ token is returned once; the old token stops working immediately.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
        },
        required: ["agent_id"],
      };
    case "grantry/grant_scope":
      return {
        description: "grantry admin: grant an agent every enabled connection at a scope (grantry admin connections excluded — those are granted from the dashboard only). Idempotent.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          target_scope: { type: "string", description: "Scope whose connections to grant. (Named target_scope because 'scope' selects the admin connection itself.)" },
        },
        required: ["agent_id", "target_scope"],
      };
    case "grantry/revoke_scope":
      return {
        description: "grantry admin: remove an agent's connection grants at a scope.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          target_scope: { type: "string", description: "Scope whose grants to remove. (Named target_scope because 'scope' selects the admin connection itself.)" },
        },
        required: ["agent_id", "target_scope"],
      };
    case "grantry/grant_connection":
      return {
        description: "grantry admin: grant an agent ONE connection, by connection id — the least-privilege alternative to grant_scope when the agent needs a single tool out of a scope that also holds unrelated credentials. Get ids from grantry_list_connections. Idempotent. Providers controlling money, mail, identity, or infrastructure (stripe, gmail, google_admin, cloudflare, railway, aws, …) are refused here: grant those from the dashboard, or scope-wide with grant_scope.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          target_connection_id: { type: "string", description: "Connection id to grant (from grantry_list_connections). (Named target_connection_id because 'connection_id' selects the admin connection itself.)" },
        },
        required: ["agent_id", "target_connection_id"],
      };
    case "grantry/revoke_connection":
      return {
        description: "grantry admin: remove an agent's grant to ONE connection, by connection id. Use it to trim an over-broad grant_scope down to what the agent actually needs, without dropping the whole scope.",
        properties: {
          agent_id: { type: "string", description: "Agent id (from grantry_list_agents)." },
          target_connection_id: { type: "string", description: "Connection id to revoke (from grantry_list_connections). (Named target_connection_id because 'connection_id' selects the admin connection itself.)" },
        },
        required: ["agent_id", "target_connection_id"],
      };
    case "grantry/create_connection":
      return {
        description: "grantry admin: register a PAT/API-key credential as a connection at a scope (creates the tenant if needed), OR share an existing PAT connection's stored credential with another scope via reuse_connection_id (the key never passes through the agent; new connection is auto-granted to the scope's existing agents unless grant_to_scope_agents=false). The credential is encrypted at rest and never returned. OAuth providers and grantry admin connections must be added from the dashboard.",
        properties: {
          provider: { type: "string", description: "Provider key, e.g. 'github', 'notion', 'attio' (see grantry_get_providers)." },
          target_scope: { type: "string", description: "Scope for the new connection; created if missing. (Named target_scope because 'scope' selects the admin connection itself.)" },
          credential: { type: "string", description: "The PAT / API key / token. Redacted from audit logs. Omit when reuse_connection_id is given." },
          reuse_connection_id: { type: "string", description: "Existing enabled PAT connection (any scope in this workspace, from grantry_list_connections) whose stored credential the new connection should share. Same as the dashboard's 'Use existing:' option; use it after a key rotation to bring a provider back at a scope without re-pasting the key." },
          grant_to_scope_agents: { type: "boolean", description: "reuse_connection_id only. Default true: grant the new connection to every enabled agent that already holds a connection at target_scope." },
          auth_type: { type: "string", description: "Optional auth type. Defaults to the provider's non-OAuth auth type (usually 'pat')." },
          label: { type: "string", description: "Optional display label (new-credential path only)." },
        },
        required: ["provider", "target_scope"],
      };
    case "grantry/set_connection_enabled":
      return {
        description:
          "grantry admin: enable or disable a connection. Disabling keeps the stored credential but takes the connection out of resolution, so calls stop seeing it. " +
          "Use this to retire a superseded credential without deleting it — for example after reconnecting a provider with wider OAuth scopes, when the old and the new connection at the same (provider, scope) make every call ambiguous. Reversible: pass enabled=true to bring it back.",
        properties: {
          target_connection_id: { type: "string", description: "Connection to change (see grantry_list_connections). Named target_connection_id because 'scope' selects the admin connection itself." },
          enabled: { type: "boolean", description: "true to enable, false to disable." },
        },
        required: ["target_connection_id", "enabled"],
      };
    case "grantry/get_connect_url":
      return {
        description: "grantry admin: get a human-facing dashboard URL to connect a provider at a scope. If exactly one enabled OAuth connection already exists there, returns the reconnect URL for it instead (refreshes tokens and scopes in place, no duplicate). Hand the URL to a person who pastes the credential (PAT) or clicks through consent (OAuth); the connection is then created and auto-granted to the scope's agents. Use this instead of asking a human to paste secrets into chat.",
        properties: {
          provider: { type: "string", description: "Provider key, e.g. 'cloudsign', 'github' (see grantry_get_providers)." },
          target_scope: { type: "string", description: "Scope the connection will be created at. (Named target_scope because 'scope' selects the admin connection itself.)" },
        },
        required: ["provider", "target_scope"],
      };
  }
}
