#!/usr/bin/env node
// OSS 化の準備度を機械で測る（運営者 2026-09-16「grantryをマジでOSS化するプロジェクトを走らせてほしい」）。
// 使い方:
//   node scripts/oss-readiness.mjs            # 行ごとに ok / FAIL、未達があれば exit 1
//   node scripts/oss-readiness.mjs --json     # JSON
//   node scripts/oss-readiness.mjs --only <gate名>[,<gate名>]   # イシューの ## verify 用に 1〜数個だけ
// 判定は全部このリポの中身と GitHub の公開状態だけで決める。本番 DB・秘密には触れない。
// 「未達 0 件」が grantryのPO（loop/po）の事業ゴール `goal:oss-readiness`。閾値は緩めない。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REPO = process.env.OSS_PUBLIC_REPO || "gentityapp/grantry"; // 公開先を変えるときはここか env
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? new Set((argv[onlyIdx + 1] || "").split(",").filter(Boolean)) : null;

const gates = [];
function gate(name, pass, detail, fix) {
  if (only && !only.has(name)) return;
  gates.push({ name, pass: !!pass, detail, fix });
}
function sh(cmd, args, opts = {}) {
  try {
    return { rc: 0, out: execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => (exists(p) ? fs.readFileSync(path.join(ROOT, p), "utf8") : "");
const tracked = () => sh("git", ["ls-files"]).out.split("\n").filter(Boolean);
function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (/\.(ts|mjs|js|tsx)$/.test(ent.name)) acc.push(p);
  }
  return acc;
}

// 1. ライセンス（OSI 承認のものだけ。Elastic / BSL は「OSS」ではない）
{
  const txt = read("LICENSE") || read("LICENSE.md") || read("LICENSE.txt");
  const kind = /Apache License/i.test(txt) ? "Apache-2.0" : /MIT License/i.test(txt) ? "MIT" : /GNU AFFERO GENERAL PUBLIC LICENSE/i.test(txt) ? "AGPL-3.0" : /Mozilla Public License/i.test(txt) ? "MPL-2.0" : null;
  gate("license-file", !!kind, kind ? `LICENSE = ${kind}` : (txt ? "LICENSE はあるが OSI 承認のライセンス文ではない" : "LICENSE が無い"),
    "docs/oss/PLAN.md のライセンス節で PO が決め、全文を LICENSE に置く（推奨 Apache-2.0）");
  let pkg = {};
  try { pkg = JSON.parse(read("package.json")); } catch {}
  const lic = pkg.license || "";
  gate("license-field", !!lic && lic !== "UNLICENSED" && (!kind || lic === kind), lic ? `package.json license=${lic}` : "package.json に license が無い",
    "package.json の license を LICENSE と同じ SPDX 識別子にする");
}

// 2. src の中の自社固有の値（連絡先メール・自社ドメイン）。公開後は他社が自分の値で動かす
{
  const re = /rootteam\.co\.jp|one-stream\.jp|ops owner@|@gmail\.com/;
  const hits = [];
  for (const f of walk("src")) {
    read(f).split("\n").forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  gate("src-no-company-values", hits.length === 0, hits.length ? `${hits.length} 行: ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? " …" : ""}` : "src に自社固有の値が無い",
    "連絡先メール・運用ドメイン・自社サービスの既定 URL を環境変数（CONTACT_EMAIL / OPS_DOMAIN / SEMINAR_PORTAL_BASE_URL 等）に移し、既定値は中立な文字列か未設定時の非表示にする");
}

// 3. .env.example が src の読む環境変数を全部載せている（自己ホストする人が最初に読む）
{
  const readVars = new Set();
  for (const f of walk("src")) for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) readVars.add(m[1]);
  const documented = new Set([...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const platform = new Set(["NODE_ENV", "GIT_SHA", "RAILWAY_GIT_COMMIT_SHA"]); // 実行基盤が入れるもの
  const missing = [...readVars].filter((v) => !documented.has(v) && !platform.has(v)).sort();
  gate("env-example-complete", missing.length === 0, missing.length ? `${missing.length} 件が .env.example に無い: ${missing.join(" ")}` : `${readVars.size} 変数すべて .env.example にある`,
    ".env.example に 1 行ずつ（用途 1 行コメント付き・必須か任意かを書く）");
}

// 4. 自己ホスト（Docker で 1 コマンド）
gate("selfhost-docker", exists("Dockerfile") && (exists("docker-compose.yml") || exists("compose.yaml")),
  `Dockerfile=${exists("Dockerfile")} compose=${exists("docker-compose.yml") || exists("compose.yaml")}`,
  "Dockerfile（node:22、npm ci、build、npm start）と Postgres 同梱の compose を置き、`docker compose up` で /health が 200");
gate("readme-selfhost", /^##+\s*Self-?host/im.test(read("README.md")), /^##+\s*Self-?host/im.test(read("README.md")) ? "README に Self-host 節がある" : "README に Self-host 節が無い",
  "README に「## Self-host」節（docker compose の 3 手順・必須の環境変数・最初のログイン）");

// 5. 外部の人が貢献できる形
{
  const files = ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"];
  const missing = files.filter((f) => !exists(f));
  gate("community-files", missing.length === 0, missing.length ? `無い: ${missing.join(", ")}` : "CONTRIBUTING / SECURITY / CODE_OF_CONDUCT がある",
    "3 ファイルを置く（SECURITY は脆弱性の私的報告先と応答期限、CONTRIBUTING は npm run check と test:connections、PR の型）");
  const wf = exists(".github/workflows") ? fs.readdirSync(path.join(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)) : [];
  const hasCheck = wf.some((f) => /npm run check|npm run test:connections/.test(read(`.github/workflows/${f}`)));
  gate("ci-on-pr", hasCheck, hasCheck ? `CI: ${wf.join(", ")}` : "PR で check / test:connections を回す workflow が無い",
    ".github/workflows/ci.yml で pull_request と push(main) に npm ci && npm run check && npm run test:connections");
}

// 6. 履歴に秘密が無い（公開した瞬間に全履歴が見える）
{
  const pat = "(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abp]-[0-9A-Za-z-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk_live_[0-9a-zA-Z]{20,}|shpat_[a-f0-9]{30,}|glpat-[A-Za-z0-9_-]{20}|re_[A-Za-z0-9]{30,}|pat[A-Za-z0-9]{14}\\.[a-f0-9]{60})";
  const log = sh("git", ["log", "-p", "--all", "--no-color"]).out;
  const hits = log.split("\n").filter((l) => new RegExp(pat).test(l) && !/example|placeholder|your_|<|README|\.md:/.test(l));
  gate("history-no-secrets", hits.length === 0, hits.length ? `${hits.length} 行がトークンの形に一致（中身は出さない）` : "全履歴を正規表現で走査、一致 0",
    "一致した行のコミットを特定し、鍵を失効させてから git filter-repo で履歴から消す。公開はその後");
}

// 7. 追跡ファイルに個人のメールが無い（従業員・顧客の個人情報は公開しない）
{
  const re = /[A-Za-z0-9._%+-]+@(rootteam\.co\.jp|one-stream\.jp|gmail\.com)/;
  const hits = [];
  for (const f of tracked()) {
    if (/^(src|tests)\//.test(f) || /package-lock/.test(f)) continue;
    let txt; try { txt = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    txt.split("\n").forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  gate("tracked-no-personal-email", hits.length === 0, hits.length ? `${hits.length} 行: ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? " …" : ""}` : "追跡ファイルに個人メールが無い",
    "行を消すか役割名に置き換える。履歴に残るものは公開前に filter-repo（docs/oss/PLAN.md 手順）");
}

// 8. 公開されている（最後の一歩。PO が切り替える。運営者 2026-09-16 に OSS 化を指示済みなので 4 例外の待ちではない）
{
  const r = sh("gh", ["api", `repos/${PUBLIC_REPO}`, "--jq", "[.visibility,.license.spdx_id,.html_url]|@tsv"]);
  const [vis, spdx, url] = (r.out || "").trim().split("\t");
  gate("repo-public", r.rc === 0 && vis === "public", r.rc === 0 ? `${PUBLIC_REPO}: ${vis}${spdx && spdx !== "null" ? ` (${spdx})` : ""}` : `gh api 失敗: ${r.out.trim().slice(0, 100)}`,
    "上の全 gate が緑になってから docs/oss/PLAN.md「公開の手順」どおりに切り替える");
}

const failed = gates.filter((g) => !g.pass);
if (asJson) {
  console.log(JSON.stringify({ repo: PUBLIC_REPO, unmet: failed.length, gates }, null, 2));
} else {
  for (const g of gates) console.log(`${g.pass ? "ok  " : "FAIL"} ${g.name}: ${g.detail}${g.pass ? "" : `\n      → ${g.fix}`}`);
  console.log(failed.length ? `NOT YET: ${failed.length} 未達（${failed.map((g) => g.name).join(", ")}）` : "ALL GREEN: OSS 化の準備度は全部満たしている");
}
process.exit(failed.length ? 1 : 0);
