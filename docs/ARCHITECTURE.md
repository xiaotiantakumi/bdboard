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

`application` が定義し `infrastructure` が実装するインターフェース。全ポートモジュールを次に示す。

| ポート | 主な実装(infrastructure) | 役割 |
| --- | --- | --- |
| `IssueRepository` | `createBdCliIssueRepository` | `bd --readonly list --json` でチケット一覧取得 |
| `IssueWriterPort` | `createBdCliIssueWriter` | チケットの状態変更・コメント等の書き込み |
| `DependencyWriterPort` | `createBdCliDependencyWriter` | 依存関係(blocks等)の追加 |
| `LeaseReader` / `LeaseReclaimer` | `createBdCliLeaseReader` / `createBdCliLeaseReclaimer` | claim(lease)の読み取り/期限切れ回収 |
| `MergeSlotReader` | `createBdCliMergeSlotReader` | マージ直列化用スロットの読み取り |
| `CommentReader` | `createBdCliCommentReader` | チケットコメント取得 |
| `HumanDecisionsPort` | `createBdCliHumanDecisions` | 人間の意思決定待ちキューの読み書き |
| `SessionLinkWriterPort` | `createBdCliSessionLinkWriter` | チケット⇔セッションの手動紐付け |
| `PrStatusReader` | `createGhCliPrStatusReader` | `gh` CLI でPRステータス取得 |
| `WorktreeScanner` | `createGitWorktreeScanner` | worktree一覧のスキャン |
| `ProjectDiscovery` | `createFsProjectDiscovery` | スキャンルート配下の `.beads/` プロジェクト検出 |
| `ProjectFingerprinter` | `createBeadsFingerprinter` | 変化検知用フィンガープリント計算 |
| `ProjectWatcher` | `createChokidarProjectWatcher` | プロジェクトのファイル変更監視 |
| `BoardCache` | `createSqliteBoardCache` | 横断ボードの永続キャッシュ(プロジェクト/チケット/セッションリンク/オフセット)。全プロジェクトの読み出し口は `listProjects`(同期・チケット込み)/ `listProjectRefs`(同期・project だけを返す射影でコストは `listProjects` と同じ・省略可)/ `listProjectsChunked`(非同期でイベントループに制御を返す・省略可)の3つで、どれも「id, fingerprint の一括取得 → パース済みキャッシュ → 外れた分だけ行を読む」ので温まっていれば全チケット JSON を読み直さない(cold なら外れた分をパースする)。呼び出し側は三項演算子や `.map(entry => entry.project)` を自前で書かず `application/board/read-cached-projects.ts` の `readProjectEntries` / `readProjectRefs` を使う(bdboard-5lnh) |
| `SessionRegistry` | `createClaudeSessionRegistry` | `~/.claude/sessions/*.json` + PID生存確認からセッション列挙 |
| `TranscriptScanner` | `createJsonlTranscriptScanner` | セッショントランスクリプトの増分tail走査(チケットID抽出) |
| `SessionTailReader` | `createSessionTailReader` | セッションログ末尾の取得 |
| `InteractionReader` | `createJsonlInteractionReader` | agy等のheadless実行ログ(soft-deny等)読み取り |
| `ProcessScanner` | `createPsProcessScanner` | `ps` によるエージェントプロセス列挙 |
| `ProcessProbe` | `NodeProcessProbe` | PID生存確認(`process.kill(pid, 0)`) |
| `CommandRunner` / `StreamingCommandRunner` | `NodeCommandRunner` / `NodeStreamingCommandRunner` | 子プロセス実行の共通口(`infrastructure/process` 配下限定) |
| `ChatAgentPort` | `createClaudeChatAgent` 等(`infrastructure/chat`) | チャット機能のエージェントアダプタ(claude常設、codex/cursor/agyはopt-in) |
| `ChatSessionRepository` / `ChatMessageRepository` | `createSqliteChatSessionRepository` / `createSqliteChatMessageRepository` | チャットセッション・メッセージの永続化 |
| `TunnelProcess` | `createCloudflaredTunnel` | cloudflared quick tunnel の起動/停止 |
| `AiQuotaSource` | `createNodeAiQuotaSource` | `ai-quota` CLI 経由の残量取得 |
| `WorktreeProvisioner` | `createGitWorktreeProvisioner` | エージェント実行用 worktree の作成と、マージ済み生成物の安全な回収 |
| `AgentRunConfigPort` | `createFileAgentRunConfigStore` | エージェント実行設定(リモート許可トグル等)の永続化 |
| `AgentRunner` | `createClaudeSpawnRunner` / `createClaudeResumeRunner` / `createDisabledRunner` 等 | エージェント起動(`POST /api/runs` の1経路のみ。`agent-run-guard` 必須) |
| `PackRegistryPort` / `HarnessInjectorPort` | `createFsPackRegistry` / `createFsHarnessInjector` | ハーネスパックの一覧と、注入先 `.claude/` への書き込み |
| `HarnessContractReaderPort` | `createFsHarnessContractReader` | 注入先の検証コントラクトと `package.json` の scripts 読み取り |
| `FileSystemPort` | `NodeFileSystem` | ファイルシステムの非同期読み取り(ディレクトリ列挙・stat・範囲読み取り。読めなければ `undefined`) |
| `ScanRootsConfigPort` | `createFileScanRootsConfigStore` | スキャン対象ルートと除外パスの設定の永続化 |
| `BoardThresholdsConfigPort` | `createFileBoardThresholdsConfigStore` | 滞留・liveness 判定しきい値と In Progress の WIP 上限設定の永続化 |
| `AiQuotaAlertConfigPort` | `createFileAiQuotaAlertConfigStore` | AI残量アラート設定の永続化 |
| `HygieneThresholdsConfigPort` | `createFileHygieneThresholdsConfigStore` | 健全性(Hygiene)パネルの検出しきい値設定の永続化 |
| `ApplicationVersionProvider` | `createPackageJsonVersionProvider` | アプリケーションのバージョン取得 |
| `ChatSessionDiscoveryPort` | `createFsChatSessionDiscovery` | CLI で起動した既存 Claude セッションのトランスクリプトからの検出・所有権(cwd)検証・adopt 時の履歴シード読み取り |
| `TunnelInterruptionStore` | `createFileTunnelInterruptionStore` | トンネル中断状態の記録と読み取り |
| `ReleaseSource` | `createGithubReleaseSource` | リリース情報の取得 |
| `AttachmentStoragePort` | `createFsAttachmentStorage` | チケット添付画像の保存/一覧/読み取り(bdboard-qw26) |

