# grantry の OSS 化（プロジェクト正本）

運営者 2026-09-16「grantryをマジでOSS化するプロジェクトを走らせてほしい」。
指示の原文は `loop/po/directives/2026-09-16-grantryのOSS化.md`。**判断の持ち主は grantryのPO（`loop/po`）**、実装の持ち主は grantryの製品ループ（`loop/product`、イシュー駆動）。
このファイルはプロジェクトの範囲・準備度の測り方・公開の手順の正本。進捗の数字は `node scripts/oss-readiness.mjs` が出す（想像で書かない）。

## 何を「OSS 化」と呼ぶか（完了の定義）

「マジで」＝ソースを見せるだけ（source-available）ではなく、**OSI 承認ライセンスで、公開リポジトリ上で開発が進み、外部からの PR を受けられる状態**。
機械の定義は `scripts/oss-readiness.mjs` の全 gate が緑（`goal:oss-readiness`、grantryのPO の事業ゴール）:

| gate | 満たす条件 | いまの担当 |
|---|---|---|
| license-file / license-field | OSI 承認のライセンス全文が `LICENSE`、`package.json` の `license` が同じ SPDX | PO（ライセンスの決定） |
| src-no-company-values | `src/` に自社ドメイン・連絡先メールのハードコードが 0 行 | 製品ループ |
| env-example-complete | `src/` が読む環境変数がすべて `.env.example` に載っている | 製品ループ |
| selfhost-docker / readme-selfhost | `Dockerfile` ＋ Postgres 同梱の compose、README に Self-host 節 | 製品ループ |
| community-files | CONTRIBUTING / SECURITY / CODE_OF_CONDUCT | 製品ループ |
| ci-on-pr | PR で `npm run check` と `npm run test:connections` が回る | 済（2026-09-16、`.github/workflows/ci.yml`） |
| history-no-secrets | 全履歴にトークンの形の文字列が 0（2026-09-16 実測 0） | 済（毎回測り直す） |
| tracked-no-personal-email | 追跡ファイルに個人メールが 0（2026-09-16 実測 5 行、`HANDOFF-2026-09-04.md`） | 製品ループ（削除）＋PO（履歴） |
| repo-public | 公開リポジトリが `public` | PO（最後の一歩） |

全緑のあとは「外部からの PR を受けられる」を実際に測る（`good first issue` が 3 本以上 open、外部アカウントの PR が 1 本）。それが PO の directive を `done` にする根拠。

## ライセンス（PO が初日に決める。推奨と根拠）

**推奨 Apache-2.0。** 根拠:
- ICP（`PO.md`）は「多数の顧客アカウントを持つ代理店」と「顧客向けエージェントを埋め込む B2B SaaS」。埋め込む側は AGPL を法務で弾くことが多く、採用の入口で失う。
- 権限ゲートウェイは他社の基盤に組み込まれてこそ北極星（governed actions）が増える。組み込み可能性＝寛容ライセンス。
- 特許条項がある（MIT に無い）。同じ層の先行例（Keycloak、Supabase、Infisical など）は寛容ライセンス。
- 守りたいのはコードの秘匿ではなく、認可モデル・コネクタ・ホスト運用（app.grantry.ai）の信頼。ホストの複製リスクは AGPL でなく、ホスト版の運用品質と接続の量で守る。

選ばなかった案: AGPL-3.0（ホスト複製の抑止を最優先する場合。ICP 2 を捨てる判断になる）。Elastic License / BSL は OSI 非承認で「マジで OSS」に当たらないので候補にしない。
PO は上の根拠で 1 つ選び、`LICENSE` と `package.json` を同じ PR で置き、台帳に理由 1 行。運営者に聞き返さない（4 例外に当たらない）。

## 公開の形（PO が決める。推奨と根拠）

