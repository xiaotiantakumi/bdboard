# bdboard — Beads チケットの横断Kanbanダッシュボード

## Context

現在、`bd`(Beads) を使って複数プロジェクトの作業台帳を管理している。実際に
ホームディレクトリ配下の複数のプロジェクトディレクトリに `.beads/` があり、
多いプロジェクトでは100件を超える規模のチケットが溜まっている。

しかし現状は `bd list` を各ディレクトリで叩くしかなく、**「今どのプロジェクトの、どのチケットを、
どのAIセッションが作業中なのか」が一目で分からない**。依存関係(blocks)も CLI 出力からは
把握しづらい。

そこで、ローカルで起動する横断ダッシュボード `bdboard` を作る。目的は3つ:

1. 複数プロジェクトのチケットを**看板形式で一覧**する(ディレクトリ単位の分割表示 / 全部混ぜた統合表示を切替)
2. 各チケットに **Claude Code セッションを紐付け**、稼働中かどうかを可視化する
3. 将来、**チケットに書いた指示で AI を起動**する(spawn / resume)。他AI CLI にも同じ口から流す

将来の機能追加が前提なので、オニオンアーキテクチャ + TDD で変更容易性を確保する。

---

## 事前調査で確定した事実(実測済み)

設計はこれらの実測に依存している。実装時に前提が崩れていないか最初に再確認すること。

### bd CLI (v1.1.0, `/opt/homebrew/bin/bd`)

- **バックエンドは Dolt。SQLite バックエンドは削除済み。** → Dolt を直接触らず、必ず `bd` CLI 経由。
- `-C <dir>` でディレクトリ指定(git -C 相当)、`--json` で機械可読出力。
- `bd list --json` の実データ形状(実測):
  ```
  { id: "ExampleApp-w5a", title, description, notes?, status, priority: int,
    issue_type, assignee?, owner?, created_at, created_by, updated_at,
    started_at?, closed_at?,
    dependencies?: [{ issue_id, depends_on_id, type, created_at, created_by, metadata }],
    dependency_count, dependent_count, comment_count }
  ```
- **ID は `<接頭辞>-<短ID>` 形式**(`ExampleApp-w5a`)。これが後述の自動リンク推定の結合キー。
  ただし **接頭辞はプロジェクト名とは限らず、ダッシュも含む**。実測: `sample-project-86o`、
  そしてある1プロジェクトでは**接頭辞が `epic-haslett-00ae14`**になっていた例もある(worktree の
  ディレクトリ名。`bd init` が worktree の中で実行された痕跡)。さらに `ExampleApp-ase.2` のような
  **階層サフィックス**も付く。
  → **ID を正規表現で推測してはいけない。** 接頭辞は実データから収集し、抽出したIDは
  既知IDの集合と照合して検証する。
- **罠1: 依存でブロックされているチケットも `status` は `"open"` のまま。** 真のブロック状態は
  `dependencies` から導出する必要がある。→ ドメイン層の責務にする。
- **罠2: `dependencies[].type` には `blocks` 以外に `parent-child` が混ざる**(実測: あるプロジェクトで
  parent-child 44本 / blocks 8本)。`dependency_count > 0` を「ブロック中」と読むと**約5倍に誤判定する**。
  → `kind === 'blocks'` で必ず絞る。`kind` は省略可能フィールドにしない。
- **罠3: `bd blocked --json` / `bd ready --json` は `dependencies` を空配列で返す**(list とは別シリアライザ)。
  → 依存データをこれらから読んではいけない。**テストの正解データ(オラクル)としてのみ使う**。
- 罠4: `bd list --json` にも `bd show --json --long` にも **`labels` が含まれない**。
  → ラベル絞り込みは v1 スコープ外(既知の制限として明記)。