表に載せないモジュール:

- `board-cache-fakes.ts` — `BoardCache` のメソッド群(キャッシュ統計・セッションリンク・interactions)ごとの部分 fake(`Pick<>`)を返すテスト用ファクトリ。
- `tunnel-interruption-store-fakes.ts` — `TunnelInterruptionStore` のテスト用 in-memory fake ファクトリ。

各ポートのフルインターフェースは `src/application/ports/*.ts` を参照。

### ハーネスの検証コントラクト

注入先プロジェクトは `.claude/bdboard-harness.json` に「フル検証コマンド(`verify`)・
git 運用(`prFlow`)・メインブランチ(`mainBranch`)」を宣言する。省略可能な `models` 節は
工程(stage)×複雑度(low/med/high、まとめるなら `*`)のモデル候補列で、**構文の正本はここ**、
**モデルの実在の正本は実行する CLI 自身**という分担にしてある(端末固有の設定ファイルを
bdboard から読みに行くと層の逆依存になるため / bdboard-p5l.13)。候補文字列を
`member:model` の狭い文字集合へ閉じることが唯一かつ十分な注入防御で、後段にサニタイズを
重ねない。UI へ運ぶのは工程名と段数の要約だけで、候補列は DTO にも run プロンプトにも載せない。
省略可能な `alwaysOnServer` 節 (`port` / `restartScript`) は、常時稼働サーバーの所在の宣言で、
パーサーは読まず、パックの `hooks/worktree-freshness.sh` が `restartScript` を追従案内に使い、
`scripts/always-on-server.sh` の運用文書が参照する (bdboard-hpu8。hook 規則 7 は bdboard-cm2q.10 で廃止)。
bdboard 自身は `8787` / `scripts/always-on-server.sh` を宣言している。
同じく省略可能な `merge` 節 (`mode` = `S0` / `S1` / `S2`、`leaseMinutes`、`slotWaitMinutes`、
`statusContext`、S2 の `hotFiles`) はマージ手順の段階の宣言で、パーサーは読まず `scripts/merge-pr` だけが
`origin/main` 上の版を読む (bdboard-ulxa.1 / S2 は bdboard-ulxa.2)。