**推奨: このリポジトリ `gentityapp/grantry` をそのまま public にする**（履歴込み）。開発・ループ・Railway 連携を動かしたまま公開でき、二重管理が無い。
条件（順番どおり）:
1. `tracked-no-personal-email` を緑にする（`HANDOFF-2026-09-04.md` の従業員 5 名の行を役割名に置換）。
2. 履歴にも同じ行が残るので、公開前に `git filter-repo --replace-text`（メール→役割名）で書き換え、`git push --force`。**履歴の書き換えは取り消せないので PO が 1 日 1 判断として実行し、直前に `git bundle` で全履歴の控えを取る。** 書き換え後、gentity 上のループの作業クローン（`/workspace/grantry-po-work`、`/workspace/grantry-product-work`）は `git fetch && git reset --hard origin/main` で追従させる（ループ艦隊のPO に PLAN の「依頼」節で頼む）。
3. `history-no-secrets` を書き換え後にもう 1 回走らせる。
4. 上の全 gate が緑になった周に `gh repo edit gentityapp/grantry --visibility public --accept-visibility-change-consequences`。
   運営者が 2026-09-16 に OSS 化を指示しているので、**公開そのものは 4 例外の待ちではない**（新しい媒体の判断は済んでいる）。

選ばなかった案: 新しい公開リポジトリに 1 コミットで書き出し、private を上流に残す（ミラー）。外部 PR を private に持ち帰る手間が毎回発生し「開発が公開で進む」にならない。
**（2026-09-17 追記）** 書き換え実行の結果、refs/pull/*（GitHub が closed PR の head として自動保持する参照・削除不能・2026-09-17 実測 208 本以上）の大半に旧履歴の個人情報が残ることが判明した。このため refs/pull の除去（GitHub サポートへの依頼・asks 2026-09-17・kind: 本人）が間に合わない場合の fallback としてミラー案を復活させた（書き換え済み履歴を `gentityapp/grantry-mirror` に push・2026-09-17 済み・private）。判断点は 2026-09-24。下の「公開切替の実行手順」に両方の枝を書いた。
既存の GitHub 組織 `Grantry`（https://github.com/Grantry、2026-08-26 作成、公開リポ 0）は `gentityapp` がメンバーではなく持ち主を確認できない。**自社のものなら公開後に `Grantry/grantry` へ transfer**（GitHub は旧 URL を転送する）。分からないうちは `gentityapp` で公開して止まらない。

## 公開切替の実行手順（判断点 2026-09-24・2026-09-17 追記）

公開切替の窓では、まず当日の共通手順を順に実行し、そのあと枝 A か枝 B のどちらか 1 本だけを実行する。実行は 1 日 1 判断として台帳に記録する。

### 共通手順（当日の先頭）

1. refs/pull の再確認: `git ls-remote origin "refs/pull/*/head" | wc -l` が **0** なら枝 A、**1 以上なら枝 B**（GitHub サポートの返信の有無を台帳に 1 行で書く）。
2. `node scripts/oss-readiness.mjs` で repo-public 以外が全部緑であることを再確認する（1 つでも赤なら公開しない）。
3. **本番の公開連絡先（CONTACT_EMAIL・フッター／プライバシー／利用規約の mailto に表示）が個人アドレスのまま**なら、役割名のアドレスへ差し替える（asks 2026-09-17 で用意を依頼中・期限 09-23）。Railway 変数の変更は再デプロイを伴うので、切替窓の他の手と同じ周に 1 回で済ませる。アドレスが用意できていなくても公開を止めない（サイトの表示は今日と同じで、用意でき次第差し替える）。
4. **枝 A か枝 B を実行する（下）**。
5. 公開の直後（枝の実行の後）に、Security タブの非公開脆弱性報告（Private vulnerability reporting）を有効化する: `gh api -X PUT repos/<公開したリポ>/private-vulnerability-reporting`（Security タブからでもよい）。**private リポジトリでは API が 404 で有効化できない**（2026-09-16 製品ループ実測・2026-09-17 PO が mirror で再実測）ので、この手は必ず公開の後になる。これが無いと SECURITY.md の報告先が成立しない。
6. 公開直後に本番の `/health`・トークン無し POST /mcp が 401・速度の 3 点を測り直し、台帳に書く。

### 枝 A: refs/pull が消えている場合（本リポをそのまま公開）