- **罠5(当初計画の訂正): `bd update --session` はリンク用途に使えない。** ヘルプ実文は
  *"Claude Code session ID **for status=closed**"* で、クローズイベント専用フィールド。
  → セッション紐付けは **`--set-metadata bdboard.session=<uuid>`** で行う。
  `bd list --metadata-field bdboard.session=<uuid>` / `--has-metadata-key` で往復できる。
- **読み取りは1プロジェクト1コマンドで足りる**: `bd --readonly -C <root> list --json --all --limit 0 --no-pager`
  の出力だけから blocked / ready / deferred をすべて導出できることを、実測8プロジェクトで
  `bd blocked` / `bd ready` と突き合わせて **8/8 一致**で確認済み(defer_until 考慮を含む)。
- **`--readonly` グローバルフラグが存在する**("block write operations (for worker sandboxes)")。
  → v1 の全 bd 呼び出しに付けて、実データを壊さない保証を無料で得る。
- `--no-pager` は **`list` にしか無い**(`bd blocked --no-pager` は unknown flag エラー)。
  → コマンド組み立ては**サブコマンド単位**に分ける。
- `bd version --json` → `{"version":"1.1.0","schema_version":1,...}`。起動時のスキーマ乖離ゲートに使う。
- 性能実測: 182件のプロジェクトで **0.36秒**、8プロジェクト全体で 直列3.18秒 / 並列1.37秒。
  → **ポーリングは十分安い。** 変更検知は最適化であって正しさの前提ではない、と設計できる。
- `bd update --set-metadata key=value`(繰り返し可)、`--claim`(assignee+in_progress の冪等な原子的取得)。
- `bd list` は stdout に JSON を出しつつ **stderr に `warning: beads.role not configured` を出す**。
  → stdout/stderr を必ず分離してパースする。
- `.beads/` 構成: `config.yaml`, `metadata.json`, `interactions.jsonl`(追記型), `last-touched`,
  `embeddeddolt/`, `backup/`, `hooks/`。
- `config.yaml` に `export.auto`(→`issues.jsonl`, 60s間隔, "**for viewers**" と明記)がある。
  ただし**有効化はユーザープロジェクトを書き換える行為**なので、bdboard の動作要件にはしない。

### Claude Code セッションの観測(仕込み不要)

- **稼働レジストリ: `~/.claude/sessions/<pid>.json`** — 実測内容:
  ```
  { pid, sessionId, cwd, startedAt, procStart, version, peerProtocol,
    kind: "interactive", entrypoint: "claude-desktop",
    messagingSocketPath: "/tmp/cc-socks/<pid>.sock", name, nameSource }
  ```
  実測3件すべて **pid 生存中**、対応ソケットも実在。→ mtime推測ではなく**プロセスレベルで
  「今動いているか」が確定できる**。(ただしクラッシュ時の残骸の可能性は排除できないので
  `process.kill(pid, 0)` で生存確認は必ず行う)
