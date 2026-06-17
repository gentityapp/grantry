# Role 廃止 / AgentConnectionGrant 移行 Runbook

## 目的

`Role` / `AgentRole` / `allowedTools` / `allowedScopes` を実行認可の source of truth から外し、`AgentConnectionGrant(agentId, connectionId)` に移行する。

この変更で Grantry が保証する境界は、user -> agent、agent -> connection、workspace / owner boundary、audit に限定する。Provider 内部の repo / page / channel / OAuth scope / app permission は provider 側の責務として扱う。

## 事前チェック

```bash
npm run check
DATABASE_URL="<target database url>" npx prisma validate
```

本番または共有環境では、migration 前に対象 DB の backup を取得する。

## 移行順

1. `AgentConnectionGrant` と `AuditLog.connectionId` を schema に追加する。
2. Prisma Client を再生成する。
3. 既存 role binding から connection grant を backfill する。
4. runtime policy、`tools/list`、`tools/call`、`find_agent`、`route`、`delegate` を grant ベースに切り替える。
5. agent 作成、tenant wizard、OAuth callback、connection 作成時に grant を作る。
6. UI / docs から user-facing な Role 文言を外す。
7. Role 依存が残っていないことを確認してから、別段階で `Role` / `AgentRole` の削除を検討する。

## Backfill

```bash
DATABASE_URL="<target database url>" npm run db:backfill-agent-connection-grants
```

backfill は冪等であること。複数回実行しても、同じ `(agentId, connectionId)` の grant は重複作成されない。

変換ルール:

- `Role.allowedTools` から provider を抽出する
- `Role.allowedScopes` が空なら agent owner 配下の該当 provider connection を対象にする
- `Role.allowedScopes` があるなら該当 scope の connection だけを対象にする
- workspace がある agent は同じ workspace の connection だけを対象にする

## Acceptance Smoke

最低限、以下を移行完了条件にする。

1. 既存 agent から grant が正しく backfill される
2. `tools/list` が grant された provider tools だけ返す
3. `tools/call` が grant された connection だけ使う
4. grant されていない `connection_id` は denied
5. provider 側 403 は Grantry policy denied ではなく provider error として残る
6. tenant wizard / OAuth callback で新規 grant が作られる
7. audit に `connectionId` が残る
8. role なしでも新規 agent が動く

## Rollback

schema 追加だけの段階では rollback は比較的安全。runtime を grant ベースに切り替えた後に戻す場合は、以下に注意する。

- `AgentConnectionGrant` にしか存在しない新規 agent / connection の紐づけは、Role へ自動復元できない
- Role 作成を停止した後に作られた agent は、旧 runtime では実行権限を失う可能性がある
- `AuditLog.connectionId` は追加情報なので、旧 runtime に戻しても既存ログを削除する必要はない
- provider permission error と Grantry policy denied の分類が旧挙動へ戻る可能性がある

安全に戻す必要がある場合は、runtime rollback 前に `AgentConnectionGrant` から暫定 role binding を再生成するスクリプトを用意する。

## Verification Commands

```bash
npm run check
DATABASE_URL="<target database url>" npm run db:backfill-agent-connection-grants
DATABASE_URL="<target database url>" npm run db:backfill-agent-connection-grants
```

2回目の backfill で `created: 0` になることを確認する。