- `gh repo edit gentityapp/grantry --visibility public --accept-visibility-change-consequences`
- good first issue 3 本（#254〜#256）は本リポ上にあるので追加の手順は不要。

### 枝 B: refs/pull が残っている場合（ミラーを公開・本リポは private 残置）

1. ミラーを当日の main まで更新して push する（`git push mirror main`・ミラーは台帳のみのコミット分遅れていることがある）。
2. `gh repo edit gentityapp/grantry-mirror --visibility public --accept-visibility-change-consequences`
3. `scripts/oss-readiness.mjs` の `OSS_PUBLIC_REPO` 既定を `gentityapp/grantry-mirror` に変える PR を同じ周で出してマージする（verify.py は環境変数を渡さないので、既定の変更で repo-public の測定先が追従する）。
4. 外部の人が入れる受け皿を本リポから付け直す: good first issue 3 本（#254〜#256）をミラーに本文を写して起票（旧イシューは private に残る）・README のリンク先確認。
5. 外部 PR の持ち帰りは 1 本ずつ（ミラー側の PR ブランチを本リポに `git fetch` して cherry-pick するか、パッチとして適用する）。溜めて一括にしない。

## 公開しないもの・気をつけるもの

- 本番の資格情報・`.env`・Railway の変数（もともとリポに無い。`history-no-secrets` が毎回確認）。
- 従業員・顧客の個人名・メール（HANDOFF・台帳・イシュー本文）。PO の PLAN は台帳に個人・顧客を書かない規則を既に持つ。公開後も同じ。
- 自社固有の値は環境変数に（連絡先メール `CONTACT_EMAIL`、運用ドメイン `OPS_DOMAIN`、自社サービスの既定 URL）。**既定値に自社ドメインを残さない。**
- 自社向けコネクタ（`seminar_portal` など自社サービス宛て）は消さなくてよい。README で「例」と位置づけ、既定 URL を環境変数にする。
- `loop/`・`HANDOFF-*.md`・`PO.md` は公開のまま残す（AI エージェントが開発を回している記録そのものが差別化。個人情報だけ落とす）。
- Railway プロジェクト ID・Slack のユーザー ID は秘密ではない（認証無しでは何もできない）。消さない。

## 公開のあと（外部の人が最初に触るもの）

- `README.md`: 1 画面目に「何を制御するか」と Self-host の 3 手順。ホスト版（app.grantry.ai）への導線は残す。
- `good first issue` を 3 本以上（コネクタの追加は `docs/skill.md` と既存コネクタの型があるので外部が入りやすい）。
- 製品マニュアル（gentityapp/grantry-manual、docs.grantry.ai）に Self-host の章を 1 本。持ち主は grantryマニュアルの順位ループ（`grantry-manual-seo`）ではなく PO が起票。
- 公開サイト grantry.ai に GitHub リンク（gentityapp/grantry-site、grantryサイトのPO に依頼）。
- 告知（X・ブログ）は媒体ごとの持ち主に依頼。**告知は OSS 化の完了条件ではない**（全緑と外部 PR が条件）。

## どこで間違えるか

- **製品ループはタイトルに `auth` `token` `secret` `deploy` `scope` `credential` などの語があるイシューを機械で外す**（`loop/product/verify.mjs` の `EXCLUDE_TITLE`）。OSS 化のイシューは「環境変数」「自己ホスト」「貢献ガイド」のような語で立てる。OAuth を含む文言は本文に書く。
- `loop/po/PLAN.md` はハーネスが読む末尾 12,000 文字を超えている。このプロジェクトの詳細は PLAN に足さず、このファイルに書く。PLAN には gate 1 行と作業ログ 1 行だけ。
- 履歴の書き換え（filter-repo）を「まだ private だから後で」と後回しにしない。公開の直前にやると、その日に公開できない。
- `railway.toml` の `watchPatterns` に `scripts/**` があるので、`scripts/oss-readiness.mjs` を触る PR は本番を再起動する（数分 MCP が 502）。docs だけの PR と分けない（1 回で済ませる）。
- readiness の gate を緩めない（閾値を下げる・gate を消す）。直せないなら台帳に理由。
