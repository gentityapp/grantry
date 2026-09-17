import { randomUUID } from "node:crypto";

// In-memory MCP session registry, shared by the POST handler (issue/listen)
// and the GET stream that delivers server-initiated notifications (#50).
// Sessions are deliberately tiny: principal identity + expiry + the pending
// notification flag. Nothing here is persisted; a process restart drops
// sessions and clients simply reconnect.
export const MCP_SESSION_TTL_MS = 60 * 60 * 1000;

export type McpSession = {
  principalKey: string;
  workspaceId: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  pendingToolsListChanged: boolean;
};

export const mcpSessions = new Map<string, McpSession>();

export function cleanupExpiredMcpSessions() {
  const now = Date.now();
  for (const [id, session] of mcpSessions) {
    if (session.expiresAt <= now) mcpSessions.delete(id);
  }
}

// resolveWorkspaceId runs only when a NEW session is created, so requests that
// reuse a session never pay a DB read here.
export async function prepareMcpSession(c: any, principalKey: string | null, resolveWorkspaceId?: () => Promise<string | null>) {
  if (!principalKey) return { ok: true as const, sessionId: null as string | null };

  cleanupExpiredMcpSessions();
  const now = Date.now();
  const requestedId = c.req.header("mcp-session-id") ?? c.req.header("Mcp-Session-Id") ?? "";
  if (requestedId) {
    const existing = mcpSessions.get(requestedId);
    if (!existing || existing.expiresAt <= now) {
      return { ok: false as const, status: 404, message: "Mcp-Session-Id is unknown or expired; retry without the header to create a new session" };
    }
    if (existing.principalKey !== principalKey) {
      return { ok: false as const, status: 409, message: "Mcp-Session-Id belongs to a different authenticated principal" };
    }
    existing.lastSeenAt = now;
    existing.expiresAt = now + MCP_SESSION_TTL_MS;
    c.header("Mcp-Session-Id", requestedId);
    return { ok: true as const, sessionId: requestedId };
  }

  const sessionId = randomUUID();
  const workspaceId = resolveWorkspaceId ? await resolveWorkspaceId() : null;
  mcpSessions.set(sessionId, {
    principalKey,
    workspaceId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + MCP_SESSION_TTL_MS,
    pendingToolsListChanged: false,
  });
  c.header("Mcp-Session-Id", sessionId);
  return { ok: true as const, sessionId };
}

// Connection / grant changes call this with the affected workspace so live
// sessions of that workspace re-list tools on their next GET stream (#50).
// Filtering behavior itself is untouched — this only sets a flag.
export function notifyToolsListChanged(workspaceId: string | null | undefined): number {
  if (!workspaceId) return 0;
  const now = Date.now();
  let marked = 0;
  for (const session of mcpSessions.values()) {
    if (session.workspaceId === workspaceId && session.expiresAt > now) {
      session.pendingToolsListChanged = true;
      marked++;
    }
  }
  return marked;
}

// Consumes the pending flag once — the GET stream sends each notification a
// single time.
export function takePendingToolsListChanged(sessionId: string): string[] {
  const session = mcpSessions.get(sessionId);
  if (!session || !session.pendingToolsListChanged) return [];
  session.pendingToolsListChanged = false;
  return ["notifications/tools/list_changed"];
}

// A client that re-lists tools on its own gets a fresh view; the queued push
// would be redundant.
export function markToolsListSeen(sessionId: string | null | undefined) {
  if (!sessionId) return;
  const session = mcpSessions.get(sessionId);
  if (session) session.pendingToolsListChanged = false;
}

// Server-initiated JSON-RPC notifications ride the GET stream in streamable
// HTTP. Rendered synchronously so tests can assert the exact wire shape.
export function sseBodyForNotifications(methods: string[]): string {
  let body = "";
  for (const method of methods) {
    body += `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method })}\n\n`;
  }
  return body + ": end\n\n";
}
