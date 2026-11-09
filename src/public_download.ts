import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { request, Agent } from "node:https";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");

blocked.addSubnet("2001::", 32, "ipv6"); // Teredo
blocked.addSubnet("2002::", 16, "ipv6"); // 6to4

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (blocked.check(address, family === 4 ? "ipv4" : "ipv6")) return false;
  // IPv6 must be global unicast; reject mapped/compatible/transition forms.
  if (family === 6 && (!/^[23]/i.test(address))) return false;
  return true;
}

type Resolve = (host: string) => Promise<Array<{ address: string; family: number }>>;
const resolveDns: Resolve = (host) => lookup(host, { all: true });

export async function publicDownloadTarget(raw: string, resolve: Resolve = resolveDns) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("download_url_not_allowed: use public HTTPS without credentials or a custom port");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("download_url_not_allowed: private or internal address");
  }
  return { url, address: addresses[0] };
}

// Public binary downloads carry no provider credential. Pin the validated DNS
// result to the socket, and revalidate every redirect, including its DNS result.
export async function downloadPublicFile(raw: string, maxBytes: number): Promise<Buffer> {
  let current = raw;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const { url, address } = await publicDownloadTarget(current);
    const agent = new Agent({ lookup: ((_host: string, options: any, callback: any) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    }) as any });
    try {
      const result = await new Promise<Buffer | URL>((resolve, reject) => {
        const req = request(url, { agent, headers: { Accept: "*/*" } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
            res.resume();
            try { resolve(new URL(res.headers.location, url)); } catch { reject(new Error("invalid download redirect")); }
            return;
          }
          if ((res.statusCode ?? 500) >= 400) { res.resume(); reject(new Error(`download failed (${res.statusCode})`)); return; }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) { req.destroy(new Error("download exceeds byte limit")); return; }
            chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        });
        const timer = setTimeout(() => req.destroy(new Error("download timed out")), 30_000);
        req.on("close", () => clearTimeout(timer));
        req.on("error", reject);
        req.end();
      });
      if (Buffer.isBuffer(result)) return result;
      current = result.href;
    } finally { agent.destroy(); }
  }
  throw new Error("download redirect limit exceeded");
}