`.claude/` 配下に置くのは、注入 API のパストラバーサルガード `resolveUnderClaudeDir` の内側に
収めるため。パースと
判定は `src/domain/harness-contract.ts`(純粋関数。`parseHarnessContract` /
`evaluateContractState`)、fs アクセスは `HarnessContractReaderPort` の実装に閉じてあり、
`ProjectHarnessStatus.contract` としてパックの導入状況と同じ経路で UI まで運ばれる。
**判定対象はパックを注入済みのプロジェクトだけ**で、未注入は `not-applicable` になり
一切表示しない — bd 運用プロジェクトの多くは未注入なので、そこへ一斉に警告を出すと
ボード健全性が無視される警告で埋まる(bdboard-pkr6.3)。

## データフロー: bd CLI → キャッシュ → SSE → UI

`src/main.ts` が起動時に組み立てる定期リフレッシュ + イベント通知のパイプライン:

1. **収集**: `ProjectDiscovery`(`createFsProjectDiscovery`)がスキャンルート配下の `.beads/` を検出し、
   `IssueRepository`(`createBdCliIssueRepository`)が各プロジェクトに対して
   `bd --readonly -C <dir> list --json --all --limit 0 --no-pager` を実行してチケット一覧を取得する。
2. **変更検知**: 全プロジェクトへ毎回 `bd` を叩くコストを避けるため、`ProjectFingerprinter`
   (`createBeadsFingerprinter`)が `.beads/last-touched` 等からフィンガープリントを計算し、
   `application/board/refresh-projects.ts` の `refreshProjects()` が前回と変化のあった
   プロジェクトだけを再取得する(`chokidar` によるファイル監視 `createChokidarProjectWatcher` が
   変化トリガーそのものも供給し、加えて `BDBOARD_REFRESH_INTERVAL_MS` 間隔の全体リフレッシュを
   取りこぼし保険として併走させる)。
3. **キャッシュ**: 取得結果は `BoardCache`(`createSqliteBoardCache`、`~/.bdboard/cache.db`)に永続化される。
   チケット/プロジェクト/セッションリンク/トランスクリプト走査オフセット等を
   保持し、再起動時もここから復元する(トランスクリプトリンクは起動時に
   `hydrateTranscriptLinksFromCache()` でインメモリ `Map` へ再構築)。
4. **セッション/トランスクリプト観測**: 並行して `SessionRegistry`(`createClaudeSessionRegistry`)が
   `~/.claude/sessions/*.json` とPID生存確認から稼働中セッションを列挙し
   (`BDBOARD_SESSION_INTERVAL_MS` 間隔)、`TranscriptScanner`(`createJsonlTranscriptScanner`)が
   セッションのトランスクリプトを増分走査してチケットID⇔セッションIDのリンクを推定する
   (`BDBOARD_TRANSCRIPT_INTERVAL_MS` 間隔)。
5. **配信**: 何か実際に変化した場合(空更新は抑制)、`interface/sse/event-hub.ts` の `EventHub` へ
   `board.changed` / `session.changed` / `notification` 等のイベントを `publish()` する。
