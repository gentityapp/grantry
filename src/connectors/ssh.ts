// SSH connector - run commands and move files on a server the workspace owns,
// over SSH (`ssh2`). Like Framer this is not an HTTP proxy: every tool call opens
// one SSH session, runs one operation and closes it.
//
// Credential (JSON):
//   {"host":"203.0.113.10","port":22,"username":"deploy",
//    "private_key":"-----BEGIN OPENSSH PRIVATE KEY-----\n...","passphrase":"...",
//    "host_key_sha256":"SHA256:..."}
// `password` may be used instead of `private_key`.
//
// Safety:
// - The server's host key must be pinned (`host_key_sha256`). Without a pin only
//   ssh/check_connection runs, and it reports the fingerprint to pin.
// - Hosts that resolve to private, loopback or link-local addresses are refused so
//   a workspace cannot reach Grantry's own network (set GRANTRY_SSH_ALLOW_PRIVATE=1
//   on self-hosted installs that need it). The connection goes to the checked IP.
// - Secrets (key, passphrase, password) are scrubbed from every error message.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_S = 60;
const MAX_COMMAND_TIMEOUT_S = 300;
const MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_READ_BYTES = 1_000_000;
const MAX_READ_BYTES = 5_000_000;
const MAX_WRITE_BYTES = 5_000_000;

type SshArgs = Record<string, unknown>;

export type SshCredential = {
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
  hostKeySha256?: string;
};

export type SshExecResult = { stdout: Buffer; stderr: Buffer; exitCode: number | null; signal: string | null; timedOut: boolean };
export type SshDirEntry = { filename: string; longname?: string; attrs?: { size?: number; mode?: number; mtime?: number } };

// Minimal surface this connector needs from one open SSH session. Kept
// structural so tests can replace the real ssh2 client.
export type SshSession = {
  hostKeySha256: string;
  exec(command: string, options: { stdin?: string; timeoutMs: number; maxOutputBytes: number }): Promise<SshExecResult>;
  readFile(path: string, maxBytes: number): Promise<{ data: Buffer; size: number }>;
  writeFile(path: string, data: Buffer, mode?: number): Promise<void>;
  readdir(path: string): Promise<SshDirEntry[]>;
  close(): void;
};

/** Opens a session. `verifyHostKey` receives the server key's SHA256 fingerprint and returns whether to proceed. */
export type SshConnect = (target: { address: string; credential: SshCredential; verifyHostKey: (fingerprint: string) => boolean }) => Promise<SshSession>;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeFingerprint(raw: string): string {
  const value = raw.trim().replace(/^SHA256:/i, "").replace(/=+$/, "");
  return value ? `SHA256:${value}` : "";
}

export function fingerprintOf(hostKey: Buffer): string {
  return normalizeFingerprint(createHash("sha256").update(hostKey).digest("base64"));
}

