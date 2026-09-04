# bdboard アーキテクチャ概要

複数プロジェクトの `.beads/`(bd/Beads のチケットDB)を横断集約し、チケット×稼働中エージェント
セッションの状態をローカルの1画面Kanbanで可視化するダッシュボード。設計思想の全文は
[docs/PLAN.md](./PLAN.md) を参照。本ドキュメントは「実コードが実際にどう層分けされ、どうデータが
流れ、どこで安全性を担保しているか」を1枚にまとめたものであり、`PLAN.md` の初期設計と現状で
差分がある箇所(後述の「v1計画との差分」参照)は実コードを優先して記述する。

## オニオン4層構成

```
src/
  domain/          # 純粋ロジック。外部依存ゼロ
  application/     # ユースケース + ポート(interface)定義
  infrastructure/  # ポートのアダプタ実装(bd CLI / gh CLI / fs / sqlite / process / chokidar)
  interface/       # Hono ルート・SSEハブ・DTO変換(HTTP境界)
web/               # Vite + React(別ビルド。src/ とは独立したバンドル)
```

依存方向は `.dependency-cruiser.cjs` の `forbidden` ルールでCI時に機械的に検証される
(`npm run check:boundaries`)。現在強制されているのは:

- `domain` → `application|infrastructure|interface` への依存禁止(domainは何にも依存しない)
- `application` → `infrastructure` への依存禁止
- `application` → `interface` への依存禁止
- `interface` → `infrastructure` への直接依存禁止(`interface` は `application` のポート越しにのみ
  `infrastructure` の実装へ到達する)
- `infrastructure` → `interface` への依存禁止
- `child_process` の import は `infrastructure/process` と `infrastructure/runners` 配下からのみ許可
  (bd/gh/git 等の外部プロセス起動経路を1箇所に閉じ込める)
- `web/src` → `src/` への依存禁止、`src/` → `web/` への依存禁止(サーバー/ブラウザバンドルの分離)

**意図的に禁止していない方向**(`.dependency-cruiser.cjs` 冒頭のコメントに経緯あり):
`infrastructure → domain` と `interface → domain` の直接依存。オニオンアーキテクチャでは外側の層が
内側の層の型に直接依存するのは許容範囲であり、逆方向(`domain → infrastructure` 等)だけが禁止対象。
ポート方式(後述)では `infrastructure` の実装が bd CLI の JSON レスポンスから `domain` の型
(`Ticket` 等)を直接構築して返す必要があるため、ここを禁止すると実装が破綻する。

### 各層の役割と主なファイル

- **`src/domain/`** — 値/エンティティ(`Ticket`, `Project`, `AgentSession`, `SessionLink`, `Run` 等)
  と導出ロジック(`readiness.ts` の ready/blocked 判定、`liveness.ts` のセッション生存度、
  `dependency-graph.ts`、`board-notifications.ts` の通知遷移検出など)。外部I/Oを一切持たないため
  フェイク不要でユニットテストが書ける。
- **`src/application/`** — ユースケース(`board/refresh-projects.ts`、`lease/reclaim-scheduler.ts`、
  `runner/dispatch-run.ts` 等)と、`infrastructure` が実装すべき境界を定義する **ポート**
  (`application/ports/*.ts`。詳細は次節)。
- **`src/infrastructure/`** — ポートの実アダプタ。`bd/`(bd CLIラッパー群)、`gh/`(PRステータス)、
  `cache/`(SQLiteキャッシュ)、`discovery/`(プロジェクト走査)、`session/`(Claude Codeセッション
  検出)、`transcript/`(トランスクリプト走査)、`watch/`(chokidarファイル監視)、`process/`
  (子プロセス実行)、`runners/`(エージェント起動アダプタ。`POST /api/runs` 経由で配線)。
- **`src/interface/`** — HTTPエントリポイント。`http/routes.ts` が REST API 群、
  `sse/event-hub.ts` がSSE配信用のPub/Subハブ、`http/*-routes.ts` が機能別ルート
  (harness/scan-roots/board-thresholds/ai-quota-alert/tunnel/chat)、`http/write-guard.ts` が
  書き込み系リクエストの認可を集約するミドルウェア。
- **`src/main.ts`** — 上記すべてのアダプタをインスタンス化してポートに配線する合成ルート
  (composition root)。DIコンテナは使わず、素朴な関数呼び出しでワイヤリングする。