6. **SSE配信**: `interface/http/routes.ts` の `GET /api/events` が `EventHub.subscribe()` して
   Server-Sent Events としてクライアントへ中継する(接続ごとに ping タイマーを持ち、
   `AbortSignal` とレスポンスの両方の切断経路を監視してリークを防ぐ)。`notification` だけは
   `EventHub` が `<epoch>-<seq>` の id を振って直近50件をメモリに保持し、接続時に
   `Last-Event-ID` ヘッダー(無ければ `lastEventId` クエリ)より新しい分を `replayed: true` 付きで
   再送する。未接続中に出た通知の取りこぼし対策で、クライアントは payload 由来の id で重複を落とし、
   再送分ではデスクトップ通知を鳴らさない。バックグラウンドのモバイルPWAでは onerror 無しに
   接続が凍るため、前面復帰時に45秒以上何も届いていなければ `web/src/lib/sseConnection.ts` が
   EventSource を張り直して再送を受け取る(bdboard-3tw.161)。
7. **UI側**: `web/src/useBoardStream.ts` が `EventSource` を張り(`web/src/lib/sseConnection.ts` で
   タブ間共有)、イベント受信をトリガーに TanStack Query のキャッシュを invalidate して
   `GET /api/board` 等のREST APIを再フェッチする。**SSEイベント自体はペイロードを運ばない
   invalidation信号であり、実データは常にREST経由で取得し直す**設計。

つまり実データの経路は「bd CLI(readonly) → BoardCache(SQLite) → REST API」、変更通知の経路は
「EventHub → SSE → クライアント側リフェッチのトリガー」という2系統に分離されている。

## 安全保証

