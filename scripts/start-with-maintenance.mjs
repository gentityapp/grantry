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

// Startup must never migrate schemas, restore grants or rewrite credentials.
// Run reviewed maintenance explicitly, after backing up the database.
await run("node", ["--import", "tsx/esm", "src/server.ts"], { required: true, timeoutMs: null });