export function parseSshCredential(raw: string): SshCredential {
  const trimmed = String(raw ?? "").trim();
  const shape = '{"host":"...","username":"...","private_key":"-----BEGIN OPENSSH PRIVATE KEY-----...","host_key_sha256":"SHA256:..."}';
  if (!trimmed) throw new Error(`SSH credential is required: ${shape}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`SSH credential must be JSON: ${shape}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`SSH credential must be a JSON object: ${shape}`);
  const host = str(parsed.host ?? parsed.hostname);
  const username = str(parsed.username ?? parsed.user);
  const privateKey = typeof (parsed.private_key ?? parsed.privateKey) === "string" ? String(parsed.private_key ?? parsed.privateKey).trim() : "";
  const password = typeof parsed.password === "string" ? parsed.password : "";
  const passphrase = typeof parsed.passphrase === "string" ? parsed.passphrase : "";
  const portRaw = parsed.port ?? 22;
  const port = Number(portRaw);
  const hostKeySha256 = normalizeFingerprint(str(parsed.host_key_sha256 ?? parsed.hostKeySha256 ?? parsed.host_key_fingerprint));
  if (!host) throw new Error("SSH credential is missing host");
  if (!username) throw new Error("SSH credential is missing username");
  if (!privateKey && !password) throw new Error("SSH credential needs private_key (recommended) or password");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH credential port must be an integer between 1 and 65535");
  return {
    host,
    port,
    username,
    ...(privateKey ? { privateKey: privateKey.replace(/\\n/g, "\n") + "\n" } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(password ? { password } : {}),
    ...(hostKeySha256 ? { hostKeySha256 } : {}),
  };
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

export type SshResolve = (host: string) => Promise<string[]>;

const defaultResolve: SshResolve = async (host) => {
  if (isIP(host)) return [host];
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
};

async function resolveTarget(host: string, resolve: SshResolve): Promise<string> {
  const addresses = await resolve(host);
  if (!addresses.length) throw new Error(`SSH host ${host} did not resolve`);
  if (process.env.GRANTRY_SSH_ALLOW_PRIVATE !== "1") {
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) throw new Error(`SSH host ${host} resolves to a private or internal address (${blocked}); only public hosts are allowed`);
  }
  return addresses[0];
}

const defaultConnect: SshConnect = async ({ address, credential, verifyHostKey }) => {
  const mod: any = await import("ssh2");
  const Client = mod.Client ?? mod.default?.Client;
  const client = new Client();
  // Keep a listener for the whole session: a late socket error must not become
  // an uncaughtException that takes the Grantry process down.
  let lastError: Error | undefined;
  client.on("error", (err: Error) => { lastError = err; });
  await new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", (err: Error) => { client.end(); reject(err); });
    client.once("close", () => reject(lastError ?? new Error("SSH connection closed before it was ready")));
    client.connect({
      host: address,
      port: credential.port,
      username: credential.username,
      privateKey: credential.privateKey,
      passphrase: credential.passphrase,
      password: credential.password,
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => verifyHostKey(fingerprintOf(key)),
    });
  });
  let sftpPromise: Promise<any> | undefined;
  const sftp = () => (sftpPromise ??= new Promise((resolve, reject) => client.sftp((err: Error | undefined, s: any) => (err ? reject(err) : resolve(s)))));
  return {
    hostKeySha256: "",
    exec(command, { stdin, timeoutMs, maxOutputBytes }) {
      return new Promise((resolve, reject) => {
        client.exec(command, (err: Error | undefined, stream: any) => {
          if (err) return reject(err);
          const out: Buffer[] = [];
          const errOut: Buffer[] = [];
          let outBytes = 0;
          let errBytes = 0;
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            try { stream.signal?.("KILL"); } catch { /* ignore */ }
            stream.close();
          }, timeoutMs);
          stream.on("data", (chunk: Buffer) => { if (outBytes < maxOutputBytes) out.push(chunk); outBytes += chunk.length; });
          stream.stderr.on("data", (chunk: Buffer) => { if (errBytes < maxOutputBytes) errOut.push(chunk); errBytes += chunk.length; });
          stream.on("close", (code: number | null, signal: string | null) => {
            clearTimeout(timer);
            resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(errOut), exitCode: code ?? null, signal: signal ?? null, timedOut });
          });
          if (stdin !== undefined) stream.end(stdin);
          else stream.end();
        });
      });
    },
    async readFile(path, maxBytes) {
      const s = await sftp();
      const stats: any = await new Promise((resolve, reject) => s.stat(path, (err: Error | undefined, st: any) => (err ? reject(err) : resolve(st))));
      const size = Number(stats.size ?? 0);
      const length = Math.min(size, maxBytes);
      const handle: Buffer = await new Promise((resolve, reject) => s.open(path, "r", (err: Error | undefined, h: Buffer) => (err ? reject(err) : resolve(h))));
      try {
        const data = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const n: number = await new Promise((resolve, reject) => s.read(handle, data, offset, length - offset, offset, (err: Error | undefined, bytes: number) => (err ? reject(err) : resolve(bytes))));
          if (!n) break;
          offset += n;
        }
        return { data: data.subarray(0, offset), size };
      } finally {
        await new Promise<void>((resolve) => s.close(handle, () => resolve()));
      }
    },
    async writeFile(path, data, mode) {
      const s = await sftp();
      await new Promise<void>((resolve, reject) => s.writeFile(path, data, mode !== undefined ? { mode } : {}, (err: Error | undefined) => (err ? reject(err) : resolve())));
    },
    async readdir(path) {
      const s = await sftp();
      return new Promise((resolve, reject) => s.readdir(path, (err: Error | undefined, list: SshDirEntry[]) => (err ? reject(err) : resolve(list))));
    },
    close() {
      client.end();
    },
  };
};

