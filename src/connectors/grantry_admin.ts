// grantry-as-a-provider connector: the credential is a gn_adm_ admin API key
// minted by a human on the dashboard (/api-keys). The key decides the
// workspace boundary the admin tools operate on — the presenting agent's own
// identity grants nothing extra, exactly like any other SaaS credential.
import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { callAdminTool, isAdminTool, type AdminContext } from "../admin_tools.js";

export type AdminKeyIdentity = {
  id: string;
  label: string;
  ctx: AdminContext;
};

/** Resolve a plaintext gn_adm_ key to its workspace boundary. */
export async function resolveAdminApiKey(credential: string): Promise<AdminKeyIdentity | null> {
  const key = credential.trim();
  if (!key.startsWith("gn_adm_")) return null;
  const hashedKey = createHash("sha256").update(key).digest("hex");
  const row = await prisma.adminApiKey.findUnique({ where: { hashedKey } });
  if (!row || !row.enabled) return null;
  void prisma.adminApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { id: row.id, label: row.label, ctx: { ownerId: row.ownerId, workspaceId: row.workspaceId } };
}

export async function callGrantryAdminTool(tool: string, args: Record<string, unknown>, token: string) {
  if (!isAdminTool(tool)) throw new Error(`Unknown grantry admin tool: ${tool}`);
  const identity = await resolveAdminApiKey(token);
  if (!identity) {
    throw new Error("invalid or disabled grantry admin API key — mint a new one on the dashboard (/api-keys) and update this connection");
  }
  const { payload, summary } = await callAdminTool(tool, args, identity.ctx);
  return {
    structuredContent: payload,
    // The generic audit path logs auditSummary instead of the payload: results
    // of create_agent / rotate_agent_token carry a one-time gn_agt_ token that
    // must never be persisted.
    auditSummary: summary,
  };
}