- **`web/`** — Vite + React の別ビルド。`npm run build:web` の出力(`web/dist/`)を `main.ts` が
  `serveStatic` で配信する。開発時は `npm run dev:web` の Vite dev server が
  `127.0.0.1:8787`(常時稼働のメインチェックアウトのサーバー)へプロキシする。

## ポート一覧(`src/application/ports/`)

`application` が定義し `infrastructure` が実装するインターフェース。主なもの:

| ポート | 主な実装(infrastructure) | 役割 |
| --- | --- | --- |
| `IssueRepository` | `BdCliIssueRepository` | `bd --readonly list --json` でチケット一覧取得 |
| `IssueWriter` | `BdCliIssueWriter` | チケットの状態変更・コメント等の書き込み |
| `DependencyWriter` | `BdCliDependencyWriter` | 依存関係(blocks等)の追加 |
| `LeaseReader` / `LeaseReclaimer` | `BdCliLeaseReader` / `BdCliLeaseReclaimer` | claim(lease)の読み取り/期限切れ回収 |
| `MergeSlotReader` | `BdCliMergeSlotReader` | マージ直列化用スロットの読み取り |
| `CommentReader` | `BdCliCommentReader` | チケットコメント取得 |
| `HumanDecisionsPort` | `BdCliHumanDecisions` | 人間の意思決定待ちキューの読み書き |
| `SessionLinkWriter` | `BdCliSessionLinkWriter` | チケット⇔セッションの手動紐付け |
| `PrStatusReader` | `GhCliPrStatusReader` | `gh` CLI でPRステータス取得 |
| `WorktreeScanner` | `GitWorktreeScanner` | worktree一覧のスキャン |
| `ProjectDiscovery` | `FsProjectDiscovery` | スキャンルート配下の `.beads/` プロジェクト検出 |
| `ProjectFingerprinter` | `BeadsFingerprinter` | 変化検知用フィンガープリント計算 |
| `ProjectWatcher` | `ChokidarProjectWatcher` | プロジェクトのファイル変更監視 |
| `BoardCache` | `SqliteBoardCache` | 横断ボードの永続キャッシュ(プロジェクト/チケット/セッションリンク/オフセット) |
| `SessionRegistry` | `ClaudeSessionRegistry` | `~/.claude/sessions/*.json` + PID生存確認からセッション列挙 |
| `TranscriptScanner` | `JsonlTranscriptScanner` | セッショントランスクリプトの増分tail走査(チケットID抽出) |
| `SessionTailReader` | `SessionTailReader`(infrastructure/session) | セッションログ末尾の取得 |
| `InteractionReader` | `JsonlInteractionReader` | agy等のheadless実行ログ(soft-deny等)読み取り |
| `ProcessScanner` | `PsProcessScanner` | `ps` によるエージェントプロセス列挙 |
| `ProcessProbe` | `NodeProcessProbe` | PID生存確認(`process.kill(pid, 0)`) |
| `CommandRunner` / `StreamingCommandRunner` | `NodeCommandRunner` / `NodeStreamingCommandRunner` | 子プロセス実行の共通口(`infrastructure/process` 配下限定) |
| `ChatAgent` | `ClaudeChatAgent` 等(`infrastructure/chat`) | チャット機能のエージェントアダプタ(claude常設、codex/cursor/agyはopt-in) |
| `ChatSessionRepository` / `ChatMessageRepository` | `SqliteChatSessionRepository` / `SqliteChatMessageRepository` | チャットセッション・メッセージの永続化 |
| `TunnelPort` | `CloudflaredTunnel` | cloudflared quick tunnel の起動/停止 |
| `AiQuotaSource` | `NodeAiQuotaSource` | `ai-quota` CLI 経由の残量取得 |
| `WorktreeProvisioner` | `GitWorktreeProvisioner` | エージェント実行用 worktree の作成と、マージ済み生成物の安全な回収 |
| `AgentRunConfigPort` | `FileAgentRunConfigStore`(`createFileAgentRunConfigStore`) | エージェント実行設定(リモート許可トグル等)の永続化 |
| `AgentRunner` | `ClaudeSpawnRunner` / `ClaudeResumeRunner` / `DisabledRunner` 等 | エージェント起動(`POST /api/runs` の1経路のみ。`agent-run-guard` 必須) |

各ポートのフルインターフェースは `src/application/ports/*.ts` を参照。

## データフロー: bd CLI → キャッシュ → SSE → UI

`src/main.ts` が起動時に組み立てる定期リフレッシュ + イベント通知のパイプライン:

