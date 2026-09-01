// Fails when a t("...") source string used anywhere in src/ has no entry in
// the Japanese dictionary, so untranslated strings can't silently ship and
// render mixed-language pages. Unused dictionary entries are reported as
// warnings only — some are kept intentionally (e.g. locale names).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ja } from "../src/i18n/ja.js";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// Static t() calls only: a first argument that is a plain string or a template
// literal with no ${} interpolation. Dynamic keys can't be audited statically.
const CALL_RE = /\bt\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gs;

// Single-pass, mirroring JS string-literal semantics: each backslash escapes
// exactly the next character, so "\\n" stays a literal backslash + n.
function unescape(raw: string): string {
  return raw.replace(/\\(.)/gs, (_, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch));
}

const usedKeys = new Set<string>();
for (const file of sourceFiles("src")) {
  if (file.endsWith(join("i18n", "ja.ts"))) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(CALL_RE)) {
    if (match[1] === "`" && match[2].includes("${")) continue;
    usedKeys.add(unescape(match[2]));
  }
}

const dictKeys = new Set(Object.keys(ja));
const missing = [...usedKeys].filter((key) => !dictKeys.has(key)).sort();
const unused = [...dictKeys].filter((key) => !usedKeys.has(key)).sort();

if (unused.length) {
  console.warn(`i18n audit: ${unused.length} dictionary entr(y/ies) not referenced by any static t() call (warning only):`);
  for (const key of unused) console.warn(`  - ${JSON.stringify(key)}`);
}

if (missing.length) {
  console.error(`i18n audit: ${missing.length} t() source string(s) missing from src/i18n/ja.ts — Japanese pages will show English for these:`);
  for (const key of missing) console.error(`  - ${JSON.stringify(key)}`);
  process.exit(1);
}

console.log(`i18n audit: OK — ${usedKeys.size} t() keys all have Japanese entries (${dictKeys.size} dictionary entries).`);
