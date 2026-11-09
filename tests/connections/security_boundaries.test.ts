import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { maskAuditArgs, auditErrorSummary } from "../../src/audit_redaction.js";
import { delegationBoundaryMatches, consumeDelegationGrant } from "../../src/delegation_security.js";
import { browserBoundary } from "../../src/http_security.js";
import { filesApp } from "../../src/files.js";
import { prisma } from "../../src/db.js";
import { publicDownloadTarget, isPublicAddress } from "../../src/public_download.js";
import { callGenericProviderRequest } from "../../src/connectors/generic_request.js";
import { getProvider } from "../../src/connectors/registry.js";

test("audit redaction removes nested secrets and request payloads while retaining routing metadata", () => {
  const args = { scope: "test", method: "GET", nested: [{ client_secret: "fake-sensitive", refreshToken: "fake-sensitive" }], headers: { Custom: "fake-sensitive" }, query: { x: "fake-sensitive" }, body: "fake-sensitive", message: "value Bearer fake-sensitive" };
  const result = maskAuditArgs(args);
  assert.ok(!result.includes("fake-sensitive"));
  for (const token of ["ntn_synthetic", "secret_synthetic", "re_synthetic"]) assert.ok(!maskAuditArgs({ value: token }).includes(token));
  assert.equal(JSON.parse(result).scope, "test");
  assert.equal(JSON.parse(result).method, "GET");
  const circular: any = {}; circular.self = circular;
  assert.doesNotThrow(() => maskAuditArgs(circular));
  assert.equal(auditErrorSummary('provider_auth_invalid: 401 {"key":"opaque-synthetic-secret"}'), "provider_auth_invalid HTTP 401");
});

test("delegation cannot cross workspaces or redeem one grant twice", async () => {
  const a = { ownerId: "u", workspaceId: "w1" };
  assert.equal(delegationBoundaryMatches(a, { ownerId: "u", workspaceId: "w2" }), false);
  assert.equal(delegationBoundaryMatches(a, { ownerId: "other", workspaceId: "w1" }), false);
  assert.equal(delegationBoundaryMatches(a, a), true);
  const update = prisma.delegationGrant.updateMany;
  let status = "issued";
  try {
    prisma.delegationGrant.updateMany = (async ({ where, data }: any) => {
      assert.ok(where.expiresAt.gt instanceof Date);
      if (where.status !== status) return { count: 0 };
      status = data.status;
      return { count: 1 };
    }) as any;
    assert.deepEqual(await Promise.all([consumeDelegationGrant("g"), consumeDelegationGrant("g")]), [true, false]);
  } finally { prisma.delegationGrant.updateMany = update; }
});