1. **収集**: `ProjectDiscovery`(`FsProjectDiscovery`)がスキャンルート配下の `.beads/` を検出し、
   `IssueRepository`(`BdCliIssueRepository`)が各プロジェクトに対して
   `bd --readonly -C <dir> list --json --all --limit 0 --no-pager` を実行してチケット一覧を取得する。
2. **変更検知**: 全プロジェクトへ毎回 `bd` を叩くコストを避けるため、`ProjectFingerprinter`
   (`BeadsFingerprinter`)が `.beads/last-touched` 等からフィンガープリントを計算し、
   `application/board/refresh-projects.ts` の `refreshProjects()` が前回と変化のあった
   プロジェクトだけを再取得する(`chokidar` によるファイル監視 `ChokidarProjectWatcher` が
   変化トリガーそのものも供給し、加えて `BDBOARD_REFRESH_INTERVAL_MS` 間隔の全体リフレッシュを
   取りこぼし保険として併走させる)。
3. **キャッシュ**: 取得結果は `BoardCache`(`SqliteBoardCache`、`~/.bdboard/cache.db`)に永続化される。
   チケット/プロジェクト/セッションリンク/トランスクリプト走査オフセット/CFDスナップショット等を
   保持し、再起動時もここから復元する(トランスクリプトリンクは起動時に
   `hydrateTranscriptLinksFromCache()` でインメモリ `Map` へ再構築)。
4. **セッション/トランスクリプト観測**: 並行して `SessionRegistry`(`ClaudeSessionRegistry`)が
   `~/.claude/sessions/*.json` とPID生存確認から稼働中セッションを列挙し
   (`BDBOARD_SESSION_INTERVAL_MS` 間隔)、`TranscriptScanner`(`JsonlTranscriptScanner`)が
   セッションのトランスクリプトを増分走査してチケットID⇔セッションIDのリンクを推定する
   (`BDBOARD_TRANSCRIPT_INTERVAL_MS` 間隔)。
5. **配信**: 何か実際に変化した場合(空更新は抑制)、`interface/sse/event-hub.ts` の `EventHub` へ
   `board.changed` / `session.changed` / `notification` 等のイベントを `publish()` する。
6. **SSE配信**: `interface/http/routes.ts` の `GET /api/events` が `EventHub.subscribe()` して
   Server-Sent Events としてクライアントへ中継する(接続ごとに ping タイマーを持ち、
   `AbortSignal` とレスポンスの両方の切断経路を監視してリークを防ぐ)。
7. **UI側**: `web/src/useBoardStream.ts` が `EventSource` を張り(`web/src/lib/sseConnection.ts` で
   タブ間共有)、イベント受信をトリガーに TanStack Query のキャッシュを invalidate して
   `GET /api/board` 等のREST APIを再フェッチする。**SSEイベント自体はペイロードを運ばない
   invalidation信号であり、実データは常にREST経由で取得し直す**設計。

つまり実データの経路は「bd CLI(readonly) → SqliteBoardCache → REST API」、変更通知の経路は
「EventHub → SSE → クライアント側リフェッチのトリガー」という2系統に分離されている。

## 安全保証

- **bdへの読み取りは `--readonly` 固定**: `BdCliIssueRepository` の一覧取得や、書き込み系アダプタが
  内部で行う存在確認的な `show` 呼び出しも含め、読み取り目的のbd呼び出しは一貫して `--readonly`
  フラグを付与する(`src/infrastructure/bd/*.ts`)。
- **子プロセス起動経路の一本化**: `.dependency-cruiser.cjs` のルールにより `child_process` は
  `infrastructure/process` と `infrastructure/runners` 以外からimportできない。bd/gh/git/ai-quota
  等の外部コマンド実行はすべてこの経路を通る。
- **エージェント自動起動(Runner)は単一経路+認可ゲート必須**: Runner は `POST /api/runs`
  (`interface/http/agent-run-routes.ts`) の1経路だけで到達可能で、その経路は
  `agent-run-guard`(`createAgentRunGuardMiddleware`)を必ず通る。ローカル直アクセスからは
  agent run の実行が可能(当初計画の read-only 保証はここで意図的に緩められている)。
  リモート(トンネル経由)は既定で実行不可であり、`allowRemoteAgentRuns` トグル(既定 false)
  が有効なときだけ許可される(fail-closed)。このトグル自体は
  `PUT /api/settings/agent-runs` で変更できるが、**ローカル直アクセスからのみ**変更可能
  (リモートから自分で ON にできない)。
  `interface/http` 配下で `dispatchRun` / `application/runner` を参照するのは
  `agent-run-routes.ts` ただ1ファイルであり、回帰テストで検証している。