function scrub(message: string, credential: SshCredential): string {
  let out = message;
  for (const secret of [credential.privateKey?.trim(), credential.passphrase, credential.password]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function decode(buf: Buffer): { text: string; encoding: "utf8" | "base64" } {
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? { text, encoding: "utf8" } : { text: buf.toString("base64"), encoding: "base64" };
}

async function run(tool: string, args: SshArgs, session: SshSession, credential: SshCredential): Promise<Record<string, unknown>> {
  if (tool === "ssh/check_connection") {
    const result = await session.exec("echo ok", { timeoutMs: 15_000, maxOutputBytes: 1024 });
    return {
      ok: result.exitCode === 0,
      host: credential.host,
      port: credential.port,
      username: credential.username,
      host_key_sha256: session.hostKeySha256,
      host_key_pinned: Boolean(credential.hostKeySha256),
      ...(credential.hostKeySha256 ? {} : { next_step: `Pin this server: add "host_key_sha256":"${session.hostKeySha256}" to the credential after confirming it matches the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). Other ssh tools refuse to run until the host key is pinned.` }),
    };
  }

  if (tool === "ssh/run_command") {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) throw new Error("command is required");
    const timeoutS = clampInt(args.timeout_seconds, DEFAULT_COMMAND_TIMEOUT_S, 1, MAX_COMMAND_TIMEOUT_S);
    const stdin = typeof args.stdin === "string" ? args.stdin : undefined;
    const result = await session.exec(command, { stdin, timeoutMs: timeoutS * 1000, maxOutputBytes: MAX_OUTPUT_BYTES });
    return {
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      stdout: result.stdout.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"),
      stderr: result.stderr.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"),
      stdout_truncated: result.stdout.length > MAX_OUTPUT_BYTES,
      stderr_truncated: result.stderr.length > MAX_OUTPUT_BYTES,
    };
  }

  if (tool === "ssh/read_file") {
    const path = str(args.path);
    if (!path) throw new Error("path is required");
    const maxBytes = clampInt(args.max_bytes, DEFAULT_READ_BYTES, 1, MAX_READ_BYTES);
    const { data, size } = await session.readFile(path, maxBytes);
    const { text, encoding } = decode(data);
    return { path, size, bytes_read: data.length, truncated: size > data.length, encoding, content: text };
  }

  if (tool === "ssh/write_file") {
    const path = str(args.path);
    if (!path) throw new Error("path is required");
    if (typeof args.content !== "string") throw new Error("content is required (string)");
    const encoding = args.encoding === "base64" ? "base64" : "utf8";
    const data = Buffer.from(args.content, encoding);
    if (data.length > MAX_WRITE_BYTES) throw new Error(`content is larger than ${MAX_WRITE_BYTES} bytes`);
    let mode: number | undefined;
    if (args.mode !== undefined && args.mode !== null && args.mode !== "") {
      mode = parseInt(String(args.mode), 8);
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('mode must be an octal string such as "644"');
    }
    await session.writeFile(path, data, mode);
    return { ok: true, path, bytes_written: data.length };
  }

  if (tool === "ssh/list_directory") {
    const path = str(args.path) || ".";
    const entries = await session.readdir(path);
    return {
      path,
      entries: entries
        .map((e) => ({ name: e.filename, size: e.attrs?.size, mode: e.attrs?.mode !== undefined ? (e.attrs.mode & 0o7777).toString(8) : undefined, is_directory: e.attrs?.mode !== undefined ? (e.attrs.mode & 0o170000) === 0o040000 : undefined, mtime: e.attrs?.mtime }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  throw new Error(`Unknown SSH tool: ${tool}`);
}

export async function callSshTool(
  tool: string,
  args: SshArgs,
  rawCredential: string,
  connect: SshConnect = defaultConnect,
  resolve: SshResolve = defaultResolve,
) {
  const credential = parseSshCredential(rawCredential);
  if (!credential.hostKeySha256 && tool !== "ssh/check_connection") {
    throw new Error("This SSH connection has no pinned host key. Run ssh/check_connection, confirm the reported host_key_sha256 matches the server, and add it to the credential as \"host_key_sha256\".");
  }
  let session: SshSession | undefined;
  try {
    const address = await resolveTarget(credential.host, resolve);
    let seen = "";
    session = await connect({
      address,
      credential,
      verifyHostKey: (fingerprint) => {
        seen = normalizeFingerprint(fingerprint);
        return !credential.hostKeySha256 || seen === credential.hostKeySha256;
      },
    }).catch((error) => {
      if (credential.hostKeySha256 && seen && seen !== credential.hostKeySha256) {
        throw new Error(`SSH host key mismatch for ${credential.host}: expected ${credential.hostKeySha256}, server presented ${seen}. Refusing to connect.`);
      }
      throw error;
    });
    session.hostKeySha256 = seen;
    const structuredContent = await run(tool, args ?? {}, session, credential);
    return { structuredContent };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(scrub(message, credential));
  } finally {
    try {
      session?.close();
    } catch {
      // the session is gone either way
    }
  }
}
