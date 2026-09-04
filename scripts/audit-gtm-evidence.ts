import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const ledgerPath = join(root, "docs", "gtm-evidence.md");
const logDir = join(root, "docs", "gtm-evidence-log");
const requiredFields = [
  "Market",
  "Evidence status",
  "Target user",
  "Workflow",
  "Provider stack",
  "First-call proof",
  "Repeat-use proof",
  "Blocker",
  "Next experiment",
  "Evidence artifacts",
];
const validMarkets = new Set(["US", "Japan"]);
const validStatuses = new Set(["not_collected", "first_call_collected", "repeat_use_collected", "failed", "blocked"]);

function fail(message: string) {
  console.error(`GTM evidence audit failed: ${message}`);
  process.exit(1);
}

function read(path: string) {
  return readFileSync(path, "utf8");
}

function field(source: string, name: string) {
  const match = source.match(new RegExp(`^- \\*\\*${name}\\*\\*: (.+)$`, "m"));
  return match?.[1].trim();
}

if (!existsSync(ledgerPath)) fail("docs/gtm-evidence.md is missing");
if (!existsSync(logDir) || !statSync(logDir).isDirectory()) fail("docs/gtm-evidence-log/ is missing");

const ledger = read(ledgerPath);
for (const market of validMarkets) {
  if (!ledger.includes(`| ${market} |`)) fail(`ledger table is missing the ${market} market row`);
}
for (const expected of ["docs/gtm-evidence-log/README.md", "docs/gtm-evidence-log/TEMPLATE.md"]) {
  if (!existsSync(join(root, expected))) fail(`${expected} is missing`);
}

const entryNames = readdirSync(logDir)
  .filter((name) => name.endsWith(".md"))
  .filter((name) => !["README.md", "TEMPLATE.md"].includes(name))
  .sort();
if (!entryNames.length) fail("docs/gtm-evidence-log/ has no evidence entries");

const entriesByMarket = new Map<string, string[]>();
const errors: string[] = [];

for (const name of entryNames) {
  const source = read(join(logDir, name));
  for (const required of requiredFields) {
    if (!field(source, required)) errors.push(`${name}: missing field ${required}`);
  }

  const market = field(source, "Market");
  if (market && !validMarkets.has(market)) errors.push(`${name}: Market must be US or Japan`);

  const status = field(source, "Evidence status");
  if (status && !validStatuses.has(status)) {
    errors.push(`${name}: Evidence status must be one of ${Array.from(validStatuses).join(", ")}`);
  }

  const firstCall = field(source, "First-call proof") ?? "";
  const repeatUse = field(source, "Repeat-use proof") ?? "";
  if (status === "not_collected" && (!firstCall.startsWith("Not collected") || !repeatUse.startsWith("Not collected"))) {
    errors.push(`${name}: not_collected entries must keep both proof fields explicitly Not collected`);
  }
  if (status === "repeat_use_collected" && repeatUse.startsWith("Not collected")) {
    errors.push(`${name}: repeat_use_collected requires a concrete repeat-use proof link or artifact note`);
  }

  if (market) {
    const current = entriesByMarket.get(market) ?? [];
    current.push(name);
    entriesByMarket.set(market, current);
  }
}

for (const market of validMarkets) {
  if (!entriesByMarket.get(market)?.length) errors.push(`no evidence log entry for ${market}`);
}

if (errors.length) {
  console.error("GTM evidence audit failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `GTM evidence audit passed: ${entryNames.length} entr(y/ies), ${entriesByMarket.get("US")?.length ?? 0} US, ${
    entriesByMarket.get("Japan")?.length ?? 0
  } Japan.`,
);