test("foreign browser origins cannot read session responses or mutate dashboard state", async () => {
  const app = new Hono().use("*", browserBoundary);
  app.all("*", (c) => c.json({ ok: true }));
  const foreign = { origin: "https://untrusted.invalid" };
  const get = await app.request("/dashboard", { headers: foreign });
  assert.equal(get.headers.get("access-control-allow-credentials"), null);
  assert.notEqual(get.headers.get("access-control-allow-origin"), foreign.origin);
  assert.equal((await app.request("/agents", { method: "POST", headers: foreign })).status, 403);
  assert.equal((await app.request("/agents", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
  const same = await app.request("/agents", { method: "POST", headers: { origin } });
  assert.equal(same.status, 200);
  assert.equal(same.headers.get("access-control-allow-origin"), origin);
  const mcp = await app.request("/mcp", { method: "POST", headers: foreign });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.headers.get("access-control-allow-origin"), "*");
  assert.equal(mcp.headers.get("access-control-allow-credentials"), null);
});

test("startup does not run schema or permission mutations", async () => {
  const commands: string[] = [];
  const source = readFileSync("scripts/start-with-maintenance.mjs", "utf8").replace('import { spawn } from "node:child_process";', "");
  await vm.runInNewContext(`(async()=>{${source}})()`, {
    spawn: (command: string, args: string[]) => {
      commands.push([command, ...args].join(" "));
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    }, setTimeout, clearTimeout, console: { log() {}, error() {} },
  });
  assert.ok(commands.some((s) => s.endsWith("src/server.ts")));
  assert.ok(commands.every((s) => !/db push|backfill|dedupe|disable-platform|accept-data-loss/.test(s)));
});

test("legacy migration requires opt-in and never promotes agents by name", async () => {
  const source = readFileSync("scripts/backfill-agent-connection-grants.mjs", "utf8").replace('import { PrismaClient } from "@prisma/client";', "");
  let constructed = false;
  const guardContext = { PrismaClient: class { constructor() { constructed = true; } }, process: { argv: [], exit() { throw new Error("guarded"); } }, console: { error() {} } };
  await assert.rejects(vm.runInNewContext(`(async()=>{${source}})()`, guardContext), /guarded/);
  assert.equal(constructed, false);
  let promoted = false;
  const fake = { agentRole: { findMany: async () => [] }, agent: { findMany: async () => [{ name: "full admin", connectionGrants: [] }], update: async () => { promoted = true; } }, $disconnect: async () => {} };
  await vm.runInNewContext(`(async()=>{${source}})()`, { PrismaClient: class { constructor() { return fake; } }, process: { argv: ["--apply"] }, console: { log() {}, error(e: unknown) { throw e; } } });
  assert.equal(promoted, false);
});

test("downloaded active content is an attachment with browser sandboxing", async () => {
  const find = prisma.stagedFile.findUnique, update = prisma.stagedFile.update;
  try {
    prisma.stagedFile.findUnique = (async () => ({ id: "f", downloadTokenHash: createHash("sha256").update("synthetic").digest("hex"), expiresAt: new Date(Date.now() + 60000), bytes: Buffer.from("<script>alert(1)</script>"), contentType: "text/html", filename: "test.html", size: 25 })) as any;
    prisma.stagedFile.update = (async () => ({})) as any;
    const res = await filesApp.request("/f?token=synthetic");
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-disposition")?.startsWith("attachment;"));
    assert.ok(res.headers.get("content-security-policy")?.includes("sandbox;"));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await res.text(), "<script>alert(1)</script>");
  } finally { prisma.stagedFile.findUnique = find; prisma.stagedFile.update = update; }
});

test("upload tickets reject expired agents and concurrent extra redemption", async () => {
  const find = prisma.uploadTicket.findUnique, update = prisma.uploadTicket.updateMany, del = prisma.uploadTicket.delete;
  let used = 0;
  let expired = true;
  try {
    prisma.uploadTicket.findUnique = (async () => ({ id: "t", usedCount: 0, maxUses: 1, expiresAt: new Date(Date.now() + 60000), agent: { id: "a", enabled: true, expiresAt: expired ? new Date(0) : null } })) as any;
    prisma.uploadTicket.updateMany = (async () => ({ count: used++ === 0 ? 1 : 0 })) as any;
    prisma.uploadTicket.delete = (async () => ({})) as any;
    assert.equal((await filesApp.request("/?ticket=synthetic", { method: "POST" })).status, 401);
    assert.equal(used, 0);
    expired = false;
    const results = await Promise.all([1, 2].map(() => filesApp.request("/?ticket=synthetic", { method: "POST" })));
    assert.equal(results.filter((r) => r.status === 401).length, 1);
  } finally { prisma.uploadTicket.findUnique = find; prisma.uploadTicket.updateMany = update; prisma.uploadTicket.delete = del; }
});

test("binary downloads reject private IPs, mapped IPv6 and mixed DNS answers", async () => {
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "fd00::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const url of ["http://example.com/a", "https://127.0.0.1/a", "https://[::ffff:7f00:1]/", "https://user:pass@example.com/a", "https://example.com:8080/a"]) {
    await assert.rejects(publicDownloadTarget(url), /download_url_not_allowed/);
  }
  await assert.rejects(publicDownloadTarget("https://example.com/a", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]), /private or internal/);
  const target = await publicDownloadTarget("https://example.com/a", async () => [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(target.address.address, "8.8.8.8");
});

test("generic transport does not follow redirects with credentials", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => {
      assert.equal(init?.redirect, "error");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await callGenericProviderRequest({ provider: getProvider("github")!, credential: "synthetic", toolName: "github/request", requestArgs: { path: "/user" } });
  } finally { globalThis.fetch = original; }
});
