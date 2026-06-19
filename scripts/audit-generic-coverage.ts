import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS } from "../src/connectors/registry.js";

function normalizeBase(raw: string) {
  return raw.replace(/\/+$/, "");
}

function literalUrls(source: string) {
  const urls = new Set<string>();
  const re = /["'`]((?:https:\/\/)[^"'`\s)>,]+)/g;
  for (const match of source.matchAll(re)) {
    const raw = match[1].replace(/[.;,]+$/, "");
    if (raw.includes("${")) continue;
    try {
      const url = new URL(raw);
      if (url.hostname === "example.com" || url.hostname.endsWith(".example.com")) continue;
      urls.add(normalizeBase(url.toString()));
    } catch {
      // Ignore examples or partial dynamic literals that are not concrete URLs.
    }
  }
  return Array.from(urls).sort();
}

function manifestBases(provider: (typeof PROVIDERS)[string]) {
  const bases = new Set<string>();
  const generic = provider.genericRequest;
  if (!generic) return [];
  if (generic.baseUrl && generic.baseUrl !== "credential.instance_url") bases.add(normalizeBase(generic.baseUrl));
  for (const value of Object.values(generic.baseUrls ?? {})) bases.add(normalizeBase(value));
  return Array.from(bases).sort();
}

function isCovered(url: string, bases: string[]) {
  return bases.some((base) => url === base || url.startsWith(`${base}/`));
}

const errors: string[] = [];

for (const provider of Object.values(PROVIDERS)) {
  if (provider.implemented === false || !provider.genericRequest) continue;
  const file = join(process.cwd(), "src", "connectors", `${provider.key}.ts`);
  if (!existsSync(file)) continue;

  const bases = manifestBases(provider);
  if (!bases.length) continue;

  for (const url of literalUrls(readFileSync(file, "utf8"))) {
    if (!isCovered(url, bases)) {
      errors.push(`${provider.key}: connector URL ${url} is not covered by genericRequest baseUrl/baseUrls (${bases.join(", ")})`);
    }
  }
}

if (errors.length) {
  console.error("Generic request coverage audit failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Generic request coverage audit passed");
