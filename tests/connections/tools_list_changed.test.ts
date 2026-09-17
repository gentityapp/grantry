import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpSessions, markToolsListSeen, notifyToolsListChanged, sseBodyForNotifications, takePendingToolsListChanged } from "../../src/mcp_sessions.js";

function seedSession(id: string, workspaceId: string | null, ttlMs = 60 * 60 * 1000) {
  const now = Date.now();
  mcpSessions.set(id, {
    principalKey: `agent:${id}`,
    workspaceId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ttlMs,
    pendingToolsListChanged: false,
  });
  return mcpSessions.get(id)!;
}

test("tools/list_changed: notify marks only live sessions of the target workspace", () => {
  const a = seedSession("ws-a-1", "ws_a");
  const a2 = seedSession("ws-a-2", "ws_a");
  const b = seedSession("ws-b-1", "ws_b");
  const stale = seedSession("ws-a-stale", "ws_a", -1000);
  try {
    assert.equal(notifyToolsListChanged("ws_a"), 2);
    assert.equal(a.pendingToolsListChanged, true);
    assert.equal(a2.pendingToolsListChanged, true);
    assert.equal(b.pendingToolsListChanged, false);
    assert.equal(stale.pendingToolsListChanged, false);
  } finally {
    for (const id of ["ws-a-1", "ws-a-2", "ws-b-1", "ws-a-stale"]) mcpSessions.delete(id);
  }
});

test("tools/list_changed: notification is delivered once per change", () => {
  seedSession("s1", "ws_x");
  try {
    assert.equal(notifyToolsListChanged("ws_x"), 1);
    assert.deepEqual(takePendingToolsListChanged("s1"), ["notifications/tools/list_changed"]);
    assert.deepEqual(takePendingToolsListChanged("s1"), []);
  } finally {
    mcpSessions.delete("s1");
  }
});

test("tools/list_changed: re-listing tools clears the pending notification", () => {
  seedSession("s2", "ws_y");
  try {
    notifyToolsListChanged("ws_y");
    markToolsListSeen("s2");
    assert.deepEqual(takePendingToolsListChanged("s2"), []);
  } finally {
    mcpSessions.delete("s2");
  }
});

test("tools/list_changed: GET stream body carries the JSON-RPC notification", () => {
  const body = sseBodyForNotifications(["notifications/tools/list_changed"]);
  assert.match(body, /^event: message\ndata: /);
  const dataLine = body.split("\n").find((l) => l.startsWith("data: "))!;
  assert.deepEqual(JSON.parse(dataLine.slice(6)), { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  assert.match(body, /\n\n$/);
  const empty = sseBodyForNotifications([]);
  assert.ok(!empty.includes("event:"));
});