- **bdへの読み取りは `--readonly` 固定**: `createBdCliIssueRepository` の一覧取得や、書き込み系アダプタが
  内部で行う存在確認的な `show` 呼び出しも含め、読み取り目的のbd呼び出しは一貫して `--readonly`
  フラグを付与する(`src/infrastructure/bd/*.ts`)。
  **唯一の例外 (bdboard-o1e5)**: `--readonly` の読み取りが `dolt server unreachable`
  (Dolt sql-server 停止。PC 再起動後など) で失敗したときに限り、
  `createDoltAutostartCommandRunner` (`src/infrastructure/bd/dolt-autostart-command-runner.ts`、
  `wire-core-infra.ts` で CommandRunner を包む) がそのプロジェクトで `bd -C <root> dolt start`
  を実行し、元の読み取りを1回だけ再試行する。許可するのは `dolt start` のみで、これは
  サーバープロセスを起動するだけでデータを変更しない。プロジェクトごとに単一飛行 + 60 秒
  クールダウンで、再試行も失敗した場合は従来どおりステータスエラーに出す。
  `dolt start` と `/api/status` のエラー表示は**画面に表示中のプロジェクトだけ**が対象:
  クライアントが `PUT /api/ui/visible-projects` (`{clientId, projectIds}`、選択が空 = 全表示の
  ときはワイルドカード `{clientId, all: true}`) で表示中のプロジェクトを申告し (読み込み時・
  選択変更時・SSE 接続/再接続時・2 分ごとのハートビート。失敗は数秒後に再送)、サーバーは
  申告を 5 分 TTL・最大 32 クライアントのインメモリレジストリ
  (`application/board/visible-projects-registry.ts`) に持って全クライアントの和集合を使う
  (ワイルドカードが有効なら全プロジェクトが表示中)。`/api/status` が隠すのはキャッシュに
  あるプロジェクトのエラーだけで、キャッシュに無い projectId のエラーは常に出す。
  一部のプロジェクトだけのリフレッシュは、対象外プロジェクトの既存エラーを消さない
  (`merge-status-errors.ts`)。bd が自動起動を無効・外部管理と答えたプロジェクトには
  `dolt start` しない。この PUT はデータを変えない UI 状態の申告だが、他の書き込みと同じ
  write-guard の内側 (ローカル直アクセスのみ。トンネル書き込み未開放なら 403) に置く。
  有効な申告が無いときは `/api/status` は絞り込まず、`dolt start` は行わない。
  全プロジェクトの読み取りリフレッシュ自体はこの絞り込みの影響を受けない。
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
  **ただし `--allowedTools` は実効天井の完全な記述ではない**(bdboard-ky0j)。CLI には
  無害な読み取り専用コマンドの組み込み自動承認があり、実効天井は
  「`DEFAULT_ALLOWED_TOOLS` ∪ CLI 組み込み集合」になる。後者は非公開でバージョン依存
  なので、我々の側から列挙も固定もできない。実測(2026-09-04・claude CLI 2.1.233)では
  組み込み集合に書き込み系・ネットワーク系は含まれなかった(`touch`/`mkdir`/リダイレクト/
  `ping`/`nc`/`git ls-remote` がいずれも拒否)が、これは観測であって契約ではない。
  **CLI を上げたら測り直す**。手順と測定上の落とし穴(macOS の `/tmp` が
  `/private/tmp` へのシンボリックリンクである件を含む)は
  `src/infrastructure/runners/claude-runner.ts` の `DENIED_TOOLS` 上のコメントにある。
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
- **チケットが指すプロジェクト内ファイルの閲覧はローカル直、または認可済みトンネルセッションのみ・根に閉じ込める** (bdboard-vgdr / bdboard-teir): `interface/http/local-file-routes.ts`(+ `local-file-raw.ts`)の `GET /api/tickets/:id/local-files`
  は description / design / acceptance_criteria / notes / コメント本文から抽出し実在分だけ最大100件返す。`.../local-files/list?path=` はフォルダ直下で `.` 始まりと許可外拡張子を出さず自然順・500件まで、`.../local-files/raw?path=` は中身を返す。
  `createPrivilegedApiGuardMiddleware(deps.writeAccess ?? {})` を `/api/tickets/:id/local-files` と `/api/tickets/:id/local-files/*` の両方に掛ける。`writeAccess` は main.ts が `wireLocalFiles` 経由で渡す `auth.writeAccess`(チャット・添付と同じ)。
  通るのはローカル直アクセス、または強いパスワードで起動したトンネル+有効なセッションCookieのときだけ。弱いパスワード・セッション無し・`writeAccess` 未配線は403(fail-closed)。根への閉じ込めはトンネルでも同じ。
  動画は `<video src>` が同一オリジン(`Sec-Fetch-Site: same-origin`)でセッションCookie付きの Range リクエストを送り、206で再生・シークできる。GETでもCSRF/Fetch Metadata判定を通すので、`Sec-Fetch-Site` が same-origin 以外(アドレスバー直打ちの `none` も)は403である。
  中身は同一オリジンのビューア画面から `<img>` / `<video>` / fetch で読む。router は inner の `GET /api/tickets/:id{.+}` キャッチオールより前に mount する(`bootstrap/mount-routes.ts`、順序はテストで固定)。
  raw / list / 参照解決は `application/local-files/resolve-contained-local-path.ts` の1関数を通る。(1) 字面で NUL・制御文字・バックスラッシュ・`/` `~` 始まり・`..`・空セグメント・`.` 始まりを拒否する(末尾の `/` 1つは落とす)。
  (2) `realpath(根)` と `realpath(根/相対)` を取り後者が前者の下にある。(3) realpath 後の相対にも `.` 始まりセグメントが無い(シンボリックリンクで `.git` 等へ逃げない)。(4) 拡張子は要求パスと realpath の両方で許可表を通す。
  比較は realpath 済みの値どうしである(根が日本語を含んでも、macOS の `/var` → `/private/var` でもずれない)。拒否は400/404/415。新しいポートは作らず既存の `FileSystemPort`(`realPath` / `stat` / `isDirectory` / `readDir` / `readRangeBytes`)を使う。
  許可拡張子(`domain/local-file-kinds.ts`)は画像 png jpg jpeg webp gif / 動画 mp4 webm m4v mov / 音声 mp3 m4a wav / md / json / txt csv srt vtt。svg と html は入れない(能動的なコンテンツになりうる)。
  Content-Type は拡張子から決め sniff しない。応答に `X-Content-Type-Options: nosniff`・`Content-Security-Policy: default-src 'none'; sandbox`・`Cache-Control: no-store` を付ける。
  `securityHeadersMiddleware`(`interface/http/app-security.ts`)はルートが付けた CSP を残し、`frame-ancestors 'none'` だけを揃える(以前は無条件に上書きしていた)。大きいファイルは全体を読まない。
  Range は単一範囲だけで1回 4 MiB までであり、終端省略も明示終端も切る。満たせない範囲は416。Range 無しはテキスト系 2 MiB・画像 30 MiB・動画/音声 4 MiB を超えると413になる。
  本文からの抽出は ASCII のパス文字(`[A-Za-z0-9._-/]`)の連続だけである。日本語を含むパスは、全角の「：」「（」「、」などの区切りと区別できないため抽出の対象外である(フォルダ一覧に出る日本語名のファイルは見られる)。
  URL・`/` `~` 始まり・`..`・隠しセグメントは候補にしない。根から見つからない候補は、同じ行で直前に解決したパスの祖先フォルダを近い順に試す(スラッシュ無しのファイル名はそのフォルダだけ)。

