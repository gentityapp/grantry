// Japanese translations, keyed by the English source string. Missing keys fall
// back to English (see t() in ../i18n.ts). Keep placeholders like {name} intact.
//
// Organised loosely by surface for maintainability; lookup is by exact source
// string so ordering does not matter.
export const ja: Record<string, string> = {
  // ── Navigation / chrome ────────────────────────────────────────────────
  "Workspace": "ワークスペース",
  "+ New workspace": "+ 新しいワークスペース",
  "Create a new workspace": "新しいワークスペースを作成",
  "A management wall — you become its owner. Invite teammates and assign agents afterward.":
    "管理の境界です。あなたが所有者になります。後からメンバーを招待し、エージェントを割り当てられます。",
  "Name": "名前",
  "(optional)": "（任意）",
  "Immutable; rides in the connector URL": "変更不可。コネクターURL に含まれます",
  "Leave blank to derive it from the name.": "空欄にすると名前から自動生成されます。",
  "Cancel": "キャンセル",
  "Create": "作成",
  "Dashboard": "ダッシュボード",
  "Scopes": "スコープ",
  "Connections": "接続",
  "Providers": "プロバイダー",
  "Agents": "エージェント",
  "Audit": "監査ログ",
  "Usage": "使用状況",
  "API keys": "API キー",
  "Account": "アカウント",
  "Help": "ヘルプ",
  "Signed in as {email}": "{email} でログイン中",
  "Sign out": "ログアウト",
  "Sign in": "ログイン",
  "Privacy Policy": "プライバシーポリシー",
  "Terms of Service": "利用規約",
  "Contact": "お問い合わせ",
  "Language": "言語",
  "English": "English",
  "日本語": "日本語",

  // ── OAuth consent (auth.ts) ────────────────────────────────────────────
  "Unknown MCP client": "不明な MCP クライアント",
  "{client} wants to connect": "{client} が接続を求めています",
  "This MCP client is asking to access your grantry tools. It will act as the agent you choose below, using that agent's granted connections exactly as configured in your dashboard (changes there apply immediately).":
    "この MCP クライアントは grantry のツールへのアクセスを求めています。下で選んだエージェントとして動作し、そのエージェントに付与された接続を、ダッシュボードの設定どおりに使用します（設定変更は即時反映されます）。",
  "Requested scopes: {scopes}": "要求されたスコープ: {scopes}",
  "(default)": "（既定）",
  "Act as agent": "動作させるエージェント",
  "Loading agents…": "エージェントを読み込み中…",
  "The connector gets this agent's permissions — nothing more. You can revoke access anytime from the grantry dashboard.":
    "コネクターにはこのエージェントの権限のみが付与されます。アクセスはいつでも grantry ダッシュボードから取り消せます。",
  "Deny": "拒否",
  "Approve": "承認",
  "Could not load your agents — are you logged in?":
    "エージェントを読み込めませんでした。ログインしていますか？",
  "You have no enabled agents. Create one in the dashboard first.":
    "有効なエージェントがありません。まずダッシュボードで作成してください。",
  "Failed to bind agent": "エージェントの割り当てに失敗しました",
  "Consent request failed": "同意リクエストに失敗しました",
  "No redirect URI returned": "リダイレクト URI が返されませんでした",

  // ── Dashboard landing ──────────────────────────────────────────────────
  "Connection grants": "接続の付与",
  "Recent activity": "最近のアクティビティ",
  "No activity yet. Create your first scope": "まだアクティビティはありません。最初のスコープを作成しましょう",
  "+ New scope": "+ 新しいスコープ",
  "When": "日時",
  "Agent": "エージェント",
  "Tool": "ツール",
  "Scope": "スコープ",
  "Status": "ステータス",
  "Duration": "所要時間",

  // ── Login / register / password reset ──────────────────────────────────
  "Sign in to grantry": "grantry にログイン",
  "Email": "メールアドレス",
  "Password": "パスワード",
  "Password updated. Sign in with your new password.":
    "パスワードを更新しました。新しいパスワードでログインしてください。",
  "No account?": "アカウントをお持ちでない方は",
  "Create one": "新規登録",
  "Forgot password?": "パスワードをお忘れですか？",
  "Invalid email or password": "メールアドレスまたはパスワードが正しくありません",
  "Create account": "アカウント作成",
  "Already have one?": "すでにアカウントをお持ちの方は",
  "Sign up failed": "アカウント作成に失敗しました",
  "Forgot password": "パスワードをお忘れの方",
  "If an account exists for that address, a reset link is on its way. The link is valid for 1 hour.":
    "そのアドレスのアカウントが存在する場合、再設定リンクを送信しました。リンクの有効期限は1時間です。",
  "Back to sign in": "ログインに戻る",
  "Send reset link": "再設定リンクを送信",

  // ── API keys ───────────────────────────────────────────────────────────
  "Admin API keys": "管理 API キー",
  "grantry admin API keys": "grantry 管理 API キー",
  "grantry manages itself the same way it manages any SaaS: mint an admin API key here, paste it into a <b>grantry</b> connection in the <a href=\"/tenants/new\">connection wizard</a>, and grant that connection to an agent. The agent can then manage this workspace's scopes, agents, connections, and grants over MCP (<code>grantry_create_agent</code>, <code>grantry_grant_scope</code>, …). The key is shown once at mint time; disabling or deleting it immediately cuts off every connection that uses it.":
    "grantry は他の SaaS を管理するのと同じ方法で自分自身を管理します。ここで管理 API キーを発行し、<a href=\"/tenants/new\">接続ウィザード</a>で <b>grantry</b> 接続に貼り付け、その接続をエージェントに付与します。するとエージェントは MCP 経由でこのワークスペースのスコープ・エージェント・接続・付与を管理できます（<code>grantry_create_agent</code>、<code>grantry_grant_scope</code> など）。キーは発行時に一度だけ表示されます。無効化または削除すると、そのキーを使うすべての接続が即座に遮断されます。",
  "e.g. agent-factory key": "例: agent-factory key",
  "Mint new key": "新しいキーを発行",
  "Keys in this workspace": "このワークスペースのキー",
  "No admin API keys yet.": "管理 API キーはまだありません。",
  "Key": "キー",
  "label required": "ラベルが必要です",
  "key not found": "キーが見つかりません",
  "Admin API key minted": "管理 API キーを発行しました",
  "Copy it now — it is shown only once.": "今すぐコピーしてください。表示は一度きりです。",
  "Only its hash is stored.": "保存されるのはハッシュのみです。",
  "Next step": "次のステップ",
  "Add it as a <b>grantry</b> connection in the <a href=\"/tenants/new\">connection wizard</a> (pick a scope such as <code>grantry-admin</code>), then grant that connection to the agent that should manage this workspace.":
    "<a href=\"/tenants/new\">接続ウィザード</a>で <b>grantry</b> 接続として追加し（<code>grantry-admin</code> などのスコープを選択）、その接続をこのワークスペースを管理するエージェントに付与してください。",
  "Back to API keys": "API キー一覧に戻る",

  // ── Account ────────────────────────────────────────────────────────────
  "Password updated. Other sessions have been signed out.":
    "パスワードを更新しました。他のセッションはログアウトされました。",
  "Signed in as": "ログイン中のアカウント",
  "User ID": "ユーザー ID",
  "Role": "ロール",
  "Registered": "登録日",
  "Active sessions": "アクティブなセッション",
  "Everything below is owned by this account. If a scope or agent you expect is missing, it probably belongs to a different account — sign out and back in with that one.":
    "以下のすべてはこのアカウントが所有しています。表示されるはずのスコープやエージェントが見当たらない場合、別のアカウントに属している可能性があります。そのアカウントでログインし直してください。",
  "Owned by this account": "このアカウントの所有物",
  "{n} scopes": "{n} 個のスコープ",
  "{n} connections": "{n} 個の接続",
  "{n} agents": "{n} 個のエージェント",
  "{n} connection grants": "{n} 件の接続付与",
  "Change password": "パスワードを変更",
  "Current password": "現在のパスワード",
  "New password": "新しいパスワード",
  "New password (again)": "新しいパスワード（確認）",
  "Changing the password signs out every other session.":
    "パスワードを変更すると、他のすべてのセッションがログアウトされます。",
  "Locked out?": "ログインできない場合",
  "If you can't sign in at all, an operator can reset any account's password from the server:":
    "まったくログインできない場合、運用担当者がサーバーから任意のアカウントのパスワードを再設定できます:",

  // ── Providers ──────────────────────────────────────────────────────────
  "Choose which providers this workspace can add to scopes. Existing connections keep working; disabled providers are hidden from new scope connection pickers.":
    "このワークスペースがスコープに追加できるプロバイダーを選択します。既存の接続は引き続き動作します。無効化したプロバイダーは新しいスコープ接続の選択肢から非表示になります。",
  "Catalog": "カタログ",
  "Hidden": "非表示",
  "Custom": "カスタム",
  "OAuth credentials": "OAuth 認証情報",
  "Workspace OAuth credentials": "ワークスペースの OAuth 認証情報",
  "Connect a provider once at the workspace level, then reuse that credential from scopes without starting from a scope first.":
    "プロバイダーをワークスペースレベルで一度接続すれば、スコープから先に始めることなくその認証情報を再利用できます。",
  "OAuth app": "OAuth アプリ",
  "Credentials": "認証情報",
  "configured": "設定済み",
  "Save OAuth app": "OAuth アプリを保存",
  "admin only": "管理者のみ",
  "platform app": "プラットフォームアプリ",
  "not connected": "未接続",
  "save OAuth app first": "先に OAuth アプリを保存してください",
  "Connect OAuth": "OAuth で接続",
  "No OAuth providers.": "OAuth プロバイダーはありません。",
  "Workspace provider catalog": "ワークスペースのプロバイダーカタログ",
  "Search providers...": "プロバイダーを検索...",
  "Type": "種別",
  "custom": "カスタム",
  "built-in": "組み込み",
  "pinned": "ピン留め",
  "hidden from scopes": "スコープから非表示",
  "default": "既定",
  "Hide": "非表示",
  "Enable": "有効化",
  "Custom providers": "カスタムプロバイダー",
  "Custom providers are workspace-level definitions. Once enabled here, they appear in each scope's Add service picker.":
    "カスタムプロバイダーはワークスペースレベルの定義です。ここで有効化すると、各スコープの「サービスを追加」の選択肢に表示されます。",
  "Add custom provider": "カスタムプロバイダーを追加",
  "Base URL": "ベース URL",
  "Delete custom provider {key}? Existing connections keep their provider key but the catalog definition will be removed.":
    "カスタムプロバイダー {key} を削除しますか？既存の接続はプロバイダーキーを保持しますが、カタログ定義は削除されます。",
  "No custom providers in this workspace yet.": "このワークスペースにはまだカスタムプロバイダーがありません。",
  "Workspace admin required to add custom providers.": "カスタムプロバイダーの追加にはワークスペースの管理者権限が必要です。",

  // ── Workspaces ─────────────────────────────────────────────────────────
  "Connector URL:": "コネクター URL:",
  "Workspace-locked connector URL (parallel connectors per client):":
    "ワークスペース固定のコネクター URL（クライアントごとに並行接続）:",
  "Members": "メンバー",
  "Member": "メンバー",
  "Assigned agents": "割り当て済みエージェント",
  "Unassign": "割り当て解除",
  "Remove {email} from workspace? Their connector access is revoked immediately.":
    "{email} をワークスペースから削除しますか？そのコネクターアクセスは即座に取り消されます。",
  "Assign an agent": "エージェントを割り当て",
  "Assign": "割り当て",
  "Assign to people": "人に割り当てる",
  "Assigned members reach this agent through the workspace connector URL — they never need its token.":
    "割り当てられたメンバーは、ワークスペースのコネクター URL からこのエージェントを利用できます。トークンを渡す必要はありません。",
  "Manage all assignments": "割り当てをまとめて管理",
  "Invite someone new": "新しいメンバーを招待",
  "Could not update the assignment. Try again from the Assignments page.":
    "割り当てを更新できませんでした。Assignments ページからやり直してください。",

  // ── Assignment notification email ──────────────────────────────────────
  "Hi {name},": "{name} さん",
  "Hi,": "こんにちは",
  "You've been assigned the agent {agent} on grantry":
    "grantry でエージェント「{agent}」が割り当てられました",
  "{admin} assigned you the agent {agent} in the {workspace} workspace on grantry.":
    "{admin} が、grantry の「{workspace}」ワークスペースでエージェント「{agent}」をあなたに割り当てました。",
  "<b>{admin}</b> assigned you the agent <b>{agent}</b> in the <b>{workspace}</b> workspace on grantry.":
    "<b>{admin}</b> が、grantry の <b>{workspace}</b> ワークスペースでエージェント <b>{agent}</b> をあなたに割り当てました。",
  "What it does": "このエージェントの役割",
  "Agent details": "エージェントの詳細ページ",
  "Open the agent page": "エージェントの詳細ページを開く",
  "It is usable from your personal MCP token right away — no new token to copy. If you have not created one yet, do it on the MCP tokens page.":
    "あなた個人の MCP トークンからすぐに利用できます。新しいトークンを受け取る必要はありません。まだ作成していない場合は MCP トークンのページから作成してください。",
  "Invite": "招待",
  "member": "メンバー",
  "admin": "管理者",
  "Send invite": "招待を送信",
  "Auto-assign agents on accept:": "承諾時に自動割り当てするエージェント:",
  "No agents in this workspace yet.": "このワークスペースにはまだエージェントがありません。",
  "Pending invites": "保留中の招待",
  // ── Google Workspace ディレクトリからの一括招待 ──────────────────────────
  "Invite from Google Workspace": "Google Workspace から招待",
  "Pick people from your Google Workspace directory and invite them in one go. Linked as {email}.":
    "Google Workspace のディレクトリからメンバーを選んで、まとめて招待できます。連携アカウント: {email}",
  "Pick people from your Google Workspace directory and invite them in one go. Sign in with a Workspace admin account to start.":
    "Google Workspace のディレクトリからメンバーを選んで、まとめて招待できます。まず Workspace 管理者アカウントでログインしてください。",
  "Sign in with a Google Workspace administrator account to read your directory. grantry asks only for read-only access to the user list, and uses it just to invite people here.":
    "Google Workspace 管理者アカウントでログインすると、ディレクトリを読み取れます。grantry が要求するのはユーザー一覧の読み取り専用権限のみで、用途はこのワークスペースへの招待だけです。",
  "Link Google Workspace": "Google Workspace と連携",
  "Linked as {email}": "連携アカウント: {email}",
  "Unlink": "連携を解除",
  "Could not read the Google Workspace directory": "Google Workspace のディレクトリを取得できませんでした",
  "The linked Google account must be a Workspace administrator. Link it again to renew access.":
    "連携した Google アカウントは Workspace 管理者である必要があります。アクセスを更新するには、もう一度連携してください。",
  "{total} accounts in the directory · {joined} already in this workspace or invited · {suspended} suspended (hidden)":
    "ディレクトリ {total} 件 · うち {joined} 件はこのワークスペースのメンバーまたは招待済み · 停止中 {suspended} 件（非表示）",
  "Filter by email, name, or org unit": "メールアドレス・氏名・組織部門で絞り込み",
  "Send invites": "まとめて招待",
  "Org unit": "組織部門",
  "Up to {max} invites per submit.": "1 回の送信につき最大 {max} 件まで招待できます。",
  "Everyone in the directory is already a member or has a pending invite.":
    "ディレクトリの全員が、すでにメンバーか招待済みです。",
  "Invited {count} people from Google Workspace": "Google Workspace から {count} 人を招待しました",
  "{count} already a member or invited": "{count} 件はすでにメンバーまたは招待済みのためスキップ",
  "{count} left out (max {max} per submit)": "{count} 件は上限（1 回あたり {max} 件）を超えたため未送信",
  "Expires": "有効期限",
  "Link": "リンク",
  "Revoke": "取り消し",
  "Delete workspace": "ワークスペースを削除",
  "This permanently deletes this workspace and its members, invites, agents, connections, tenants, provider settings, and credentials.":
    "このワークスペースと、そのメンバー・招待・エージェント・接続・スコープ・プロバイダー設定・認証情報を完全に削除します。",
  "Type the workspace name to confirm": "確認のためワークスペース名を入力してください",
  "Create or join another workspace before deleting this one.":
    "このワークスペースを削除する前に、別のワークスペースを作成するか参加してください。",
  "No workspace yet — use <b>+ New workspace</b> in the sidebar to create one.":
    "まだワークスペースがありません。サイドバーの <b>+ 新しいワークスペース</b> から作成してください。",

  // ── Public home ────────────────────────────────────────────────────────
  "OAuth credential broker for AI agents": "AI エージェントのための OAuth 認証情報ブローカー",
  "OAuth credential broker for AI agents.": "AI エージェントのための OAuth 認証情報ブローカー。",
  "grantry lets teams connect third-party services such as Google Analytics, Google Ads, Google Search Console, GitHub, Slack, HubSpot, and other business tools, then grant specific AI agents access to only the connections they are allowed to use.":
    "grantry を使うと、Google Analytics、Google Ads、Google Search Console、GitHub、Slack、HubSpot などのサードパーティサービスをチームで接続し、特定の AI エージェントに、利用を許可した接続だけへのアクセスを付与できます。",
  "Open dashboard": "ダッシュボードを開く",
  "Read privacy policy": "プライバシーポリシーを読む",
  "Connection control": "接続の制御",
  "Workspace owners decide which provider connections each agent can use.":
    "ワークスペースのオーナーが、各エージェントが使えるプロバイダー接続を決定します。",
  "Provider-backed access": "プロバイダーに裏付けられたアクセス",
  "Provider APIs continue to enforce their own account permissions and scopes.":
    "プロバイダーの API は、独自のアカウント権限とスコープを引き続き適用します。",
  "Audit visibility": "監査の可視性",
  "Agent tool calls and connection usage are logged so teams can review activity.":
    "エージェントのツール呼び出しと接続の利用はログに記録され、チームがアクティビティを確認できます。",

  // ── Reset password ─────────────────────────────────────────────────────
  "Reset password": "パスワードの再設定",
  "This reset link is invalid or has expired.": "この再設定リンクは無効か、有効期限が切れています。",
  "Request a new one": "新しいリンクをリクエスト",
  "Choose a new password": "新しいパスワードを設定",
  "Set new password": "新しいパスワードを設定",
  "Password must be at least 8 characters": "パスワードは8文字以上である必要があります",
  "Passwords do not match": "パスワードが一致しません",
  "Reset failed": "再設定に失敗しました",

  // ── Workspace invite ───────────────────────────────────────────────────
  "Workspace invite": "ワークスペースへの招待",
  "This invite link is invalid or already used.": "この招待リンクは無効か、すでに使用されています。",
  "This invite has expired. Ask your admin to send a new one.":
    "この招待は有効期限が切れています。管理者に新しい招待を送ってもらってください。",
  "You've been invited to the <b>{workspace}</b> workspace (as {role}).":
    "<b>{workspace}</b> ワークスペースに招待されました（{role} として）。",
  "Sign in or create a grantry account with <b>{email}</b> to accept.":
    "承諾するには、<b>{email}</b> で grantry にログインするか、アカウントを作成してください。",
  "This invite was issued to <b>{invited}</b>, but you are signed in as <b>{current}</b>.":
    "この招待は <b>{invited}</b> 宛てに発行されましたが、現在 <b>{current}</b> でログインしています。",
  "Sign out and use the invited address.": "ログアウトして、招待されたアドレスでログインしてください。",
  "Joined {workspace}": "{workspace} に参加しました",

  // ── New scope wizard ───────────────────────────────────────────────────
  "New scope": "新しいスコープ",
  "Step 1 creates a scope and its provider connections. Step 2 assigns or creates the agent that can use this scope.":
    "ステップ1でスコープとそのプロバイダー接続を作成します。ステップ2で、このスコープを使えるエージェントを割り当てるか作成します。",
  "Scope key": "スコープキー",
  "Lowercase letters, numbers, hyphens and underscores only (a-z 0-9 - _). Use the Display name field below for Japanese or other names.":
    "使えるのは小文字・数字・ハイフン・アンダースコアのみ（a-z 0-9 - _）。日本語などの名前は下の「表示名」欄を使ってください。",
  "lowercase, alphanumeric, hyphens, underscores. Agents send this as <b>scope</b> in API calls — it cannot be changed later, so pick carefully.":
    "小文字・英数字・ハイフン・アンダースコア。エージェントは API 呼び出しで<b>scope</b>としてこれを送信します。後から変更できないため慎重に選んでください。",
  "Display name (optional)": "表示名（任意）",
  "Human-facing label shown in dashboards. Unlike the scope key, you can rename this anytime.":
    "ダッシュボードに表示される人間向けのラベルです。スコープキーと違い、いつでも変更できます。",
  "Pick one or more services to wire into this scope. If this workspace already has a matching connection, leaving the credential blank reuses that existing provider credential for the new scope.":
    "このスコープに接続するサービスを1つ以上選んでください。このワークスペースに一致する接続が既にある場合、認証情報を空欄のままにすると、その既存のプロバイダー認証情報を新しいスコープで再利用します。",
  "Only providers enabled in <a href=\"/providers\">Providers</a> are shown here.":
    "ここには <a href=\"/providers\">プロバイダー</a> で有効化されたプロバイダーのみ表示されます。",
  "Search providers… (e.g. notion, github, oauth)": "プロバイダーを検索…（例: notion、github、oauth）",
  "No providers match your search.": "検索に一致するプロバイダーはありません。",
  "existing connection": "既存の接続",
  "Coming soon": "近日対応",
  "You'll be redirected to authorize after clicking <b>Create scope</b>.":
    "<b>スコープを作成</b>をクリックすると、認可のためにリダイレクトされます。",
  "OAuth app settings": "OAuth アプリ設定",
  "Copy this redirect URI into the OAuth application settings in {provider}.":
    "このリダイレクト URI を {provider} の OAuth アプリケーション設定にコピーしてください。",
  "Stored on this workspace and used for this provider's OAuth redirects and token refreshes.":
    "このワークスペースに保存され、このプロバイダーの OAuth リダイレクトとトークン更新に使用されます。",
  "This connection exposes provider tools according to the credential's own permissions.":
    "この接続は、認証情報自体の権限に応じてプロバイダーのツールを公開します。",
  "Provider registration is defined, but MCP tools and dispatch are not enabled yet.":
    "プロバイダーの登録は定義されていますが、MCP ツールとディスパッチはまだ有効化されていません。",
  "Create scope": "スコープを作成",

  // ── Audit log ──────────────────────────────────────────────────────────
  "Audit log": "監査ログ",
  "Latest 100 events.": "最新100件のイベント。",
  "Click a row to see the tool-call arguments and response summary.":
    "行をクリックすると、ツール呼び出しの引数とレスポンス要約を確認できます。",
  "Request args": "リクエスト引数",
  "Response summary": "レスポンス要約",
  "Delegated by": "委任元",
  "delegation": "委任",
  "No events yet.": "まだイベントはありません。",
  "Error": "エラー",

  // ── Common errors / notices ────────────────────────────────────────────
  "workspace required": "ワークスペースが必要です",
  "workspace admin required": "ワークスペースの管理者権限が必要です",
  "not authenticated": "認証されていません",
  "unauthorized": "権限がありません",
  "Back": "戻る",
  "admin already exists": "管理者はすでに存在します",
  "admin required": "管理者権限が必要です",
  "workspace owner/admin required": "ワークスペースのオーナーまたは管理者権限が必要です",
  "Only workspace owners and admins can manage grantry admin API keys.":
    "grantry 管理 API キーを管理できるのはワークスペースのオーナーと管理者のみです。",
  "unknown provider": "不明なプロバイダーです",
  "provider not implemented": "このプロバイダーは未実装です",
  "existing connection reuse is only supported for paste-token providers":
    "既存の接続の再利用は、トークン貼り付け型のプロバイダーでのみ利用できます",
  "choose an existing connection or paste a new credential, not both":
    "既存の接続を選ぶか、新しい認証情報を貼り付けるか、どちらか一方を選んでください",
  "service account is not supported for this provider":
    "このプロバイダーではサービスアカウントはサポートされていません",
  "pasted credentials are not accepted for this OAuth-only provider":
    "この OAuth 専用プロバイダーでは、貼り付けた認証情報は受け付けられません",
  "OAuth is not supported for this provider": "このプロバイダーでは OAuth はサポートされていません",
  "paste token is not supported for this provider":
    "このプロバイダーではトークンの貼り付けはサポートされていません",
  "unknown action": "不明な操作です",
  "select at least one provider": "プロバイダーを少なくとも1つ選択してください",
  "agent required": "エージェントが必要です",

  // ── Connections (health view) ──────────────────────────────────────────
  "A health check is already running.": "ヘルスチェックはすでに実行中です。",
  "Check all now": "すべて今すぐ確認",
  "+ New scope connection": "+ 新しいスコープ接続",
  "+ New connection": "+ 新しい接続",
  "New connection": "新しい接続",
  "Pick a provider, attach it to a scope, then paste the credential or authorize. Existing workspace credentials can be reused, so a new scope is only needed when you actually want one.":
    "プロバイダーを選び、スコープに紐づけてから認証情報を貼り付けるか認可します。ワークスペース内の既存の認証情報を再利用できるので、スコープを新規作成するのは本当に必要なときだけで構いません。",
  "Select a provider…": "プロバイダーを選択…",
  "Agents are granted access per connection, but every connection lives inside a scope — the key agents send at call time. Attach this one to a scope you already have, or create a new scope for it. The scope's agents are granted this connection automatically.":
    "エージェントへの権限付与は接続単位ですが、接続は必ずスコープ（エージェントが呼び出し時に送るキー）の中に存在します。既存のスコープに紐づけるか、この接続用に新しいスコープを作成してください。そのスコープのエージェントにはこの接続が自動で付与されます。",
  "Attach to scope": "紐づけるスコープ",
  "+ Create a new scope": "+ 新しいスコープを作成",
  "Continue": "次へ",
  "Scope key must be lowercase letters, numbers, hyphens or underscores.":
    "スコープキーは小文字の英数字・ハイフン・アンダースコアのみ使用できます。",
  "Scope not found.": "スコープが見つかりません。",
  "Existing credential": "既存の認証情報",
  "Use existing: {label} ({scope})": "既存を使用: {label}（{scope}）",
  "Creates a new scope-scoped connection that uses the selected workspace credential — no re-authentication needed.":
    "選択したワークスペース認証情報を使う、このスコープ専用の接続を作成します（再認証は不要）。",
  "Workspace-wide health view for scope connections. Provider app and token settings are linked from each row's actions.":
    "スコープ接続のワークスペース全体のヘルス状況です。プロバイダーアプリとトークンの設定は各行のアクションからリンクされています。",
  "Total": "合計",
  "Active": "稼働中",
  "Needs attention": "要対応",
  "Not checked": "未確認",
  "No agent grant": "エージェント付与なし",
  "Disabled": "無効",
  "Search": "検索",
  "provider, scope, label": "プロバイダー、スコープ、ラベル",
  "All": "すべて",
  "Partial": "一部",
  "Broken": "エラー",
  "Apply": "適用",
  "Reset": "リセット",
  "Connection": "接続",
  "Health": "ヘルス",
  "Updated": "更新日",
  "Action": "アクション",
  "legacy unscoped": "レガシー（スコープなし）",
  "Checked {ts}": "確認済み {ts}",
  "disabled": "無効",
  "needs reconnect": "再接続が必要",
  "no agent grant": "エージェント付与なし",
  "Reconnect": "再接続",
  "Save this provider's OAuth app settings before reconnecting.":
    "再接続する前に、このプロバイダーの OAuth アプリ設定を保存してください。",
  "Set up OAuth app": "OAuth アプリを設定",
  "Open scope to repair": "修復するにはスコープを開いてください",
  "Verify the saved token against the provider without re-authorizing":
    "再認証せずに、保存済みトークンをプロバイダーに照合して検証します",
  "Check now": "今すぐ確認",
  "Edit connection": "接続を編集",
  "Open scope": "スコープを開く",
  "No connections match this filter.": "このフィルターに一致する接続はありません。",
  "No active workspace.": "有効なワークスペースがありません。",
  "A health check is already running — reload in a minute to see fresh results.":
    "ヘルスチェックはすでに実行中です。少し待ってから再読み込みすると最新の結果が表示されます。",
  "Health check started for all connections in this workspace. It runs in the background — reload in a few minutes.":
    "このワークスペースのすべての接続に対してヘルスチェックを開始しました。バックグラウンドで実行されます。数分後に再読み込みしてください。",

  // ── Connection edit / repair ───────────────────────────────────────────
  "connection not found": "接続が見つかりません",
  "private app token": "プライベートアプリトークン",
  "token": "トークン",
  "Update the saved connection record and repair its credential when possible.":
    "保存された接続レコードを更新し、可能な場合は認証情報を修復します。",
  "Back to connections": "接続一覧に戻る",
  "Scope:": "スコープ:",
  "Connection settings": "接続の設定",
  "Label": "ラベル",
  "enabled": "有効",
  "Replace {token}": "{token}を置き換え",
  "Paste new {token}": "新しい{token}を貼り付け",
  "Leave blank to keep the saved credential. Pasting a new value validates it and updates any shared provider credential snapshot.":
    "空欄のままにすると、保存済みの認証情報が維持されます。新しい値を貼り付けると検証され、共有プロバイダー認証情報のスナップショットも更新されます。",
  "Save connection": "接続を保存",
  "OAuth repair": "OAuth の修復",
  "Use Reconnect when the OAuth token is expired, revoked, or missing scopes. If the provider app's Client ID or Client Secret changed, save the OAuth app settings here first.":
    "OAuth トークンの期限切れ、失効、スコープ不足の場合は「再接続」を使用してください。プロバイダーアプリの Client ID または Client Secret が変更された場合は、先にここで OAuth アプリ設定を保存してください。",
  "Current Client ID:": "現在の Client ID:",
  "not configured": "未設定",
  "Client ID": "Client ID",
  "Paste Client ID from {provider}": "{provider}の Client ID を貼り付け",
  "Client Secret": "Client Secret",
  "Paste Client Secret": "Client Secret を貼り付け",
  "Client authentication method": "クライアント認証方式",
  "Redirect URI": "リダイレクト URI",
  "Copy this Redirect URI into the provider app. For security, Grantry cannot show the existing Client Secret; paste it again when updating app settings.":
    "このリダイレクト URI をプロバイダーアプリにコピーしてください。セキュリティ上、grantry は既存の Client Secret を表示できません。アプリ設定を更新する際は再度貼り付けてください。",
  "Save OAuth app settings": "OAuth アプリ設定を保存",
  "Save OAuth app settings before reconnecting": "再接続する前に OAuth アプリ設定を保存してください",
  "Reconnect requires a scoped connection": "再接続にはスコープ付き接続が必要です",
  "Granted agents": "付与されたエージェント",
  "Label is required": "ラベルは必須です",
  "OAuth app settings are not used by this connection": "この接続では OAuth アプリ設定は使用されません",
  "Client ID and Client Secret are required": "Client ID と Client Secret は必須です",
  "OAuth app settings failed: {message}": "OAuth アプリ設定に失敗しました: {message}",
  "OAuth app settings saved. Reconnect this connection to refresh the token.":
    "OAuth アプリ設定を保存しました。トークンを更新するにはこの接続を再接続してください。",
  "This connection type is repaired with Reconnect, not by pasting a credential":
    "この接続タイプは認証情報の貼り付けではなく「再接続」で修復します",
  "Connection settings saved.": "接続の設定を保存しました。",
  "Unknown provider": "不明なプロバイダー",
  "Credential validation failed: {message}": "認証情報の検証に失敗しました: {message}",
  "Connection credential updated and checked.": "接続の認証情報を更新し、確認しました。",

  // ── Agents list / detail / create / rotate / delete ────────────────────
  "+ New agent": "+ 新しいエージェント",
  "New agent": "新しいエージェント",
  "select all": "すべて選択",
  "Delete selected": "選択項目を削除",
  "No agents yet.": "まだエージェントがありません。",
  "Create one via the scope wizard": "スコープウィザードで作成",
  "Token prefix": "トークンのプレフィックス",
  "Lock an entry to a single scope (optional)": "エントリを1スコープに固定する（任意）",
  "The entry above already reaches every connection this agent holds; a locked entry is a narrowing, not a requirement. Two cases need one: claude.ai and Claude Desktop cannot register two connectors on the same URL, so parallel connectors must differ by URL — use <code>{origin}/mcp/s/&lt;scope&gt;</code> there, since those clients cannot set headers. And an agent spanning many scopes produces a long tool list, which locking trims.":
    "上のエントリだけでこのエージェントの全接続に到達します。固定は絞り込みであって必須ではありません。必要になるのは2ケース。claude.ai と Claude Desktop は同じURLのコネクタを2つ登録できないため、並列コネクタはURLで区別する必要があります（これらのクライアントはヘッダを指定できないので <code>{origin}/mcp/s/&lt;scope&gt;</code> を使う）。もう1つは、多数のスコープにまたがるエージェントでツール一覧が長くなる場合。固定すると短くなります。",
  "Registering several of these at once puts more than one <code>mcp__grantry-*__</code> prefix in the same client. That is the arrangement the multi-server guard in the agent skill exists for — prefer one entry per agent unless a case above applies.":
    "これらを複数まとめて登録すると、1つのクライアントに <code>mcp__grantry-*__</code> プレフィックスが複数並びます。エージェントスキルのマルチサーバーガードは、まさにこの状態のためにあります。上記のケースに該当しない限り、1エージェント1エントリを推奨します。",
  "{providers} only — {n} of {total} connections in this scope": "{providers} のみ — このスコープの {total} 接続のうち {n} 件",
  "{providers} — every connection in this scope": "{providers} — このスコープの全接続",
  "Granted connections": "付与された接続",
  "Accessible scopes": "アクセス可能なスコープ",
  "Last used": "最終使用",
  "Created": "作成日",
  "Actions": "アクション",
  "none": "なし",
  "no granted connections": "付与された接続なし",
  "Rotate token for {name}?\\n\\nThe OLD token will be invalidated immediately. The NEW token will be shown ONCE on the next page.":
    "{name} のトークンをローテーションしますか？\\n\\n古いトークンは直ちに無効になります。新しいトークンは次のページで一度だけ表示されます。",
  "Rotate": "ローテーション",
  "Details": "詳細",
  "Delete agent {name}?\\n\\nThis permanently destroys its token and connection grants.":
    "エージェント {name} を削除しますか？\\n\\nトークンと接続の付与が完全に破棄されます。",
  'Create an agent that spans <b>existing</b> scopes — e.g. a manager that reads several business areas with one token. To create a new scope, use the <a href="/tenants/new">scope wizard</a> instead.':
    '<b>既存</b>のスコープにまたがるエージェントを作成します。例えば、複数の事業領域を1つのトークンで読み取るマネージャーです。新しいスコープを作成するには、代わりに<a href="/tenants/new">スコープウィザード</a>をご利用ください。',
  "No scopes yet.": "まだスコープがありません。",
  "Create one first": "まず作成してください",
  "Agent name": "エージェント名",
  "Description": "説明",
  "Full-scope manager": "全スコープマネージャー",
  "Reach <b>all</b> your scopes with one token — including scopes you create later. Grants every enabled scope connection you own. Owner-bounded: only ever your own connections.":
    "1つのトークンで<b>すべて</b>のスコープにアクセスできます（後から作成するスコープも含む）。所有する有効なスコープ接続すべてを付与します。所有者に限定され、常にあなた自身の接続のみが対象です。",
  "Scope access": "スコープアクセス",
  "Check the scopes this agent may reach. The agent receives grants to each enabled connection in the selected scopes. Provider permissions still come from the credential itself.":
    "このエージェントがアクセスできるスコープを選択してください。選択したスコープ内の有効な各接続への付与がエージェントに与えられます。プロバイダーの権限は、認証情報自体によって決まります。",
  "No enabled connections — selecting this scope grants nothing.":
    "有効な接続がありません。このスコープを選択しても何も付与されません。",
  "Full-scope access": "全スコープアクセス",
  "This token can use <b>every enabled scope connection you own</b>, including scopes created later. If it leaks, your granted footprint is exposed at once.":
    "このトークンは、<b>所有する有効なスコープ接続すべて</b>（後から作成するスコープも含む）を使用できます。漏洩した場合、付与された範囲が一度に露出します。",
  "I understand this agent reaches all my scopes, present and future.":
    "このエージェントが現在および将来のすべてのスコープにアクセスすることを理解しました。",
  "No enabled connections in any scope.": "どのスコープにも有効な接続がありません。",
  "{count} enabled connection(s) across {scopes} scope(s) will be granted.":
    "{scopes} 個のスコープにまたがる {count} 件の有効な接続が付与されます。",
  "What this agent will be able to do": "このエージェントができること",
  "Select at least one scope above.": "上記のスコープを少なくとも1つ選択してください。",
  "Create agent & mint token": "エージェントを作成してトークンを発行",
  "Create full-scope manager & mint token": "全スコープマネージャーを作成してトークンを発行",
  "Tick the confirmation above to enable creation.": "作成を有効にするには、上記の確認にチェックを入れてください。",
  "<b>Full-scope manager</b> — all enabled scope connections, including scopes created later.":
    "<b>全スコープマネージャー</b> — 有効なスコープ接続すべて（後から作成するスコープも含む）。",
  "The MCP config has no scope lock; pass <code>scope</code> per call.":
    "MCP 設定にはスコープロックがありません。呼び出しごとに <code>scope</code> を渡してください。",
  "Connection grants are created for this agent automatically. The token is shown once, right after creation.":
    "このエージェントの接続付与は自動的に作成されます。トークンは作成直後に一度だけ表示されます。",
  "Back to agents": "エージェント一覧に戻る",
  "agent name required (alphanumeric, hyphens, underscores)":
    "エージェント名は必須です（英数字、ハイフン、アンダースコア）",
  "confirm full-scope access to create a manager":
    "マネージャーを作成するには全スコープアクセスの確認が必要です",
  "select at least one scope": "スコープを少なくとも1つ選択してください",
  "unknown scope(s): {scopes}": "不明なスコープ: {scopes}",
  "select at least one scope with an enabled connection":
    "有効な接続のあるスコープを少なくとも1つ選択してください",
  "⚠️ Agent name <code>{name}</code> already exists": "⚠️ エージェント名 <code>{name}</code> はすでに存在します",
  'Pick a different name, or <a href="{href}">reuse the existing agent</a>.':
    '別の名前を選ぶか、<a href="{href}">既存のエージェントを再利用</a>してください。',
  "Agent created": "エージェントを作成しました",
  "✓ Agent <code>{name}</code> created": "✓ エージェント <code>{name}</code> を作成しました",
  "Access": "アクセス",
  "all present and future scope connections": "現在および将来のすべてのスコープ接続",
  "granted {count} current connection(s)": "現在の接続 {count} 件を付与しました",
  "Cross-scope calls": "スコープ横断の呼び出し",
  "This config has <b>no</b> <code>X-Grantry-Scope</code> lock. Pass the target scope per call:":
    "この設定には <code>X-Grantry-Scope</code> ロックが<b>ありません</b>。呼び出しごとに対象スコープを渡してください:",
  "agent not found": "エージェントが見つかりません",
  "not your agent": "あなたのエージェントではありません",
  "Mode": "モード",
  "full-scope manager": "全スコープマネージャー",
  "selected scopes": "選択されたスコープ",
  "Add existing scopes": "既存のスコープを追加",
  "No ungranted scopes with enabled connections are available for this agent.":
    "このエージェントに追加できる、有効な接続を持つ未付与のスコープはありません。",
  "{count} connection(s):": "接続 {count} 件:",
  "Add selected scopes": "選択したスコープを追加",
  "Remove scopes": "スコープを削除",
  'This agent is a <span class="badge denied">full-scope manager</span> — it reaches every scope in the workspace directly, not through per-scope grants. To narrow it, switch it to selected-scopes mode; individual scopes cannot be removed while it stays a manager.':
    'このエージェントは <span class="badge denied">全スコープマネージャー</span> です。スコープごとの付与ではなく、ワークスペース内のすべてのスコープに直接アクセスします。範囲を狭めるには、選択スコープモードに切り替えてください。マネージャーのままでは個別のスコープを削除できません。',
  "No scopes granted to this agent.": "このエージェントに付与されたスコープはありません。",
  "Drops every connection grant at the selected scope. The agent loses those provider tools on its next request. Other agents and the connections themselves are unaffected.":
    "選択したスコープのすべての接続付与を削除します。エージェントは次のリクエストでそれらのプロバイダーツールを失います。他のエージェントや接続自体には影響しません。",
  "Remove scope {scope} from agent {name}? The agent loses these tools on its next request.":
    "エージェント {name} からスコープ {scope} を削除しますか？エージェントは次のリクエストでこれらのツールを失います。",
  "Remove": "削除",
  "invalid scope": "無効なスコープ",
  "Removed scope {scope}": "スコープ {scope} を削除しました",
  "Charter": "役割説明",
  "What this agent is <em>for</em>, in plain language. Surfaced to <code>grantry_find_agent</code> so other agents route work here by purpose — not just by which tools you hold. Stored as the agent's description.":
    "このエージェントが何の<em>ため</em>にあるのかを平易な言葉で。<code>grantry_find_agent</code> に表示され、他のエージェントが保有するツールだけでなく目的に応じてここに作業を振り分けます。エージェントの説明として保存されます。",
  "Save charter": "役割説明を保存",
  "Callable connections": "呼び出し可能な接続",
  "Provider": "プロバイダー",
  "Auth": "認証",
  "Tools": "ツール",
  "Quick checks": "簡易チェック",
  "no enabled connections found for selected scopes": "選択したスコープに有効な接続が見つかりません",
  "Token rotated": "トークンをローテーションしました",
  "✓ Token rotated for <code>{name}</code>": "✓ <code>{name}</code> のトークンをローテーションしました",
  "Old token invalidated": "古いトークンを無効化しました",
  "The old token (prefix <code>{prefix}...</code>) is no longer valid. Any system still using it will get <code>401 authentication required</code>.":
    "古いトークン（プレフィックス <code>{prefix}...</code>）は無効になりました。まだ使用しているシステムは <code>401 authentication required</code> を受け取ります。",
  "New token (save this — shown once!)": "新しいトークン（保存してください。表示は一度だけ！）",
  "Use as <code>Authorization: Bearer {token}</code> when calling <code>/mcp</code>.":
    "<code>/mcp</code> を呼び出す際に <code>Authorization: Bearer {token}</code> として使用します。",
  "Save this token now. If you lose it, you'll need to rotate again.":
    "今すぐこのトークンを保存してください。失うと、再度ローテーションが必要になります。",
  "Test the new token": "新しいトークンをテスト",
  "no agents selected": "エージェントが選択されていません",
  "Bulk deleted": "一括削除しました",
  "✓ Bulk deleted {count} agent(s)": "✓ {count} 件のエージェントを一括削除しました",
  "{count} skipped — not yours or not found": "{count} 件をスキップしました（あなたのものではないか、見つかりません）",
  "Back to all agents": "すべてのエージェントに戻る",

  // ── Scope edit page (/tenants/:scope/edit) ─────────────────────────────
  "Edit {scope}": "{scope} を編集",
  "Edit scope": "スコープを編集",
  "Edit the scope's display labels and provider connections. To add a new service, scroll down.":
    "スコープの表示ラベルとプロバイダー接続を編集します。新しいサービスを追加するには下にスクロールしてください。",
  "Re-authorized": "再認証しました",
  "The connection's access token (and refresh token) have been refreshed.":
    "接続のアクセストークン（およびリフレッシュトークン）を更新しました。",
  "Manage the internal tokens that can access this scope through MCP.":
    "MCP 経由でこのスコープにアクセスできる内部トークンを管理します。",
  "No Codex MCP token exists for this scope yet.": "このスコープにはまだ Codex MCP トークンがありません。",
  "Create Codex MCP token": "Codex MCP トークンを作成",
  "{count} token(s) can access this scope.": "{count} 件のトークンがこのスコープにアクセスできます。",
  "Internal token": "内部トークン",
  "Rotate Codex MCP token for {scope}?\\n\\nThe old token will stop working immediately.":
    "{scope} の Codex MCP トークンをローテーションしますか？\\n\\n古いトークンは直ちに使用できなくなります。",
  "Rotate token": "トークンをローテーション",
  "The slug <code>{scope}</code> is the wire key agents send as <code>scope</code> / <code>X-Grantry-Scope</code> — it cannot be changed. The display name is only for dashboards and can be renamed freely.":
    "スラッグ <code>{scope}</code> は、エージェントが <code>scope</code> / <code>X-Grantry-Scope</code> として送信するワイヤーキーであり、変更できません。表示名はダッシュボード用のみで、自由に変更できます。",
  "Display name": "表示名",
  "What this scope is for": "このスコープの用途",
  "No connections yet. Add one below.": "まだ接続がありません。下から追加してください。",
  "Credential": "認証情報",
  "Enabled": "有効",
  "Google Ads Developer token:": "Google Ads Developer トークン:",
  "set": "設定済み",
  "missing": "未設定",
  "Paste Developer token from Google Ads API Center": "Google Ads API Center の Developer token を貼り付け",
  "Save token": "トークンを保存",
  "clear saved developer token": "保存済みの Developer token を削除",
  "on": "有効",
  "Re-run the OAuth consent flow and refresh this exact connection's tokens":
    "OAuth 同意フローを再実行し、この接続のトークンを更新します",
  "Save this provider's OAuth app settings before reconnecting":
    "再接続する前に、このプロバイダーの OAuth アプリ設定を保存してください",
  "Re-run credential validation without showing the saved token":
    "保存済みトークンを表示せずに認証情報の検証を再実行します",
  "Recheck": "再チェック",
  "Delete": "削除",
  "Delete only this connection": "この接続のみを削除",
  "↻ <b>Reconnect</b> re-runs the provider's OAuth consent screen and refreshes this connection's access/refresh tokens in place. <b>Delete</b> removes only that credential connection; agents remain.":
    "↻ <b>再接続</b> はプロバイダーの OAuth 同意画面を再実行し、この接続のアクセス／リフレッシュトークンをその場で更新します。<b>削除</b> はその認証情報の接続のみを削除し、エージェントは残ります。",
  "Agents use explicit connection grants. Provider permissions come from each credential itself; Grantry does not maintain separate per-tool switches here.":
    "エージェントは明示的な接続の付与を使用します。プロバイダーの権限は各認証情報自体によって決まり、grantry はここでツールごとの個別スイッチを保持しません。",
  "No provider connections yet.": "まだプロバイダー接続がありません。",
  "{count} connection(s) available for this scope.": "このスコープで {count} 件の接続が利用可能です。",
  "Save settings": "設定を保存",
  "Delete connection {label}?\n\nProvider: {provider}\nScope: {scope}\n\nRelated agent connection grants will be removed automatically.":
    "接続 {label} を削除しますか？\n\nプロバイダー: {provider}\nスコープ: {scope}\n\n関連するエージェントの接続付与は自動的に削除されます。",
  "Advanced: additional agent token": "詳細設定: 追加のエージェントトークン",
  "Create an extra internal agent token with grants to this scope's enabled connections.":
    "このスコープの有効な接続への付与を持つ、追加の内部エージェントトークンを作成します。",
  "e.g. {scope}-read-bot": "例: {scope}-read-bot",
  "Globally unique. Suggestions: <code>{scope}-read</code>, <code>{scope}-write</code>, <code>{scope}-ci</code>.":
    "グローバルに一意である必要があります。候補: <code>{scope}-read</code>、<code>{scope}-write</code>、<code>{scope}-ci</code>。",
  "What this agent is for": "このエージェントの用途",
  "Tool visibility is derived from this scope's granted connections. Provider credentials may still reject calls if their own permissions are narrower.":
    "ツールの表示範囲は、このスコープに付与された接続から導出されます。プロバイダーの認証情報自体の権限がより狭い場合、呼び出しが拒否されることがあります。",
  "Create additional token": "追加のトークンを作成",
  "Danger zone": "危険な操作",
  "Delete this scope entirely. This removes <b>all your connections</b> for scope <code>{scope}</code>; related agent connection grants are removed automatically.":
    "このスコープを完全に削除します。スコープ <code>{scope}</code> の<b>あなたのすべての接続</b>が削除され、関連するエージェントの接続付与も自動的に削除されます。",
  "Delete scope {scope}?\\n\\nThis removes all YOUR connections for this scope and related grants. This action cannot be undone.":
    "スコープ {scope} を削除しますか？\\n\\nこのスコープのあなたのすべての接続と関連する付与が削除されます。この操作は取り消せません。",
  "Delete scope {scope}": "スコープ {scope} を削除",
  "Add a service": "サービスを追加",
  "No enabled providers are available for this workspace.":
    "このワークスペースで利用可能な有効なプロバイダーがありません。",
  "Enable or add providers from <a href=\"/providers\">Providers</a>.":
    "<a href=\"/providers\">プロバイダー</a>から有効化または追加してください。",
  "Coming soon:": "近日対応:",
  "New service": "新しいサービス",
  "Search providers…": "プロバイダーを検索…",
  "Search providers": "プロバイダーを検索",
  "No providers match.": "一致するプロバイダーがありません。",
  "Creates a new scope-scoped connection using the selected workspace credential.":
    "選択したワークスペースの認証情報を使用して、新しいスコープ単位の接続を作成します。",
  "🔗 Get a new token here →": "🔗 新しいトークンをこちらで取得 →",
  "🔗 Register/manage OAuth app here →": "🔗 OAuth アプリをこちらで登録／管理 →",
  "Create the OAuth app in the provider console, copy the redirect URI below into that app, then paste the issued Client ID and Client Secret here.":
    "プロバイダーのコンソールで OAuth アプリを作成し、下のリダイレクト URI をそのアプリにコピーしてから、発行された Client ID と Client Secret をここに貼り付けてください。",
  "Copy": "コピー",
  "Impersonate admin email (subject)": "代理する管理者メール（subject）",
  "The Workspace admin whose authority the service account acts as (Domain-Wide Delegation). Must be a real admin in the customer's domain.":
    "サービスアカウントがその権限で動作する Workspace 管理者です（ドメイン全体の委任）。顧客のドメインの実在する管理者である必要があります。",
  "This creates a provider connection. Agents get access when this connection is granted to them; provider permissions are enforced by the credential itself.":
    "これによりプロバイダー接続が作成されます。エージェントはこの接続が付与されるとアクセスできるようになります。プロバイダーの権限は認証情報自体によって適用されます。",
  "Add service": "サービスを追加",
  "OAuth connection updated.": "OAuth 接続を更新しました。",
  "Use existing:": "既存を使用:",
  "Paste a new credential instead": "代わりに新しい認証情報を貼り付ける",
  "Google Ads Developer token is separate from OAuth. After OAuth, paste the API Center token into the Google Ads connection row.":
    "Google Ads Developer token は OAuth とは別です。OAuth の後、API Center のトークンを Google Ads の接続行に貼り付けてください。",
  "Open API Center →": "API Center を開く →",
  "Paste the full service account JSON key file ({ \"type\": \"service_account\", ... })":
    "サービスアカウントの JSON キーファイル全体を貼り付けてください（{ \"type\": \"service_account\", ... }）",
  "Connect with OAuth": "OAuth で接続",
  "Domain-Wide Delegation: the customer's Workspace admin authorizes this service account's client ID + scopes once in their Admin console. No per-user OAuth, no 7-day token expiry.":
    "ドメイン全体の委任: 顧客の Workspace 管理者が、管理コンソールでこのサービスアカウントのクライアント ID とスコープを一度承認します。ユーザーごとの OAuth や 7 日間のトークン期限はありません。",
  "Copied": "コピーしました",

  // ── Page-header kickers + agents list page (/agents) ───────────────────
  "Automation": "オートメーション",
  "Observability": "オブザーバビリティ",
  "Self-management": "セルフ管理",
  "Overview": "概要",
  "Settings": "設定",
  "Every agent that can call this workspace over MCP, the connections granted to it, and the scopes it can reach.":
    "このワークスペースを MCP 経由で呼び出せるエージェントと、付与された接続、到達可能なスコープの一覧です。",
  "With grants": "接続あり",
  "Needs grant": "接続なし",

  // ── Scopes list page (/tenants) ────────────────────────────────────────
  "Workspace wiring": "ワークスペースの構成",
  "Manage each scope's connected services and agent-ready status. API wiring is available at <code>GET /api/scopes</code>.":
    "各スコープの接続済みサービスとエージェント利用可否を管理します。API 連携は <code>GET /api/scopes</code> で利用できます。",
  "Services": "サービス",
  "Enabled services": "有効なサービス",
  "Needs agent grant": "エージェント付与が必要",
  'No scopes yet. <a href="/tenants/new">Create your first one</a>.':
    'まだスコープがありません。<a href="/tenants/new">最初のスコープを作成</a>してください。',
  "Select all": "すべて選択",
  "Latest": "最新",
  "Legacy connections": "レガシー接続",
  "unscoped": "スコープなし",
  "No services": "サービスなし",
  "no agent": "エージェントなし",
  "Enabled, but no enabled agent has a grant to this connection.":
    "有効ですが、この接続への付与を持つ有効なエージェントがありません。",
  "Edit": "編集",

  // ── Scope connect page (/tenants/:scope/connect/:provider) ─────────────
  "← Back to scope": "← スコープに戻る",
  "Provider not available": "プロバイダーは利用できません",
  "{provider} is not available yet": "{provider} はまだ利用できません",
  "Provider disabled": "プロバイダーは無効です",
  "{provider} is disabled for this workspace": "{provider} はこのワークスペースで無効になっています",
  'Enable it from <a href="/providers">Providers</a> first.':
    'まず<a href="/providers">プロバイダー</a>から有効化してください。',
  "OAuth unavailable": "OAuth は利用できません",
  "{provider} does not support OAuth": "{provider} は OAuth に対応していません",
  "← Paste a token instead": "← 代わりにトークンを貼り付ける",
  "🔗 Get a token / credential here →": "🔗 トークン／認証情報をこちらで取得 →",
  "Prefer to authorize instead?": "代わりに認可しますか？",
  "Connect {provider} with OAuth →": "{provider} を OAuth で接続 →",
  "Connect {provider}": "{provider} を接続",
  "This connects <code>{provider}</code> to scope <code>{scope}</code> and grants it to that scope's agents automatically.":
    "<code>{provider}</code> をスコープ <code>{scope}</code> に接続し、そのスコープのエージェントに自動的に付与します。",
  "Connect": "接続",

  // ── Agent setup page (/tenants/:scope/agents/setup) ────────────────────
  "scope '{scope}' not found": "スコープ '{scope}' が見つかりません",
  "Set up agents": "エージェントを設定",
  "Set up agents for": "次のスコープのエージェントを設定:",
  "Step 2: create an agent for this scope, or assign an existing agent to this scope's enabled connections.":
    "ステップ 2: このスコープ用のエージェントを作成するか、既存のエージェントをこのスコープの有効な接続に割り当てます。",
  "✓ Scope <code>{scope}</code> is ready.": "✓ スコープ <code>{scope}</code> の準備ができました。",
  "Connected <code>{connected}</code>.": "<code>{connected}</code> を接続しました。",
  "✓ Existing agent granted {count} connection(s).":
    "✓ 既存のエージェントに {count} 件の接続を付与しました。",
  "{count} enabled connection(s)": "{count} 件の有効な接続",
  "No enabled connections yet. {link} before this scope can be used by an agent.":
    "まだ有効な接続がありません。このスコープをエージェントが使用する前に {link} してください。",
  "Create new agent": "新しいエージェントを作成",
  "e.g. {scope}-agent": "例: {scope}-agent",
  "Globally unique. This creates a new token and grants this scope's enabled connections.":
    "グローバルに一意である必要があります。新しいトークンを作成し、このスコープの有効な接続を付与します。",
  "Assign existing agent": "既存のエージェントを割り当て",
  "No unassigned agents are available in this workspace. Create a new agent above.":
    "このワークスペースには未割り当てのエージェントがありません。上で新しいエージェントを作成してください。",
  "The selected agent keeps its existing token. Grantry only adds connection grants for this scope.":
    "選択したエージェントは既存のトークンを維持します。grantry はこのスコープの接続付与を追加するだけです。",
  "Grant this scope": "このスコープを付与",
  "No unassigned agents to add.": "追加できる未割り当てのエージェントがありません。",
  "Need a brand-new agent instead?": "新しいエージェントを作りたいですか？",
  "Back to scopes": "スコープ一覧に戻る",

  // ── Assignments (people × agents) ──────────────────────────────────────
  "Assignments": "割り当て",
  "Only workspace owners and admins can manage person-to-agent assignments.":
    "メンバーとエージェントの割り当てを管理できるのは、ワークスペースのオーナーと管理者のみです。",
  "{count} assigned": "{count} 件割り当て済み",
  "+{count} more": "ほか {count} 件",
  "No agents assigned": "割り当てられたエージェントはありません",
  "Search agents": "エージェントを検索",
  "Search agents for {email}": "{email} に割り当てるエージェントを検索",
  "Assigned to this person": "このメンバーに割り当て済み",
  "Not assigned": "未割り当て",
  "No enabled agents in this workspace yet.": "このワークスペースにはまだ有効なエージェントがありません。",
  "No workspace members yet.": "まだワークスペースにメンバーがいません。",
  "Open workspace settings": "ワークスペース設定を開く",
  "People × Agents": "メンバー × エージェント",
  "Manage which workspace members can act as which agents. Provider permissions still come from each agent's granted connections and each provider's own ACLs.":
    "どのワークスペースメンバーがどのエージェントとして実行できるかを管理します。プロバイダー側の権限は、これまで通り各エージェントに付与された接続と各プロバイダー自身の ACL で決まります。",
  "Workspace settings": "ワークスペース設定",
  "Agent assigned": "エージェントを割り当てました",
  "Agent unassigned": "エージェントの割り当てを解除しました",
  "assigned": "割り当て済み",
  "This agent is assigned to you. You can view its callable connections, but only workspace owners and admins can manage grants, tokens, charter, or runbook.":
    "このエージェントはあなたに割り当てられています。呼び出し可能な接続は閲覧できますが、付与・トークン・チャーター・ランブックを管理できるのはワークスペースのオーナーと管理者のみです。",

  // ── Email verification ─────────────────────────────────────────────────
  "Verify <b>{email}</b> before accepting this workspace invite.":
    "このワークスペース招待を承認する前に <b>{email}</b> を確認してください。",
  "Open email verification": "メールアドレスの確認を開く",
  "Verify email": "メールアドレスを確認",
  "Verify your email": "メールアドレスを確認してください",
  "Open the verification link we sent to <b>{email}</b>. You need a verified email address before using grantry dashboards, workspace invites, or MCP OAuth.":
    "<b>{email}</b> に送信した確認リンクを開いてください。grantry のダッシュボード、ワークスペース招待、MCP OAuth を使うには、確認済みのメールアドレスが必要です。",
  "your email": "あなたのメールアドレス",
  "Resend verification email": "確認メールを再送",
  "Verification email sent.": "確認メールを送信しました。",
  "Could not send verification email": "確認メールを送信できませんでした",

  // ── OAuth sign-in / OAuth apps ─────────────────────────────────────────
  "Continue with Google": "Google で続行",
  "Continue with GitHub": "GitHub で続行",
  "or": "または",
  "OAuth sign-in failed": "OAuth サインインに失敗しました",
  "OAuth sign-in failed: {error}": "OAuth サインインに失敗しました: {error}",
  "Save changes": "変更を保存",
  "Remove this OAuth app?": "この OAuth アプリを削除しますか？",
  "Add another OAuth app": "別の OAuth アプリを追加",
  "Register this workspace's OAuth app": "このワークスペースの OAuth アプリを登録",
  "via": "経由:",
  "OAuth app removed — reconnect": "OAuth アプリが削除されました — 再接続してください",
  "app unknown — reconnect to bind": "アプリ不明 — 再接続して紐付けてください",
  "Connect from an OAuth app above": "上の OAuth アプリから接続してください",
  "OAuth app not found": "OAuth アプリが見つかりません",

  // ── Access / workspace guards ──────────────────────────────────────────
  "Access limited": "アクセスが制限されています",
  "Workspace required": "ワークスペースが必要です",
  "Create or join a workspace before managing grantry admin API keys.":
    "grantry 管理 API キーを管理するには、先にワークスペースを作成するか参加してください。",
  "Workspace owner or admin required": "ワークスペースのオーナーまたは管理者権限が必要です",

  // ── Connection config values ───────────────────────────────────────────
  "This provider's API is scoped per connection. Provide the value(s) below — they are stored with this connection (not secret) and filled into the request path automatically.":
    "このプロバイダーの API は接続ごとにスコープが分かれています。以下の値を入力してください。値はこの接続に保存され（シークレットではありません）、リクエストパスに自動的に埋め込まれます。",
  "This provider's API is scoped per connection. Values are stored with this connection (not secret) and filled into the request path automatically.":
    "このプロバイダーの API は接続ごとにスコープが分かれています。値はこの接続に保存され（シークレットではありません）、リクエストパスに自動的に埋め込まれます。",
  "Configuration value required": "設定値が必要です",

  // ── Agent page: individual connection grants ───────────────────────────
  "Add individual connections": "接続を個別に追加",
  "Every enabled connection available to this agent is already granted.":
    "このエージェントが利用できる有効な接続は、すべて付与済みです。",
  "Grant single connections instead of a whole scope — the agent reaches only what you tick. Use this when it needs one tool from a scope that also holds unrelated credentials.":
    "スコープ全体ではなく接続を 1 件ずつ付与します。エージェントはチェックした接続にのみ到達できます。無関係な認証情報も含むスコープから 1 つのツールだけ使わせたい場合に使ってください。",
  "Grant selected connections": "選択した接続を付与",
  "No enabled connection is callable by this agent. Grant at least one connection to enable provider tools.":
    "このエージェントが呼び出せる有効な接続がありません。プロバイダーツールを有効にするには、少なくとも 1 件の接続を付与してください。",
  "Remove {provider} ({scope}) from agent {name}? The agent loses these tools on its next request.":
    "エージェント {name} から {provider}（{scope}）を削除しますか？次のリクエストからこれらのツールは使えなくなります。",
  "select at least one connection": "接続を 1 件以上選択してください",
  "Granted {count} connection(s)": "{count} 件の接続を付与しました",
  "Removed {count} connection(s)": "{count} 件の接続を削除しました",

  // ── Runbook / skill bundle ─────────────────────────────────────────────
  "Runbook": "ランブック",
  "The instructions that define what this agent does and how. Served over MCP via <code>grantry_get_runbook</code>, so whoever holds this agent's token can run it by connecting the MCP alone — no repo handoff. Distinct from the grantry platform manual (<code>grantry_get_skill</code>).":
    "このエージェントが「何を・どうやるか」を定義する指示書です。MCP 経由で <code>grantry_get_runbook</code> として配信されるため、このエージェントのトークンを持つ人は MCP に接続するだけで実行できます。リポジトリの引き渡しは不要です。grantry プラットフォームのマニュアル（<code>grantry_get_skill</code>）とは別物です。",
  "Upload a skill bundle": "スキルバンドルをアップロード",
  "a <code>.skill</code> or <code>.zip</code> (SKILL.md + references/ + scripts/ + assets/). Recipients fetch the files via <code>grantry_get_runbook_file</code> and reconstruct the skill directory.":
    "<code>.skill</code> または <code>.zip</code>（SKILL.md + references/ + scripts/ + assets/）。受け取り側は <code>grantry_get_runbook_file</code> でファイルを取得し、スキルディレクトリを再構築します。",
  "Upload skill bundle": "スキルバンドルをアップロード",
  "Or a single SKILL.md": "または SKILL.md 単体",
  "for a self-contained runbook with no bundled files.": "同梱ファイルのない自己完結型のランブック向け。",
  "Save runbook": "ランブックを保存",
  "Remove the uploaded skill bundle?": "アップロード済みのスキルバンドルを削除しますか？",
  "Remove bundle": "バンドルを削除",
  "No file uploaded": "ファイルがアップロードされていません",
  "Could not read the file as a .zip/.skill archive": ".zip / .skill アーカイブとして読み込めませんでした",
  "No SKILL.md found in the bundle": "バンドル内に SKILL.md が見つかりません",
  "A skill bundle must contain a SKILL.md at its root.": "スキルバンドルのルートには SKILL.md が必要です。",
  "agent name required": "エージェント名は必須です",

  // ── MCP config block ───────────────────────────────────────────────────
  "Copy {label}": "{label} をコピー",
  "The full token is only shown when the agent is created or rotated.":
    "トークンの全文は、エージェントの作成時またはローテーション時にのみ表示されます。",
  "MCP config": "MCP 設定",
  "This entry is locked to <code>{scope}</code> by <code>X-Grantry-Scope</code>: its tool list is trimmed to that scope, and a call passing any other <code>scope</code> is refused. Tool names stay stable.":
    "このエントリは <code>X-Grantry-Scope</code> により <code>{scope}</code> に固定されています。ツール一覧はそのスコープに絞られ、別の <code>scope</code> を渡す呼び出しは拒否されます。ツール名は変わりません。",
  "One entry per agent. The token decides what it can reach across every scope it holds, and each call picks its scope via the <code>scope</code> argument.":
    "エージェントごとに 1 エントリです。トークンが保持する全スコープへの到達範囲を決め、各呼び出しは <code>scope</code> 引数でスコープを選びます。",
  "MCP endpoint: <code>{origin}/mcp</code> — authenticate with <code>Authorization: Bearer &lt;token&gt;</code>.":
    "MCP エンドポイント: <code>{origin}/mcp</code> — <code>Authorization: Bearer &lt;token&gt;</code> で認証します。",
  "These snippets are <b>incomplete</b>: the token is stored hashed, so its plaintext exists only at the moment it is minted. Paste your saved token over <code>&lt;PASTE_YOUR_TOKEN_HERE&gt;</code>, or <a href=\"/agents\">rotate this agent</a> to mint a fresh one — rotating invalidates the current token immediately.":
    "このスニペットは<b>未完成</b>です。トークンはハッシュ化して保存されるため、平文は発行された瞬間にしか存在しません。保存しておいたトークンを <code>&lt;PASTE_YOUR_TOKEN_HERE&gt;</code> に貼り付けるか、<a href=\"/agents\">このエージェントをローテーション</a>して新しいトークンを発行してください。ローテーションすると現在のトークンは即座に無効になります。",
  "Recommended — fastest": "推奨 — 最速",
  "Run this one line in your terminal. It registers the server in <code>~/.claude.json</code> and Claude Code can use it right away — no manual file editing.":
    "ターミナルでこの 1 行を実行してください。サーバーが <code>~/.claude.json</code> に登録され、Claude Code からすぐに使えます。ファイルの手動編集は不要です。",
  "Claude Code — manual JSON": "Claude Code — JSON を手動編集",
  "Prefer editing the config file directly? Merge this entry under <code>mcpServers</code>.":
    "設定ファイルを直接編集したい場合は、このエントリを <code>mcpServers</code> の下にマージしてください。",
  "This config includes the newly minted token. <code>Mcp-Session-Id</code> is managed by the MCP client/server handshake.":
    "この設定には発行されたばかりのトークンが含まれています。<code>Mcp-Session-Id</code> は MCP クライアント/サーバーのハンドシェイクが管理します。",

  // ── Personal MCP tokens page ───────────────────────────────────────────
  "MCP configuration": "MCP 設定",
  "This is your personal MCP token. It can use only the agents currently assigned to you. Assignments change access immediately; this token never grants an unassigned agent.":
    "これはあなた個人の MCP トークンです。現在あなたに割り当てられているエージェントだけを使用できます。割り当ての変更は即座にアクセスに反映され、未割り当てのエージェントがこのトークンで使えることはありません。",
  "Endpoint:": "エンドポイント:",
  "When more than one agent is available, MCP lists them and asks the client to pass <code>agent_id</code> for the provider call.":
    "複数のエージェントが利用可能な場合、MCP が一覧を返し、プロバイダー呼び出し時に <code>agent_id</code> を渡すようクライアントに求めます。",
  "MCP tokens": "MCP トークン",
  "Create one personal token for this workspace, then use every agent assigned to you here from the same MCP connection.":
    "このワークスペース用の個人トークンを 1 つ作成すれば、割り当てられたすべてのエージェントを同じ MCP 接続から使えます。",
  "Joined <b>{workspace}</b>. Your assigned agents are ready below; create your personal MCP token to connect.":
    "<b>{workspace}</b> に参加しました。割り当てられたエージェントは下に表示されています。接続するには個人の MCP トークンを作成してください。",
  "Token revoked.": "トークンを無効化しました。",
  "A new personal token was issued. It is shown below once.":
    "新しい個人トークンを発行しました。下に一度だけ表示されます。",
  "Your active token": "有効なトークン",
  "For security the plaintext is shown only when it is created. Rotate it if you need a new copy.":
    "セキュリティのため、平文は作成時にのみ表示されます。新しいコピーが必要な場合はローテーションしてください。",
  "Rotate personal token": "個人トークンをローテーション",
  "Create your personal token": "個人トークンを作成",
  "This token belongs only to {email}. It is not visible to workspace admins.":
    "このトークンは {email} だけのものです。ワークスペースの管理者からは見えません。",
  "No agents are assigned yet": "まだエージェントが割り当てられていません",
  "Create MCP token": "MCP トークンを作成",
  "Personal MCP token": "個人 MCP トークン",
  "Your personal MCP token": "あなたの個人 MCP トークン",
  "This token is scoped to <b>{workspace}</b> and shown once. Workspace admins cannot retrieve it.":
    "このトークンは <b>{workspace}</b> にスコープされ、一度だけ表示されます。ワークスペースの管理者は取得できません。",
  "Save this token now. Rotating or revoking it disconnects every MCP client using it.":
    "このトークンを今すぐ保存してください。ローテーションまたは無効化すると、これを使うすべての MCP クライアントが切断されます。",
  "🔑 Personal MCP token (save this — shown once!)": "🔑 個人 MCP トークン（保存してください — 表示は一度だけ！）",
  "Back to MCP tokens": "MCP トークン一覧に戻る",
  "Agents available to you": "利用できるエージェント",
  "Your token can act only through these agents in <b>{workspace}</b>. Workspace admins manage this list from Assignments.":
    "あなたのトークンは、<b>{workspace}</b> のこれらのエージェントを通じてのみ実行できます。この一覧はワークスペース管理者が「割り当て」から管理します。",
  "Personal": "個人",
  "No assigned agents yet": "まだ割り当てられたエージェントがありません",
  "Ask a workspace owner or admin to assign an agent to you. Issuing a token before that does not grant access.":
    "ワークスペースのオーナーまたは管理者にエージェントの割り当てを依頼してください。割り当て前にトークンを発行してもアクセスは付与されません。",
  "Token history": "トークン履歴",
  "Token": "トークン",
  "revoked": "無効化済み",
  "active": "有効",
  "Revoke this MCP token? Existing MCP clients will lose access immediately.":
    "この MCP トークンを無効化しますか？既存の MCP クライアントは即座にアクセスを失います。",

  // ── Custom provider form ───────────────────────────────────────────────
  "Provider key": "プロバイダーキー",
  "API base URL": "API ベース URL",
  "Auth style": "認証方式",
  "API key header": "API キーヘッダー",
  "API key query parameter": "API キークエリパラメータ",
  "API key header or query parameter": "API キーのヘッダー名またはクエリパラメータ名",
  "Allowed path prefixes": "許可するパスプレフィックス",
  "Connection check path": "接続チェック用パス",
  "Token settings URL": "トークン設定ページの URL",
  "Define a workspace-level provider that can be added to scopes from the service picker.":
    "サービス選択画面からスコープに追加できる、ワークスペースレベルのプロバイダーを定義します。",
  "Add default {label}": "既定の{label}を追加",
  "Creates a <code>{scope}</code> scope connection. Leave blank only when one existing workspace credential can be reused.":
    "<code>{scope}</code> スコープの接続を作成します。既存のワークスペース認証情報を 1 件再利用できる場合のみ空欄にしてください。",
  "Create default connection": "既定の接続を作成",

  // ── Connector agent picker ─────────────────────────────────────────────
  "No agents": "エージェントがありません",
  "No enabled agents": "有効なエージェントがありません",
  "This connector must act as one of your grantry agents, but your account has none enabled. Create an agent in the <a href=\"/dashboard\">dashboard</a>, then retry the connection.":
    "このコネクターは grantry エージェントのいずれかとして動作する必要がありますが、アカウントに有効なエージェントがありません。<a href=\"/dashboard\">ダッシュボード</a>でエージェントを作成し、接続をやり直してください。",
  "Choose agent": "エージェントを選択",
  "Connect {name}": "{name} を接続",
  "{name} will act as the agent you choose, using that agent's granted connections exactly as configured in the dashboard. You can change or revoke this anytime.":
    "{name} は選択したエージェントとして動作し、ダッシュボードで設定された通りにそのエージェントに付与された接続を使用します。この設定はいつでも変更・取り消しできます。",

  // ── Scope wizard details ───────────────────────────────────────────────
  "Creates a new scope-scoped connection that uses the selected workspace credential.":
    "選択したワークスペース認証情報を使う、スコープ単位の接続を新規作成します。",
  "♻️ Reusing the existing <code class=\"reusing-label\"></code> connection.":
    "♻️ 既存の <code class=\"reusing-label\"></code> 接続を再利用します。",
  "rotate credential": "認証情報をローテーション",
  " to paste a new one.": "すると新しい値を貼り付けられます。",
  "🔗 Register/manage your {label} OAuth app here →": "🔗 {label} の OAuth アプリの登録・管理はこちら →",

  // ── Scope key validation page ──────────────────────────────────────────
  "⚠️  Scope key {key}can't be used": "⚠️  スコープキー {key}は使用できません",
  "The <b>scope key</b> is the immutable key your agents send with every API call, so it's restricted to <b>lowercase letters, numbers, hyphens, and underscores</b> (<code>a-z 0-9 - _</code>). Japanese and other non-ASCII characters aren't allowed here.":
    "<b>スコープキー</b>はエージェントがすべての API 呼び出しで送信する不変のキーのため、<b>小文字英字・数字・ハイフン・アンダースコア</b>（<code>a-z 0-9 - _</code>）に制限されています。日本語などの非 ASCII 文字はここでは使えません。",
  "👉 Put the Japanese (or any human-friendly) name in the <b>Display name</b> field instead — that's shown in dashboards and can be renamed anytime.":
    "👉 日本語（や人間向けの名前）は<b>表示名</b>欄に入れてください。表示名はダッシュボードに表示され、いつでも変更できます。",
  "Suggested scope key based on what you typed: <code>{suggestion}</code>":
    "入力内容から提案するスコープキー: <code>{suggestion}</code>",
  "Example: scope key <code>kaihatsu</code> · display name <code>{name}</code>":
    "例: スコープキー <code>kaihatsu</code> · 表示名 <code>{name}</code>",
  "← Back to the wizard": "← ウィザードに戻る",

  // ── OAuth / error pages ────────────────────────────────────────────────
  "Google sign-in not configured": "Google サインインが設定されていません",
  "Set <code>AUTH_GOOGLE_CLIENT_ID</code> / <code>AUTH_GOOGLE_CLIENT_SECRET</code>.":
    "<code>AUTH_GOOGLE_CLIENT_ID</code> / <code>AUTH_GOOGLE_CLIENT_SECRET</code> を設定してください。",
  "← Back": "← 戻る",
  "Scope must match <code>[a-z0-9_-]+</code>.": "スコープは <code>[a-z0-9_-]+</code> に一致する必要があります。",
  "OAuth state expired or invalid": "OAuth の状態が期限切れか無効です",
  "Try <a href=\"/tenants/new\">creating the scope</a> again.":
    "もう一度<a href=\"/tenants/new\">スコープの作成</a>をお試しください。",
  "connection not found for reconnect": "再接続対象の接続が見つかりません",
  "The requested connection does not belong to this scope/provider.":
    "指定された接続はこのスコープ/プロバイダーのものではありません。",
  "No scope or connections found for scope '{scope}' (yours)":
    "スコープ '{scope}' に該当するスコープまたは接続（あなたのもの）が見つかりません",

  // ── Scope / agent success pages ────────────────────────────────────────
  "✓ {label} connected · scope <code>{scope}</code> created":
    "✓ {label} を接続 · スコープ <code>{scope}</code> を作成しました",
  "Google Ads API token still required": "Google Ads API トークンがまだ必要です",
  "Open scope settings →": "スコープ設定を開く →",
  "Open Google Ads API Center →": "Google Ads API Center を開く →",
  "granted {count} connection(s)": "{count} 件の接続を付与済み",
  "← Back to scopes": "← スコープ一覧に戻る",
  "Manage agents": "エージェントを管理",
  "✓ Agent <code>{name}</code> can use <code>{scope}</code>":
    "✓ エージェント <code>{name}</code> が <code>{scope}</code> を使えるようになりました",
  "Granted {count} enabled connection(s) for this scope.":
    "このスコープの有効な接続を {count} 件付与しました。",
  "This agent keeps its existing token. The plaintext token cannot be shown again; rotate it from the agent page if you need a fresh copy.":
    "このエージェントは既存のトークンを維持します。平文のトークンは再表示できません。新しいコピーが必要な場合はエージェントページからローテーションしてください。",
  "Back to agent setup": "エージェント設定に戻る",
  "Open agent": "エージェントを開く",
  "✓ New agent <code>{name}</code> added to <code>{scope}</code>":
    "✓ 新しいエージェント <code>{name}</code> を <code>{scope}</code> に追加しました",
  "Reused the existing <code>{scope}</code> connection(s) — no new PAT/OAuth needed.":
    "既存の <code>{scope}</code> 接続を再利用しました。新しい PAT や OAuth は不要です。",
  "Granted {count} connection(s) for <code>{scope}</code>.":
    "<code>{scope}</code> の接続を {count} 件付与しました。",
  "Test it": "動作確認",
  "← Back to {scope}": "← {scope} に戻る",
  "Add another agent": "別のエージェントを追加",
  "Manage all agents": "すべてのエージェントを管理",

  // ── Delete notice pages ────────────────────────────────────────────────
  "Deleted": "削除しました",
  "✓ Deleted scope <code>{scope}</code>": "✓ スコープ <code>{scope}</code> を削除しました",
  "Removed <b>{count}</b> connection(s). Related connection grants were removed automatically.":
    "<b>{count}</b> 件の接続を削除しました。関連する接続付与は自動的に削除されました。",
  "Also removed {count} legacy role row(s).": "レガシーなロール行も {count} 件削除しました。",
  "← Back to all scopes": "← すべてのスコープに戻る",
  "✓ Bulk deleted {count} scope(s)": "✓ {count} 件のスコープを一括削除しました",
  "Total: <b>{count}</b> connection(s) removed. Related connection grants were removed automatically.":
    "合計 <b>{count}</b> 件の接続を削除しました。関連する接続付与は自動的に削除されました。",
};
