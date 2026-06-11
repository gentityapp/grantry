import { spawn } from "node:child_process";

function run(command, args, { timeoutMs = 30_000, required = false } = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[startup] running: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    const timeout = timeoutMs == null ? null : setTimeout(() => {
        console.error(`[startup] timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`);
        child.kill("SIGTERM");
      }, timeoutMs);
    child.on("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const message = `[startup] command failed (${code ?? signal}): ${command} ${args.join(" ")}`;
      if (required) reject(new Error(message));
      else {
        console.error(`${message}; continuing`);
        resolve();
      }
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (required) reject(err);
      else {
        console.error(`[startup] command error: ${err.message}; continuing`);
        resolve();
      }
    });
  });
}

await run("npx", ["prisma", "generate"], { required: true, timeoutMs: 45_000 });

// Database hardening is best-effort at process start. It must never keep the
// HTTP service down; failed maintenance is visible in logs and can be rerun.
await run("npx", ["prisma", "db", "push", "--accept-data-loss"], { timeoutMs: 30_000 });
await run("node", ["scripts/backfill-auth-types.mjs"], { timeoutMs: 20_000 });
await run("node", ["--import", "tsx/esm", "scripts/backfill-credential-metadata.mjs"], { timeoutMs: 30_000 });
await run("node", ["scripts/backfill-notion-tools.mjs"], { timeoutMs: 20_000 });
await run("node", ["scripts/dedupe-connections.mjs"], { timeoutMs: 20_000 });
await run("node", ["scripts/backfill-tenants.mjs"], { timeoutMs: 20_000 });
await run("node", ["scripts/harden-roles.mjs"], { timeoutMs: 20_000 });

await run("node", ["--import", "tsx/esm", "src/server.ts"], { required: true, timeoutMs: null });
