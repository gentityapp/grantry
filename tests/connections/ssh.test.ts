import assert from "node:assert/strict";
import { test } from "node:test";

import { callSshTool, fingerprintOf, isPrivateAddress, parseSshCredential, type SshConnect, type SshSession } from "../../src/connectors/ssh.js";
import { getProvider } from "../../src/connectors/registry.js";

const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nssh-secret-key-material\n-----END OPENSSH PRIVATE KEY-----";
const PIN = "SHA256:pinnedfingerprint";
const CREDENTIAL = JSON.stringify({ host: "203.0.113.10", username: "deploy", private_key: PRIVATE_KEY, host_key_sha256: PIN });
const publicResolve = async () => ["203.0.113.10"];

function fakeConnect(presentedKey = PIN) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const session: SshSession = {
    hostKeySha256: "",
    async exec(command, options) {
      calls.push({ method: "exec", args: [command, options] });
      return { stdout: Buffer.from(`ran:${command}`), stderr: Buffer.from(""), exitCode: 0, signal: null, timedOut: false };
    },
    async readFile(path, maxBytes) {
      calls.push({ method: "readFile", args: [path, maxBytes] });
      return { data: Buffer.from("hello"), size: 10 };
    },
    async writeFile(path, data, mode) {
      calls.push({ method: "writeFile", args: [path, data.toString("utf8"), mode] });
    },
    async readdir(path) {
      calls.push({ method: "readdir", args: [path] });
      return [{ filename: "b.txt", attrs: { size: 3, mode: 0o100644 } }, { filename: "a", attrs: { size: 0, mode: 0o040755 } }];
    },
    close() {
      calls.push({ method: "close", args: [] });
    },
  };
  const connect: SshConnect = async ({ address, verifyHostKey }) => {
    calls.push({ method: "connect", args: [address] });
    if (!verifyHostKey(presentedKey)) throw new Error("Handshake failed: host key verification failed");
    return session;
  };
  return { calls, connect };
}

test("ssh credential requires host, user and a key or password", () => {
  const cred = parseSshCredential(CREDENTIAL);
  assert.equal(cred.host, "203.0.113.10");
  assert.equal(cred.port, 22);
  assert.equal(cred.hostKeySha256, PIN);
  assert.equal(parseSshCredential(JSON.stringify({ host: "h", user: "u", password: "p", host_key_sha256: "abc=" })).hostKeySha256, "SHA256:abc");
  assert.throws(() => parseSshCredential("not json"), /must be JSON/);
  assert.throws(() => parseSshCredential(JSON.stringify({ host: "h", username: "u" })), /private_key/);
  assert.throws(() => parseSshCredential(JSON.stringify({ host: "h", username: "u", password: "p", port: 70000 })), /port/);
});

test("ssh provider is registered with its tools", () => {
  const provider = getProvider("ssh");
  assert.ok(provider?.implemented);
  assert.deepEqual(provider?.tools, ["ssh/check_connection", "ssh/run_command", "ssh/read_file", "ssh/write_file", "ssh/list_directory"]);
});

test("ssh/run_command runs on the pinned host and closes the session", async () => {
  const { calls, connect } = fakeConnect();
  const result = await callSshTool("ssh/run_command", { command: "uptime", timeout_seconds: 9999 }, CREDENTIAL, connect, publicResolve);
  assert.equal(result.structuredContent.exit_code, 0);
  assert.equal(result.structuredContent.stdout, "ran:uptime");
  const exec = calls.find((c) => c.method === "exec");
  assert.equal((exec?.args[1] as any).timeoutMs, 300_000);
  assert.equal(calls.at(-1)?.method, "close");
});

test("ssh refuses a host key that does not match the pin", async () => {
  const { connect } = fakeConnect("SHA256:attacker");
  await assert.rejects(callSshTool("ssh/run_command", { command: "id" }, CREDENTIAL, connect, publicResolve), /host key mismatch.*SHA256:attacker/);
});

test("ssh without a pinned host key only allows check_connection, which reports the fingerprint", async () => {
  const unpinned = JSON.stringify({ host: "203.0.113.10", username: "deploy", private_key: PRIVATE_KEY });
  const { calls, connect } = fakeConnect("SHA256:serverkey");
  await assert.rejects(callSshTool("ssh/run_command", { command: "id" }, unpinned, connect, publicResolve), /no pinned host key/);
  assert.equal(calls.length, 0);
  const result = await callSshTool("ssh/check_connection", {}, unpinned, connect, publicResolve);
  assert.equal(result.structuredContent.host_key_sha256, "SHA256:serverkey");
  assert.equal(result.structuredContent.host_key_pinned, false);
  assert.match(String(result.structuredContent.next_step), /host_key_sha256/);
});

test("ssh refuses hosts that resolve to private addresses", async () => {
  const { calls, connect } = fakeConnect();
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.20.1.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.1.2.3"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
    await assert.rejects(callSshTool("ssh/run_command", { command: "id" }, CREDENTIAL, connect, async () => [ip]), /private or internal/);
  }
  assert.equal(isPrivateAddress("203.0.113.10"), false);
  assert.equal(calls.length, 0);
});

