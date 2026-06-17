# Role 廃止 / AgentConnectionGrant 移行テスト項目

## 目的

`Role.allowedTools` / `Role.allowedScopes` を中心にした実行認可から、`AgentConnectionGrant(agentId, connectionId)` ベースの connection routing へ移行した後の受け入れテスト項目を整理する。

移行後の原則:

```text
Grantry manages:
- user -> agent
- agent -> connection
- workspace / tenant boundary
- audit

Provider manages:
- provider内部の実際の権限
- repo / page / channel / folder ACL
- OAuth scope / App permission / provider role
```

## DB / Migration

- 既存 agent ごとに、旧 `Role.allowedTools` / `Role.allowedScopes` で到達可能だった connection が `AgentConnectionGrant` に backfill される
- 重複 grant が作られない
- grant された connection が同じ workspace / owner 境界内にある
- 旧 role がなくても、新 runtime が動作する
- `AuditLog.connectionId` が追加され、既存ログが壊れない
- rollback する場合の影響範囲が把握できている

## Agent 作成

- tenant wizard で provider connection を作成したとき、作成された agent に connection grant が付く
- OAuth provider の callback 後、agent 作成時に OAuth connection grant が付く
- 複数 provider を同時に選んだ場合、agent に全 connection grant が付く
- 既存 connection を再利用して agent を作る場合、その connection grant が付く
- agent 作成時に role が作られない
- agent detail で role ではなく granted connections が表示される

## Connection 管理

- connection detail または tenant 画面で、その connection を使える agents が分かる
- connection を削除すると関連 grant も削除される
- connection を disabled にすると、grant があっても実行できない
- connection を recheck / reconnect しても grant は維持される
- 同じ provider / scope に複数 connection がある場合、`connection_id` なしの call は ambiguous になる
- `connection_id` を指定すると、その grant がある場合だけ実行できる

## MCP tools/list

- 未認証では `ping` など公開 system tool だけが見える
- agent token で認証すると、granted connection の provider tools が見える
- grant されていない provider の tools は見えない
- connection disabled の provider tools は見えない
- scope 固定 URL / header がある場合、該当 scope の granted connection だけが見える
- `connection_id` enum に、agent が grant された connection だけが出る
- provider 側で実際には拒否される tool でも、Grantry は provider permission を保証しない前提で扱う

## MCP tools/call

- grant された connection の provider tool は provider に dispatch される
- grant されていない `connection_id` を指定すると denied になる
- grant されていない provider / scope を指定すると denied になる
- disabled agent は実行できない
- expired agent token は実行できない
- disabled connection は実行できない
- workspace locked endpoint `/mcp/w/<slug>` で別 workspace の agent token を使うと denied
- scope locked endpoint / header で別 scope を指定すると denied
- provider が 401 / 403 / insufficient scope を返した場合、Grantry はそれを error として返し、独自に成功扱いしない
- provider が成功した場合、Grantry は成功レスポンスを返す

## Provider Permission 境界

- GitHub connection に repo 権限がない操作は provider から拒否される
- Notion connection に page 権限がない操作は provider から拒否される
- Slack connection に channel 権限がない操作は provider から拒否される
- Grantry は provider ACL を事前再現しない
- credential metadata は enforcement に使われない
- provider permission 不足時のエラーメッセージが `Grantry policy denied` ではなく provider 由来と分かる

## find_agent / route

- `find_agent` は `Role` ではなく `AgentConnectionGrant` を見て候補を返す
- provider / scope / connection 条件に一致する agent だけが候補になる
- disabled agent は候補に出ない
- disabled connection は候補に出ない
- workspace 境界外の agent は候補に出ない
- `route` は provider / scope / connection_id ベースで候補を返す
- 結果に token や credential は含まれない
- agent charter / description がランキングや説明に使われる場合、権限判定とは分離されている

## delegate

- target agent が該当 connection grant を持つ場合だけ delegation grant を発行できる
- target agent が connection grant を持たない場合は denied
- requester と target の workspace / owner 境界が守られる
- delegation grant は single-use
- delegation grant は期限切れになる
- grant token はハッシュ保存される
- redeem 時に target agent の connection grant を再確認する
- redeem 前に connection が disabled / grant 削除された場合は denied
- audit に requester / target / connection / delegationId が残る

## Audit

- 成功 call に `agentId`, `connectionId`, `provider`, `tool`, `scope`, `status=ok` が残る
- denied call に `agentId`, `provider`, `tool`, `scope`, `status=denied`, `errorMessage` が残る
- provider error に `status=error`, provider 由来の error message が残る
- delegated call に `delegatedById`, `delegationId`, 実行 connection が残る
- OAuth / Personal Agent Token 対応後のために `actingUserId` を入れる器がある
- audit 一覧で connection を辿れる
- responseSummary に credential や raw token が残らない
- requestArgs の secret / token / body は mask される

## UI / UX

- dashboard の `Roles` カウントや broad roles 警告が消える、または internal 扱いになる
- agent 一覧に granted connections の概要が表示される
- agent 詳細に role ではなく connection 一覧が表示される
- connection 詳細に connected agents が表示される
- agent 作成画面で connection を選べる
- tenant wizard 後の完了画面で role ではなく granted connections が表示される
- OAuth callback 完了画面で role 文言が出ない
- 旧 `/agents/:id/bind` の role bind UI が消える
- `/api/scopes` 等の API が role ではなく grants ベースの情報を返す
- `Provider permissions are enforced by provider` という説明が UI か docs にある

## Security / Boundary

- agent A に grant されていない connection B を `connection_id` で指定しても使えない
- 同じ provider / scope でも別 workspace の connection は使えない
- 同じ owner でも別 workspace の connection は使えない
- workspace member でない user が agent / connection を管理できない
- token prefix だけでは実行できない
- grant token と agent token が audit / error / response に出ない
- disabled connection の credential は dispatch されない

## Regression

- 既存の `ping` が動く
- 既存の provider tool dispatch が動く
- OAuth refresh が動く
- PAT connection が動く
- Google Ads の developer token のような server credential 付き connection が動く
- scope 固定 MCP config が動く
- agent token rotate が動く
- workspace switch が既存通り動く
- invite / assignment / OAuth agent grant は壊れない

## Docs / Scripts

- `docs/agent-orchestration.md` が Role 前提から connection grant 前提に更新されている
- `docs/skill.md` の `allowedTools` / `allowedScopes` 説明が消えている
- `scripts/harden-roles.mjs` が削除または非推奨
- `scripts/backfill-notion-tools.mjs` が削除または非推奨
- 新しい backfill script が冪等
- migration 手順が明記されている

## 優先度高いスモーク

最低限これは必須。

1. 既存 agent から grant が正しく backfill される
2. `tools/list` が grant された provider tools だけ返す
3. `tools/call` が grant された connection だけ使う
4. grant されていない `connection_id` は denied
5. provider 側 403 は Grantry policy denied ではなく provider error として残る
6. tenant wizard / OAuth callback で新規 grant が作られる
7. audit に `connectionId` が残る
8. role なしでも新規 agent が動く
