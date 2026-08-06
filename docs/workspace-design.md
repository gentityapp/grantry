# Workspace（Organization）設計メモ

2026-06-13 のOAuth MCP実装（PR #34〜#38）後の設計議論の記録。
将来Workspaceを実装する日の引き継ぎ書。**今は実装しない**（発動条件は後述）。

## 背景：現状モデルの限界

現在のgrantryは構造的に「個人ツール」。Agent / Tenant / Connection / Connection Grant の
すべてが単一ユーザーの `ownerId` にぶら下がっている。これにより：

- 社員がアカウントを作っても何も所有していない（OAuthのagent選択ゲートで
  「No enabled agents」の行き止まりになる）
- 管理者を複数置けない（経理にfreee接続だけ任せる、ができない）
- 退職時に「その人に関わる全アクセスを一撃で剥奪」する単位がない
- 顧客企業に「御社のgrantry環境」として渡す箱がない

## 概念の層構造：2つの壁は守るものが違う

```
User（ログイン主体）
  └─ WorkspaceMember ─→ Workspace（管理の壁：誰がメンバーで誰が設定を触れるか）
                            ├─ Agent（権限の束。OAuth紐付け/トークンの単位）
                            ├─ AgentConnectionGrant
                            ├─ Tenant = scope（データの壁：客先A/Bの認証情報を混ぜない）
                            └─ Connection（暗号化された資格情報。Tenantに属す）
```

- **Tenant（既存）= データの壁**。客先・事業ドメイン単位。ツール呼び出しの
  `scope` 引数として現役。Workspaceを入れてもこの役割は変わらない。
- **Workspace（新設）= 管理の壁**。Slack/Notion/GitHub Orgと同じ
  「会社・チーム」の契約/管理単位。
- 両者は直交する。Workspaceの中に複数Tenantがある（エージェンシーが
  1つのWorkspaceで客先A/B/Cを扱う）。

## 認証の2レーン（既に実装済み、変更しない）

| レーン | 主体 | 認証 | アカウント |
|---|---|---|---|
| 人レーン | claude.ai / Claude Desktop / ChatGPT | OAuth 2.1 + DCR + PKCE | 必要（招待制） |
| 機械レーン | Codex CLI / OpenClaw / cron / CI | 静的 `gn_agt_*` トークン | 不要。永久に不要 |

人×agentの紐付けが必要なのは人レーンだけ（人が機械の皮を被るための必然コスト）。
機械レーンではagent自身が主体なので紐付けは存在しない。

## MCP URL設計：並列接続の要件（重要）

**排他的なワークスペース切替はWebダッシュボードだけの性質**。MCP面では
クライアント（Claude Desktop等）がコネクタを何本でも並列に持てるので、
「ROOTTEAMのテナントAとトヨタのテナントDを同時に触る」は2本のコネクタで成立する。

ただし claude.ai / Desktop は**同じURLのカスタムコネクタを2つ登録できない**。
よって並列接続には**URLがワークスペース（またはscope）を識別できる**必要がある：

```
https://app.grantry.ai/mcp                # 既存。agent紐付けに従い全scope
https://app.grantry.ai/mcp/w/<ws-slug>    # Workspace固定（将来）
https://app.grantry.ai/mcp/s/<scope>      # scope固定（Workspace導入前でも有用）
https://app.grantry.ai/mcp/u              # 新規。人でOAuth認証し、agent_idで実行agentを選ぶ
https://app.grantry.ai/mcp/u/w/<ws-slug>  # 人レーン + Workspace固定
```

実装上の注意：
- RFC 9728 のパス挿入形式 well-known を**URLごとに**配信する必要がある
  （`/.well-known/oauth-protected-resource/mcp/w/<ws>` が、そのURLと一致する
  `resource` を返すこと）。PR #37 で踏んだ罠と同じ。claude.ai は resource の
  完全一致を検証する。
- 既存の `configuredScope`（`X-Gentity-Scope` ヘッダ）の仕組みをURLパスに
  拡張する形で実装できる。ヘッダと違いURLは claude.ai からも指定可能。