test("ssh file tools read, write and list through the session", async () => {
  const { calls, connect } = fakeConnect();
  const read = await callSshTool("ssh/read_file", { path: "/etc/hostname", max_bytes: 5 }, CREDENTIAL, connect, publicResolve);
  assert.deepEqual(read.structuredContent, { path: "/etc/hostname", size: 10, bytes_read: 5, truncated: true, encoding: "utf8", content: "hello" });
  await callSshTool("ssh/write_file", { path: "/tmp/x", content: "aGk=", encoding: "base64", mode: "640" }, CREDENTIAL, connect, publicResolve);
  assert.deepEqual(calls.find((c) => c.method === "writeFile")?.args, ["/tmp/x", "hi", 0o640]);
  const list = await callSshTool("ssh/list_directory", {}, CREDENTIAL, connect, publicResolve);
  assert.deepEqual((list.structuredContent.entries as any[]).map((e) => [e.name, e.is_directory, e.mode]), [["a", true, "755"], ["b.txt", false, "644"]]);
});

test("ssh errors never echo the private key or password", async () => {
  const connect: SshConnect = async () => {
    throw new Error(`cannot parse key ${PRIVATE_KEY}`);
  };
  await assert.rejects(callSshTool("ssh/run_command", { command: "id" }, CREDENTIAL, connect, publicResolve), (error: Error) => {
    assert.doesNotMatch(error.message, /ssh-secret-key-material/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("ssh connects to a real ssh2 server end to end", async () => {
  const ssh2: any = await import("ssh2");
  const { Server, utils } = ssh2.default ?? ssh2;
  const hostKey = utils.generateKeyPairSync("ed25519");
  const clientKey = utils.generateKeyPairSync("ed25519");
  const hostPub = utils.parseKey(hostKey.public).getPublicSSH();
  const allowedPub = utils.parseKey(clientKey.public).getPublicSSH();
  const files = new Map<string, Buffer>();

  const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
    client.on("error", () => {}); // the host-key-mismatch case aborts the handshake from the client side
    client.on("authentication", (ctx: any) => {
      if (ctx.method === "publickey" && ctx.username === "deploy" && Buffer.compare(ctx.key.data, allowedPub) === 0) {
        if (!ctx.signature) return ctx.accept();
        const key = utils.parseKey(clientKey.public);
        return key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept: any) => {
        const session = accept();
        session.on("exec", (acceptExec: any, _reject: any, info: any) => {
          const stream = acceptExec();
          stream.write(`exec:${info.command}`);
          stream.stderr.write("warn");
          stream.exit(3);
          stream.end();
        });
        session.on("sftp", (acceptSftp: any) => {
          const sftp = acceptSftp();
          const { STATUS_CODE, OPEN_MODE } = utils.sftp;
          const handles = new Map<number, { path: string; write: boolean }>();
          let next = 0;
          sftp.on("OPEN", (id: number, path: string, flags: number) => {
            const h = next++;
            const write = Boolean(flags & OPEN_MODE.WRITE);
            if (write) files.set(path, Buffer.alloc(0));
            else if (!files.has(path)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            handles.set(h, { path, write });
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(h);
            sftp.handle(id, buf);
          });
          sftp.on("WRITE", (id: number, handle: Buffer, offset: number, data: Buffer) => {
            const h = handles.get(handle.readUInt32BE())!;
            const cur = files.get(h.path)!;
            const out = Buffer.alloc(Math.max(cur.length, offset + data.length));
            cur.copy(out);
            data.copy(out, offset);
            files.set(h.path, out);
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("READ", (id: number, handle: Buffer, offset: number, length: number) => {
            const h = handles.get(handle.readUInt32BE())!;
            const data = files.get(h.path)!;
            if (offset >= data.length) return sftp.status(id, STATUS_CODE.EOF);
            sftp.data(id, data.subarray(offset, offset + length));
          });
          sftp.on("STAT", (id: number, path: string) => {
            const data = files.get(path);
            if (!data) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(id, { mode: 0o100644, uid: 0, gid: 0, size: data.length, atime: 0, mtime: 0 });
          });
          sftp.on("FSTAT", (id: number, handle: Buffer) => {
            const h = handles.get(handle.readUInt32BE())!;
            sftp.attrs(id, { mode: 0o100644, uid: 0, gid: 0, size: files.get(h.path)!.length, atime: 0, mtime: 0 });
          });
          sftp.on("FSETSTAT", (id: number) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("SETSTAT", (id: number) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("CLOSE", (id: number, handle: Buffer) => {
            handles.delete(handle.readUInt32BE());
            sftp.status(id, STATUS_CODE.OK);
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const fingerprint = fingerprintOf(hostPub);
  const credential = (pin?: string) => JSON.stringify({ host: "127.0.0.1", port, username: "deploy", private_key: clientKey.private, ...(pin ? { host_key_sha256: pin } : {}) });
  process.env.GRANTRY_SSH_ALLOW_PRIVATE = "1";
  try {
    const check = await callSshTool("ssh/check_connection", {}, credential());
    assert.equal(check.structuredContent.host_key_sha256, fingerprint);

    const run = await callSshTool("ssh/run_command", { command: "uname -a" }, credential(fingerprint));
    assert.deepEqual([run.structuredContent.exit_code, run.structuredContent.stdout, run.structuredContent.stderr], [3, "exec:uname -a", "warn"]);

    await callSshTool("ssh/write_file", { path: "/srv/app/.env", content: "A=1\n" }, credential(fingerprint));
    const read = await callSshTool("ssh/read_file", { path: "/srv/app/.env" }, credential(fingerprint));
    assert.equal(read.structuredContent.content, "A=1\n");

    await assert.rejects(callSshTool("ssh/run_command", { command: "id" }, credential("SHA256:wrong")), /host key mismatch/);
  } finally {
    delete process.env.GRANTRY_SSH_ALLOW_PRIVATE;
    server.close();
  }
});