## v1計画との差分(注記)

[docs/PLAN.md](./PLAN.md) の「v1 の安全保証」節には「`IssueWriter` ポート(現 `IssueWriterPort`)の infrastructure 実装を
v1の合成ルートに登録しない」という当初方針が書かれているが、現在の `src/main.ts` は
`createBdCliIssueWriter` / `createBdCliDependencyWriter` / `createBdCliSessionLinkWriter` 等を
実際に生成し `createApiRoutes` へ配線している。書き込み機能はその後のスライスで計画通り実装され、
上記の `write-guard` による認可ゲートに置き換わっている。**Runner(エージェント自動起動)も
`POST /api/runs` として配線済み**だが、`agent-run-guard` + リモート許可トグル(既定 off)により
到達を制限している。ローカル直アクセスからの実行は read-only 保証を意図的に緩めた点であり、
リモートは既定 off でトグルもローカル直アクセスからのみ変更できる(fail-closed)。
読む際は本ドキュメントの現状記述を優先し、`PLAN.md` は初期設計の経緯・技術選定理由を追う資料として参照すること。

## Git 履歴分析の注意(churn analysis)

このリポジトリの git 履歴は 2026-08-17 の `chore: fresh public history` (b91193e) で
切り直されており、それ以前のコミットは残っていない。そのため「コミットN件中M件が直近X日に
集中しているから変更が加速している」という**絶対件数**ベースのホットスポット論証は、切り直し
直後は必ず誤った結論に至る(全ファイルが機械的に「最近に集中している」ように見えるため。実例:
bdboard-78ve)。

正しい見方は絶対件数ではなく、**全体コミット数に対するシェアを日別に**比較すること:

```bash
git log --pretty='%ad' --date=short | sort | uniq -c            # 全体の日別コミット数
git log --pretty='%ad' --date=short -- <path> | sort | uniq -c  # 対象パスの日別コミット数
```

実測例(`web/src/components/ChatPanel.tsx`、2026-08-30 時点): 全体に対するシェアは
26%→16%→23%→9%→3% と推移しており、絶対件数だけを見ると「増えている」ように見えても実際は
むしろ低下していた(このシェアは日々の新規コミットで動くため、再実行すると数値は変わる — 手法の
例として読むこと)。

この教訓と対で覚えておくべきもう一つの陳腐化: チケットの起票根拠(epic の状態・関連 open
チケットの有無)も1日で古びうる。churn の実測値と同じく、投資判断系のチケットを議論する前に
`bd show` で前提を再確認すること。

## 関連ドキュメント

- [docs/PLAN.md](./PLAN.md) — v1スコープの全設計(層構成の設計意図、テスト戦略、実装スライス等)
- [docs/DECISIONS-LOG.md](./DECISIONS-LOG.md) — 個別の設計判断ログ
- [docs/MCP-CLIENTS.md](./MCP-CLIENTS.md) — MCPクライアント関連
- ルートの `CLAUDE.md` / `AGENTS.md` — ビルド/テストコマンド、Git運用(worktree+PR)、bd運用ルール