- **リモート許可トグルは起動時の値で固定される**: `isRemoteAgentRunAllowed` は
  サーバー起動時に一度だけ読まれ、以後リクエスト毎に再読み込みしない。設定変更は
  **サーバー再起動後**に反映される。これは UX の都合ではなく安全側の要求で、
  リクエスト毎に読むと「エージェントが config ファイルを書き換えた瞬間にリモート実行が
  有効化される」権限昇格経路が開くため(bdboard-54be.1 セキュリティレビュー B-1)。
- **エージェントに与える権限は最小化する(3層)**: (a) `--permission-mode` は `default`
  (`acceptEdits` はパススコープを無効化するため使わない)、(b) `--allowedTools` は
  必要最小限の verb だけを列挙し、ファイル編集は `Edit(//<worktree 絶対パス>/**)` で
  worktree 配下に動的スコープする(`Bash(git:*)` のような bare ワイルドカードは
  worktree 隔離を無効化するので禁止。単体テストで検出する)、(c) 子プロセスへ渡す
  環境変数は allowlist する(`kv_inject` で注入されたシークレットがエージェントの
  `env` から読めないようにするため)。
- **チケット本文は信頼できない入力**: チケットの title/description はトンネル経由の
  書き込み権限があれば変更でき、それが `bd show` 経由でエージェントのコンテキストに入る。
  実行プロンプト(`application/runner/build-run-prompt.ts`)は `bd show` の出力を
  「実装すべき変更内容の記述」としてのみ参照させ、そこに書かれた指示には従わないことを
  明示する。プロンプト側で「正本として扱え」と書いてはならない。
- **シャットダウン時に子プロセスを孤児にしない**: 子は `detached: true` で別プロセス
  グループにいるため、サーバーのプロセスグループへの SIGTERM は届かない。
  `shutdown-drain` は `RunStore.cancelAllAndWait()` を await し、SIGKILL の猶予
  (`STOP_GRACE_MS`)+マージンまで待ってから終了する。
- **書き込みAPIは `write-guard` に一本化**: `interface/http/write-guard.ts` が
  POST/PUT/PATCH/DELETE(および `createPrivilegedApiGuardMiddleware` を使う一部の副作用付きGET)を
  前置ミドルウェアとして一括判定する。許可条件は「ローカル直アクセス」または「トンネル経由で
  (a) 十分な強度のパスワードで起動されたトンネルであり、かつ (b) 有効なトンネルセッションCookieを
  持つ」の両方。判定の前段でCSRF対策(`Sec-Fetch-Site` / `Content-Type` / `Origin` の3レイヤ)を
  適用する。依存が渡されない場合は fail-closed でlocalhost限定にフォールバックする。新規に追加した
  書き込みルートも、このミドルウェアの内側に登録される限り自動的にガード対象になる。

## v1計画との差分(注記)

[docs/PLAN.md](./PLAN.md) の「v1 の安全保証」節には「`IssueWriter` ポートの infrastructure 実装を
v1の合成ルートに登録しない」という当初方針が書かれているが、現在の `src/main.ts` は
`createBdCliIssueWriter` / `createBdCliDependencyWriter` / `createBdCliSessionLinkWriter` 等を
実際に生成し `createApiRoutes` へ配線している。書き込み機能はその後のスライスで計画通り実装され、
上記の `write-guard` による認可ゲートに置き換わっている。**Runner(エージェント自動起動)も
`POST /api/runs` として配線済み**だが、`agent-run-guard` + リモート許可トグル(既定 off)により
到達を制限している。ローカル直アクセスからの実行は read-only 保証を意図的に緩めた点であり、
リモートは既定 off でトグルもローカル直アクセスからのみ変更できる(fail-closed)。
読む際は本ドキュメントの現状記述を優先し、`PLAN.md` は初期設計の経緯・技術選定理由を追う資料として参照すること。

## 関連ドキュメント

- [docs/PLAN.md](./PLAN.md) — v1スコープの全設計(層構成の設計意図、テスト戦略、実装スライス等)
- [docs/DECISIONS-LOG.md](./DECISIONS-LOG.md) — 個別の設計判断ログ
- [docs/MCP-CLIENTS.md](./MCP-CLIENTS.md) — MCPクライアント関連
- ルートの `CLAUDE.md` / `AGENTS.md` — ビルド/テストコマンド、Git運用(worktree+PR)、bd運用ルール