- **トランスクリプト実体: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`**
  - MCP側の `sessionId` は `local_<uuid>`、ファイル名は `<uuid>`。→ **`local_` を剥がすだけで対応**(実測確認済み)
  - encoded-cwd は **`/` `.` `_` をすべて `-` に置換**(`/.claude` → `--claude`)。**非可逆**。
  - **ただしデコードは不要**: JSONL の各行(`user`/`assistant`/`attachment`)に
    **`cwd` / `sessionId` / `gitBranch` / `version` が正データとして入っている**。
    → ディレクトリ名のエンコードは「監視対象を155→約30ディレクトリに絞る最適化」にのみ使い、
    正しさは常にファイル内の `cwd` から取る。
  - **サイズが想定より桁違いに大きい**。実測: 155ファイル / **合計1.77GB / 最大433MB**。
    → 全読みは論外。バイトオフセット永続化 + **初回は末尾2MBだけ読む**上限 +
    1tickあたりの合計バイト予算(8MB)でラウンドロビン。全履歴が要るときだけ明示コマンドで backfill。
  - なお **稼働判定は `stat` だけで成立する**(パース不要)ので、解析予算が尽きても稼働表示は正しいまま。
  - `<session>/subagents/agent-*.jsonl` にサブエージェントのログもある。**列挙済み**
    (bdboard-3tw.54): `jsonl-transcript-scanner.ts` が session-uuid ディレクトリ配下の
    `subagents/*.jsonl` を親セッションの `sessionId` 帰属で同じバイト予算ラウンドロビンに乗せて
    走査する。`.meta.json` / `tool-results/` は対象外。
- **worktree 問題(必須対応)**: セッションは軒並み `<repo>/.claude/worktrees/<name>` で動くが、
  `.beads/` は**本体チェックアウト側**にある。実測での解決法:
  - `git rev-parse --path-format=absolute --git-common-dir` → `/…/some-project/.git` (本体)
  - `git rev-parse --show-toplevel` → worktree 側を返すので**使えない**
  - → `dirname(git-common-dir)` が `.beads/` の所在。

### 利用可能な AI CLI

`claude`, `cursor-agent`, `codex`, `gemini`, `agy`, `aimix` がすべて PATH 上にある。

- **`claude` はシェルの alias になっている場合がある**(例: シークレット注入ラッパ経由でCLIを起動する
  構成)。alias解決した実体スクリプトのパスを直接 spawn すればよい(alias問題は消滅。`shell: true` は
  不要かつ危険なので使わない)。
- **`--dangerously-skip-permissions` は使わない。** 設計案には設定でオプトインする分岐が含まれていたが、
  権限チェックを全て迂回するフラグであり、チケット由来の文字列で起動するワーカーに与えるのは危険。
  **v1では設定項目自体を作らない。** 必要になった時点で改めて判断する。
- 確認済みヘッドレスフラグ: `-p/--print`, `--output-format stream-json`, `--input-format stream-json`,
  `--resume <session_id>`, `--fork-session`, `--model`, `--effort`, `--append-system-prompt`。

### スコープ外(明示)

`mcp__ccd_session_mgmt__send_message` は **Claude Code アプリ内部の MCP ツール**で、外部 Node
プロセスからは呼べない。また "unattended"(スケジュール実行・リモート起動)セッションには
そもそも送れない。→ **公式経路での「生きた対話セッションへの割り込み」は不可能**。
`/tmp/cc-socks/<pid>.sock` 経由なら技術的には届き得るが `peerProtocol: 1` の非公開IPCのため、
**隔離した実験アダプタとしてのみ**扱う(下記)。

---

## 確定した設計方針

| 論点 | 決定 |
|---|---|
| 設置場所 | **独立リポジトリ `bdboard`** → 既存のプロジェクト群と同じ階層に置く(Unity専用ワークスペース等、性質の異なるディレクトリとは同居させない)。**既定スキャンルート配下になるので、bdboard 自身の `.beads` が自動的にダッシュボードに載る** |
| 言語 | TypeScript / Node.js (v22系) |
| アーキテクチャ | オニオン(domain / application / infrastructure / interface)、境界を機械的に検証 |
| 開発手法 | TDD。domain・application は I/O なしで完全にユニットテスト可能にする |
| データ正本 | **bd(Dolt) が単一の正本。** 書き込みは必ず `bd` CLI 経由 |
| ローカル SQLite | **キャッシュ + 副次データのみ**(横断検索用キャッシュ / 監視ルート登録 / 実行ログ / tail オフセット)。**削除しても全再構築できること** |
| プロジェクト発見 | スキャンルートを登録 → `.beads/` を自動検出(既定 `~/Documents/src/private_src`)。個別除外可 |
| 起動方式 | Runner ポートが **spawn と resume の両方**を持ち、チケットごとに選択可能 |
| 内部ソケット | Runner の一実装として **experimental 印を付けて隔離**。失敗時は spawn/resume に自動フォールバック |

---

## v1 スコープ

**やる**: 可視化 + セッション紐付け(読み取り中心)

- 横断 Kanban ボード。ディレクトリ単位フィルタ + 全統合ビューの切替・ソート
- 依存関係の可視化(最低限 blocked-by / blocks バッジ。グラフビューは後続スライス)
- チケットごとに「どのセッションが作業中/作業していたか」「今生きているか」を表示
- セッション↔チケットのリンク: (a) 明示リンク(`bd update --session` / metadata)、
  (b) **トランスクリプト内の bead ID 出現による自動推定**(仕込みゼロで既存セッションも拾える)
- ブラウザへのリアルタイム反映(SSE + ファイル監視)

**インターフェースだけ定義して実装は後回し**: UI からのチケット編集、実際の dispatch(spawn/resume)、
Haiku による作業要約のチケット追記、他AI Runner、内部ソケットアダプタ。

---

## 技術選定(各1案)

| 領域 | 採用 | 理由 |
|---|---|---|
| ランタイム | Node 22 (`~/.nvm/versions/node/v22.14.0` が既にある) | 既存環境と一致 |
| HTTP | **Hono** (@hono/node-server) | 軽量・型が強い・SSE ヘルパ内蔵 |
| SQLite | **better-sqlite3** | 同期APIでローカルキャッシュに最適。`node:sqlite` はまだ experimental |
| テスト | **vitest** | TS ネイティブ・高速・モックが素直 |
| 監視 | **chokidar** | macOS の `fs.watch` は recursive/rename に癖がある |
| 検証 | **zod** | bd CLI 出力の外部境界バリデーションに必須 |
| 境界検証 | **dependency-cruiser** | オニオンの依存方向をテストとして機械的に強制 |
| フロント | **React + Vite + TypeScript**, TanStack Query, EventSource(SSE) | Kanban のカード数と将来のDnDに耐える |

---

## 層構成(オニオン)

```
bdboard/
  src/
    domain/          # 純粋。外部依存ゼロ。ここだけで大半のテストが書ける
    application/     # ユースケース + ポート(interface)定義
    infrastructure/  # アダプタ実装(bd CLI / fs / sqlite / process)
    interface/       # Hono ルート・SSEハブ・DTO変換
  web/               # Vite + React (別ビルド、devはproxy)
  test/fixtures/     # 実測した bd --json 出力のゴールデンファイル
```

**依存方向**: `interface → application → domain`、`infrastructure → application(ポート実装)`。
domain は何にも依存しない。dependency-cruiser のルールをテストとして実行し、違反でCIを落とす。

### ドメイン(純粋ロジック — ここを最初にTDDで固める)

- 値: `TicketId`(接頭辞と短IDに分解), `Status`, `Priority`, `ProjectPrefix`, `Liveness`
- 実体: `Project`, `Ticket`, `DependencyEdge`, `AgentSession`, `SessionLink`, `Run`
- **導出ロジック(このプロジェクトの本質的な価値)**:
  - `ReadinessPolicy` — bd が依存ブロックを `open` のままにする罠(罠1)を吸収する。
    ```
    isBlocked  = status∈{open,in_progress} かつ blocks依存に未クローズが在る   ← kind==='blocks' で必ず絞る
    isDeferred = defer_until が現在時刻より未来
    isReady    = status==='open' かつ !isBlocked かつ !isDeferred
    ```
    `isBlocked` を `status==='open'` に限定すると `bd blocked` と完全一致する。UI用には
    `in_progress` も含む広い判定を別に持つ(進行中かつブロックは警告表示したいため)。
    `defer_until` を見る必要があるので、**ドメインが `Clock` ポートを持つ正当な理由がある**。
  - **列は生の bd status ではなく導出レーン**にする(これが罠1への最大の対策):
    `In Progress` / `Blocked`(status=blocked または open∧blocked) / `Ready` / `Deferred` / `Done`。
    忠実表示したい人向けに「生statusで並べる」トグルも用意する。
  - `computeLiveness(now, session)` — `active`(≦2分) / `idle`(≦30分) / `stale`(≦24h) / `dormant`。
    しきい値は設定値として注入し、純粋関数に保つ。
  - `mergeBoards()` — 複数プロジェクト統合時の安定ソート。
    `優先度 → 稼働セッションの有無 → このチケットが解放する後続数 → 更新日時` の順。
    「稼働中セッションが付いたカードが上に来る」ことがセッション紐付け機能の実利。

### ポート(application が定義、infrastructure が実装)

`IssueRepository` / `ProjectDiscovery` / `SessionRegistry` / `TranscriptScanner` /
`BoardCache` / `AgentRunner` / `Clock` / `Logger`

### 主要アダプタ(infrastructure)

- `BdCliIssueRepository` — `bd -C <dir> list --json --all -n 0` 等。stdout/stderr 分離、
  zod 検証、エラー分類(bd不在 / beadsプロジェクトでない / スキーマ乖離 / ロック競合)。
  8プロジェクト横断時は**並列度を2〜3に制限**(Dolt のロック競合回避)。
- `FsProjectDiscovery` — スキャンルート走査 + worktree 正規化(`--git-common-dir`)。
- `ClaudeSessionRegistry` — `~/.claude/sessions/*.json` 読み取り + `process.kill(pid, 0)` 生存確認。
- `JsonlTranscriptScanner` — バイトオフセットを SQLite に保存して**増分tail のみ**。
  各プロジェクト接頭辞の正規表現で bead ID を抽出しリンク推定。
- `SqliteBoardCache` — 横断検索用キャッシュ + オフセット + 実行ログ。全再構築可能。
- Runner 群 — `ClaudeSpawnRunner` / `ClaudeResumeRunner` / `AimixRunner` /
  `ExperimentalSocketRunner`(隔離・要フォールバック)。**`claude` は必ずラッパのフルパスで起動**。

### 変更検知(bd を毎秒叩かないための工夫)

`.beads/last-touched` の mtime/内容、`.beads/interactions.jsonl` のサイズ、`embeddeddolt/` の
mtime を chokidar で監視し、**変化のあったプロジェクトだけ** `bd list --json` を再実行する。
取りこぼし保険として数分間隔の全体リフレッシュを別に持つ。

### API

- `GET /api/projects`
- `GET /api/board?projects=…&view=merged|split`
- `GET /api/tickets/:id`
- `GET /api/sessions`
- `GET /api/events` (SSE: `board.changed` / `session.changed` / `project.scanned`)
- (v2 予約) `POST /api/tickets/:id/dispatch`

---

## テスト戦略(TDD)

- **domain / application**: フェイク実装のみでユニットテスト。fs も bd もプロセスも触らない。ここが主戦場。
- **bd アダプタ**: 実測した `bd list --json` 出力を `test/fixtures/` にゴールデンファイルとして固定し、
  パーサとzodスキーマを回帰検証する。
- **統合テスト**: 一時ディレクトリに使い捨ての beads プロジェクトを `bd init` して実行し、必ず破棄する。
  既定の高速テストからはタグで分離する。
- **オラクルテスト(最重要)**: 実測した8プロジェクトの `bd list --json` と、そこから導出した
  blocked/ready が `bd blocked` / `bd ready` と一致することを、**bd を呼ばない固定ファイルとして**
  回帰テスト化する。特に押さえる分岐: parent-child のみの依存はブロックでない(罠2) /
  クローズ済みブロッカーは ready / `defer_until` が未来なら ready でない / 階層ID `…-7sv.23` のパース。
- **絶対禁止**: ユーザーの実プロジェクト8件に対して書き込みテストを走らせないこと。
  必ず一時ディレクトリを `-C` で明示し、`HOME` も一時ディレクトリに差し替えて
  bd がユーザーのグローバル設定に触れないようにし、削除前にパスを2重にアサートする。

### v1 の安全保証

- **v1 の全 bd 呼び出しに `--readonly` を付ける**。
- **`IssueWriter` ポートの infrastructure 実装を v1 の合成ルートに登録しない**
  (ルーティングしていないだけでなく、書き込み経路が物理的に存在しない状態にする)。
- 依存方向ルールで `child_process` を `infrastructure/{process,runners}` 以外から import 禁止にする。

---

## 実装スライス(縦切り。1スライス=独立に検証可能)

| # | 内容 | 依存 |
|---|---|---|
| S0 | リポジトリ雛形・ツールチェーン・dependency-cruiser 境界ルール・最初の失敗するテスト。**あわせて `bdboard` 自身を `/bd-init` して、以降このプロジェクトのタスクを Beads で管理する**(ドッグフーディング: bdboard の開発チケットが bdboard 自身の画面に出るので、最速の実データ検証手段になる) | — |
| S1 | ドメインモデルと純粋ロジック(effectiveStatus / liveness / TicketId) 完全TDD | S0 |
| S2 | ProjectDiscovery(スキャンルート → `.beads` 検出 → worktree 正規化) | S1 |
| S3 | bd CLI アダプタ + zod スキーマ + ゴールデンfixture | S1 |
| S4 | SQLite キャッシュ + 変更検知 | S2, S3 |
| S5 | Hono + SSE + ボード取得ユースケース | S4 |
| S6 | React Kanban UI(分割/統合ビュー、フィルタ、依存バッジ) | S5(APIの契約確定後) |
| S7 | SessionRegistry(`~/.claude/sessions` + pid生存) → カードに稼働表示 | S1 |
| S8 | TranscriptScanner 増分tail + bead ID 自動リンク推定 | S4, S7 |
| S9 | Runner ポート定義 + テスト(実dispatchはまだしない) + 実験ソケットアダプタの隔離枠 | S1 |

**並列化可能**: S2/S3 は S1 完了後に同時進行。S7 は S3 と独立。S9 も独立。
**不確実性が高い**: S8(トランスクリプト形式への依存)、S9の実験アダプタ(非公開IPC)。

---

## 作業の進め方(トークン節約方針)

- **実装はスライス単位で `cursor-implementer`(Cursor Composer 2.5)へ委譲**する。
- **レビューは Codex CLI**(ai-mix 経由)に投げる。納品直前の最終検証は fable / opus。
- 私(議長)は設計・受入判定・統合に専念し、採否の最終裁定を持つ。

---

## 主なリスクと緩和

| リスク | 緩和 |
|---|---|
| bd CLI の出力仕様が変わる | zod で境界検証し、失敗は明示エラー。fixture で回帰検知 |
| 内部ソケット(`peerProtocol: 1`)が更新で壊れる | experimental として隔離し、失敗時は自動で spawn/resume にフォールバック |
| トランスクリプトが 15MB 級で重い | バイトオフセット永続化による増分tail。全読みしない |
| 8プロジェクト同時実行で Dolt ロック競合 | bd 呼び出しの並列度を2〜3に制限。読み取りは `--readonly` |
| worktree と本体を取り違えて `.beads` を見失う | `--git-common-dir` で正規化し、テストで固定 |
| `claude` が alias でヘッドレス起動が無言で失敗 | ラッパのフルパスを設定値化。起動前に存在チェック |

---

## 検証方法(v1完了の定義)

1. `npm test` — domain/application のユニットテストと dependency-cruiser 境界検証がすべて緑
2. `npm run dev` で `localhost` に起動 → 8プロジェクトのチケットが実データで Kanban に並ぶ
3. ディレクトリ単位フィルタと統合ビューの切替が機能する
4. 依存でブロックされたチケットが(bd上は `open` でも)Blocked 列に出ることを実データで確認
5. 別ターミナルで対象プロジェクトの Claude セッションを起動 → **数秒以内**にカードへ稼働表示が出る
6. そのセッションで bead ID に言及 → 自動リンク推定でカードに紐付く
7. 一時ディレクトリでの統合テストが、ユーザーの実プロジェクトに一切触れずに緑