- `OauthAgentGrant` の一意キーは現在 `(userId, clientId)`。コネクタが複数並ぶ
  世界では同一clientIdが別URLで再利用される可能性を考慮し、
  `(userId, clientId, resource)` への拡張を検討（オープン課題）。

### User-mode MCP（追加レーン）

`/mcp/u` は既存の agent-bound `/mcp` を置き換えずに追加する。OAuth access token は
まず `User` として解決し、provider tool 実行時に `agent_id` で acting agent を選ぶ。
候補が1つだけなら自動選択する。候補が複数ある場合は `grantry_list_user_agents` または
`connections/list` で候補を見てから `agent_id` を渡す。

認可境界は既存の延長:

- 人がその agent を使えるか: `AgentAssignment` / workspace owner-admin / owner
- agent が connection を使えるか: `AgentConnectionGrant`
- connection の先で何ができるか: provider credential / provider ACL

既存配布済みの `gn_agt_*` クライアントと、`OauthAgentGrant` で単一agentにbindされる
既存OAuth `/mcp` はそのまま残す。

## スキーマ案

```prisma
model Workspace {
  id          String @id @default(cuid())
  slug        String @unique          // URL用。immutable
  displayName String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  members     WorkspaceMember[]
}

model WorkspaceMember {
  workspaceId String
  userId      String
  role        String   // "owner" | "admin" | "member"
  createdAt   DateTime @default(now())
  @@id([workspaceId, userId])
}

// 所有の付け替え（マイグレーション）：
// Agent.ownerId / Tenant.ownerId / Connection.ownerId
//   → workspaceId へ移行（+ createdBy で作成者は記録）
// 既存データは各ユーザーの「パーソナルWorkspace」を自動生成して収容する

// 人→agent配布（Workspaceより先に単体で出せる）
model AgentAssignment {
  agentId   String
  userId    String   // 招待済みユーザー。email招待の場合は pending テーブル併用
  createdAt DateTime @default(now())
  @@id([agentId, userId])
}
```

OAuthのagent選択ゲート（ui.ts `mcpAuthorizeGate`）の検索条件を
`ownerId = 自分` から `owner OR assigned`（Workspace後は `member of workspace`）
に広げる。1メールが複数Workspaceに属す場合、選択画面が
「Workspace → agent」の2段になるだけでクライアント側は何も変わらない。

## フェーズ分け

| フェーズ | 内容 | 発動条件 |
|---|---|---|
| 0（完了） | OAuth MCP + agent紐付けゲート | 済（2026-06-13） |
| 1 | AgentAssignment + 招待メール。必要なら scope固定URL | 社員にagentを配布する日 |
| 2 | Workspace + メンバーロール + 所有付け替え + WS固定URL | 自分以外の管理者が必要になる or 最初の社外顧客 |
| 2.5（2026-07-10） | workspace admin のダッシュボード可視化: owner/admin は active workspace 内の全 tenant/connection/agent を閲覧・管理（一覧・詳細・grant・削除・reconnect）。member は従来どおり自分の行のみ。credential の**再利用**（他人の秘密情報を新 connection に複製する経路）は引き続き owner 限定。`ensureTenant` は workspace 内同 slug を優先解決し重複 tenant 行を防止 | 済 |
| 3 | 人単位の監査ビュー、SSO、Workspace課金 | エンタープライズ商談 |

## オープン課題

- 1 agentを複数人に割り当て可能にするか（テーブルは複数可、運用は1人1agent推奨）
- `OauthAgentGrant` の一意キー拡張（resource次元）
- Workspace slugの予約語・改名ポリシー（URLに載るのでimmutable推奨）
- DCRレート制限・トークン失効UI（OAuthハードニング、Workspaceと独立に必要）

## 議論の経緯（要旨）

- 「管理者が作ったagentを社員に配る」が現モデルで行き止まりになることを発見
- 接続コード方式（アカウント不要）も検討したが、MCPエコシステムがOAuthに
  収束している以上、人レーンはアカウント前提で設計する方が将来と整合
- 「人×agentの紐付けのややこしさ」はOAuthレーンに閉じており、機械レーンには
  存在しない（agent＝主体そのもの）
- Sentry型の排他的Org切替への不安 → MCP面はコネクタ並列で解決、URLに
  識別子が必要、という要件に帰着
