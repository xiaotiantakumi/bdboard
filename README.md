# bdboard

`bd`(Beads) のチケットを、**複数プロジェクト横断の看板(Kanban)** で見るためのローカルダッシュボード。

既定のスキャンルート(`~/Documents`、環境変数で変更可)配下の各プロジェクトに散らばった `.beads/` を
1画面に集約し、「今どのプロジェクトの、どのチケットを、どの Claude Code セッションが作業中なのか」を
一目で分かるようにする。

`bd`(Beads) は AI コーディングエージェントとの協働を前提に設計されたローカルファーストのイシュー
トラッカーで、bdboard はその `bd` が管理するチケットを見るための UI という位置付け(単体では動かない)。
`bd` 自体の紹介やインストール方法は本体リポジトリ
[gastownhall/beads](https://github.com/gastownhall/beads) を参照。

## できること

- **看板表示**: 全プロジェクト統合(merged)/プロジェクト別カラム(split)を切り替え可能な Kanban ボード。
  導出レーン(Ready / In Progress / Blocked / Deferred / Done)表示、ドラッグ&ドロップでのステータス変更、
  各カードからのクイックアクション(close / claim / defer / priority 変更、取り消し可能な undo スナックバー付き)
- **Next Up**: 次に着手すべきチケットの優先度付きリスト
- **アクティビティフィード / デイリーダイジェスト**: 直近の変更をまとめて把握
- **統計 (スループット / CFD)**: 完了ペースや累積フロー図で進捗を可視化
- **依存グラフ**: `blocks` / `parent-child` 依存関係をグラフ表示
- **Hygiene パネル**: 放置チケットなど台帳の健全性チェック
- **セッション紐付け**: 稼働中の Claude Code セッションをチケットに紐付けて表示し、セッションの
  トランスクリプトを覗ける(SSE でリアルタイム更新)
- **チケット詳細パネル**: Markdown 対応(既知チケットIDの自動リンク付き)の説明/ノート/コメント表示、
  パネルからのコメント投稿
- **チャット**: ローカルの `claude` CLI 経由でチケットについて対話。既定で許可されているのは bd
  MCP ツールのみ(シェル実行・任意ファイルの読み書きは不可)。`BDBOARD_CHAT_AGENTS` で明示
  opt-in すると Codex CLI (`codex exec`)、Cursor Agent CLI (`cursor-agent --print`)、
  Antigravity CLI (`agy --print`) もチャットバックエンドとして選べるが、いずれも claude と違い
  「bd 以外の組み込みツールを全部外す」手段が無いため、既定では無効化されている。cursor / agy
  アダプタはさらに bd MCP ツール自体を接続する手段が無く、bd 操作はシステムプロンプトが案内する
  シェル経由の `bd` コマンドに委ねる(詳細は下記環境変数表と各アダプタの節を参照)
- **AI クォータ表示**: 外部の `ai-quota` コマンドの出力をウィジェット表示
- **トンネル公開 + QR**: `cloudflared` quick tunnel でローカル画面を一時公開し、ワンタイムの
  セッショントークン URL を QR コードで渡す(スマホなど別端末から見るため)。なお設定 API
  (`GET /api/settings/scan-roots`)の `defaultScanRoots` はホームディレクトリのパス
  (= OS ユーザー名)を含むため、トンネル読み取りアクセスにもこの情報が露出する
  (bdboard-9a9 の裁定により意図的に許容)
- **PWA**: `web/public/manifest.webmanifest` によりホーム画面に追加してスタンドアロン起動可能
  (Service Worker によるオフラインキャッシュは無し)

## セットアップ / 起動

```bash
# 1. 依存関係のインストール(ルートと web/ の両方が必要 — node_modules は別管理)
npm install
npm --prefix web install   # または: npm run install:web

# 2. Web UI をビルド(static ファイルとして web/dist に出力)
npm run build:web

# 3. サーバー起動(ビルド済み web/dist を同じポートで配信)
npm run start
```

起動後、既定では `http://127.0.0.1:8787` で待ち受ける。`npm run start` は tsx を watch なしで
実行し、静的な `web/dist` を配信するだけなので、サーバー側・UI 側どちらのコードを変更しても
`npm run build:web` からやり直して再起動しない限り反映されない。

ローカル開発でコード変更を即座に確認したい場合は、`npm run start` の代わりに以下を使う
(挙動の違いは `CLAUDE.md` の「Build & Test」節を参照):

```bash
npm run dev       # サーバーを watch モードで起動(コード変更で自動再起動)
npm run dev:web   # Vite の dev サーバー(HMR)。/api は上記サーバーへプロキシ(web/vite.config.ts)
```

`npm run dev` と `npm run dev:web` は同時に別ポートで動かして併用する想定。`dev:web` の Vite
プロキシは `http://127.0.0.1:8787` 固定なので、`dev` 側のポートも既定値のまま使うこと。
Vite は `127.0.0.1` のみに待ち受ける。`vite --host` などでこのプロキシを LAN に公開すると、
loopback 接続をローカル直アクセスとみなす認証免除の前提が崩れるため使用しないこと。

`.env` ファイル(git 管理外)を置くと `npm run dev` / `npm run start` が自動で読み込む
(`tsx --env-file-if-exists=.env`)。雛形は `.env.example` を参照(認証用の2変数のみ)。

## Quick tour

起動できたら、最初はだいたい次のような流れで触ってみるとひととおりの機能に触れられる。

1. 普段 `bd` で運用しているプロジェクトを、`BDBOARD_SCAN_ROOTS`(既定は `~/Documents`)配下の
   共通の親ディレクトリにまとめておく。bdboard は起動時にこの配下を再帰的にスキャンして
   `.beads/` を持つプロジェクトを自動的に見つける。
2. `npm run start` の後、ブラウザで `http://127.0.0.1:8787` を開く。見つかった全プロジェクトの
   チケットが Kanban ボードに並ぶ。
3. 画面上部で merged(全プロジェクト統合の1枚のボード)と split(プロジェクトごとのカラムに
   分けた表示)を切り替えて、見やすい方を確認する。
4. カードをドラッグ&ドロップして Ready / In Progress / Blocked / Deferred / Done の間でステータスを
   変えてみる(誤操作しても undo スナックバーから戻せる)。
5. カードをクリックしてチケット詳細パネルを開き、説明・ノート・コメントを確認する。
6. チャットパネルから、開いているチケットについて質問してみる(例:「このチケットの経緯を要約して」)。
   既定のバックエンドは bd MCP ツールのみに絞られた `claude` CLI。

ここまで一通り触れば、次は「できること」節の各機能や、下の環境変数表で自分の環境に合わせて
チューニングしていく形になる。

## 主要な環境変数

`src/main.ts` が読む `BDBOARD_*` 環境変数の一覧(既定値は同ファイルの実装から)。

| 変数名 | 意味 | 既定値 |
|---|---|---|
| `BDBOARD_PORT` | 待ち受けポート | `8787` |
| `BDBOARD_HOST` | 待ち受けホスト | `127.0.0.1` |
| `BDBOARD_DB` | ローカルキャッシュ用 SQLite ファイルのパス | `~/.bdboard/cache.db` |
| `BDBOARD_SCAN_ROOTS` | `.beads/` を探索するルートディレクトリ(カンマ区切りで複数指定可) | `~/Documents`(存在しない場合は `~`。Windows は `%USERPROFILE%\Documents`、`%USERPROFILE%` 未設定時は `os.homedir()` 起点)。未設定時はユーザー設定(`~/.config/bdboard/config.json`、Windows は `%APPDATA%\bdboard\config.json`)、その後 OS 検出デフォルトを使用 |
| `BDBOARD_SCAN_DIR_LIMIT` | 1 スキャンで訪問するディレクトリ数の上限(正の整数のみ有効。読み込みは `src/infrastructure/discovery/fs-project-discovery.ts`)。超過すると走査を打ち切って部分結果を返し、`console.warn` に警告を出す。上限は全 scanRoots で共有されソート順に消費されるため、超過時はソート順で後ろの root のプロジェクトがまとめて欠けうる(警告に走査しきれなかった root を列挙する) | `50000` |
| `BDBOARD_REFRESH_INTERVAL_MS` | 全プロジェクトの定期リフレッシュ間隔(ミリ秒) | `300000`(5分) |
| `BDBOARD_SESSION_INTERVAL_MS` | Claude Code セッション一覧の再取得間隔(ミリ秒) | `10000`(10秒) |
| `BDBOARD_TRANSCRIPT_INTERVAL_MS` | セッション⇔チケットのトランスクリプト走査間隔(ミリ秒)。`0` 以下で無効化 | `30000`(30秒) |
| `BDBOARD_CFD_SNAPSHOT_INTERVAL_MS` | 累積フロー図(CFD)スナップショットの記録間隔(ミリ秒)。`0` 以下で無効化 | `3600000`(1時間) |
| `BDBOARD_TUNNEL_LOG_MAX_BYTES` | `cloudflared` トンネルログのローテーション閾値(バイト) | `5242880`(5MB) |
| `BDBOARD_AUTH_USER` | Basic 認証のユーザー名。`BDBOARD_AUTH_PASSWORD` と両方に値がある場合のみ認証が有効化される | (未設定) |
| `BDBOARD_AUTH_PASSWORD` | Basic 認証のパスワード。上記と同様 | (未設定) |
| `BDBOARD_AUTH_DISABLED` | `1` または `true`(完全一致)で Basic 認証を明示的に無効化する。未設定かつ認証情報も未設定だと、リモートリクエストは `503` になる(フェイルクローズ)。ローカル直アクセスは下記条件で免除され、Basic 認証が有効でなければトンネル公開はできない | (未設定 = 無効化しない) |
| `BDBOARD_AI_QUOTA_DISABLED` | `1` または `true`(大小無視)で AI クォータウィジェットを無効化 | `false` |
| `BDBOARD_AI_QUOTA_PATH` | AI クォータ取得コマンドのパス/名前 | `ai-quota` |
| `BDBOARD_AI_QUOTA_TIMEOUT_MS` | 上記コマンドのタイムアウト(ミリ秒) | `70000`(70秒。`ai-quota all` の agy/Codex probe を順次待つ) |
| `BDBOARD_AI_QUOTA_CACHE_MS` | AI クォータ結果のキャッシュ有効期間(ミリ秒) | `300000`(5分) |
| `BDBOARD_CHAT_DISABLED` | `1` または `true`(大小無視)でチャット機能を無効化 | `false` |
| `BDBOARD_CLAUDE_PATH` | チャット機能が呼び出す `claude` CLI のパス/名前 | `claude` |
| `BDBOARD_CHAT_MODEL` | チャットで使うモデル(起動時の既定値1つ) | `sonnet` |
| `BDBOARD_CHAT_MODELS` | チャットの claude エージェントで選択可能なモデル一覧(カンマ区切り) | `sonnet,opus,haiku` |
| `BDBOARD_CHAT_TIMEOUT_MS` | チャット1リクエストのタイムアウト(ミリ秒) | `180000`(3分) |
| `BDBOARD_CHAT_RATE_WEIGHT_OPUS` | チャットレート制限の claude エージェント opus モデルの重み(claude エージェント限定。他エージェントの同名モデルには適用されない) | `5` |
| `BDBOARD_CHAT_RATE_WEIGHT_SONNET` | チャットレート制限の claude エージェント sonnet モデルの重み(claude エージェント限定) | `1` |
| `BDBOARD_CHAT_RATE_WEIGHT_HAIKU` | チャットレート制限の claude エージェント haiku モデルの重み(claude エージェント限定) | `1` |
| `BDBOARD_CHAT_RATE_WEIGHT_DEFAULT` | チャットレート制限の既定(未知モデル/重み未宣言モデル)重み。全エージェント共通のフォールバック | `1` |
| `BDBOARD_CHAT_TUNNEL_RATE_PER_MINUTE` | トンネル経由チャットの分あたりレート制限 | `10` |
| `BDBOARD_CHAT_TUNNEL_LIMIT_PER_DAY` | トンネル経由チャットの日あたりレート制限 | `100` |
| `BDBOARD_BD_PATH` | チャットが内部で使う `bd` CLI のパス/名前 | `bd` |
| `BDBOARD_CHAT_AGENTS` | チャットバックエンドとして追加で有効化する CLI の opt-in(カンマ区切り、大小無視)。既定(未設定)は `claude` のみで、`codex` を含めると Codex CLI アダプタ、`cursor` を含めると Cursor Agent CLI アダプタ、`agy` を含めると Antigravity CLI アダプタも登録される(同時指定も可)。未知の id は無視され `console.warn` でログに出る | (未設定 = claude のみ) |
| `BDBOARD_CODEX_PATH` | (`BDBOARD_CHAT_AGENTS` に `codex` を含めた場合のみ有効)チャット機能が呼び出す `codex` CLI のパス/名前 | `codex` |
| `BDBOARD_CODEX_MODEL` | (同上)Codex チャットで使うモデル。未設定時は `codex exec` 側の既定モデルに委ねる(`-m` を付けない) | (未設定) |
| `BDBOARD_CURSOR_PATH` | (`BDBOARD_CHAT_AGENTS` に `cursor` を含めた場合のみ有効)チャット機能が呼び出す `cursor-agent` CLI のパス/名前 | `cursor-agent` |
| `BDBOARD_CURSOR_MODEL` | (同上)Cursor チャットで使うモデル。未設定時は `cursor-agent` 側のアカウント既定モデルに委ねる(`--model` を付けない) | (未設定) |
| `BDBOARD_AGY_PATH` | (`BDBOARD_CHAT_AGENTS` に `agy` を含めた場合のみ有効)呼び出す Antigravity CLI のパス/名前 | `agy` |
| `BDBOARD_AGY_MODEL` | (同上)agy のモデル。未設定時はアカウント既定。`agy models` の id (例: `gemini-3.7-flash-medium`) を指定 | (未設定) |

`BDBOARD_CHAT_AGENTS=codex` で Codex アダプタを opt-in すると、claude アダプタが持つ
「bd 以外の組み込みツールを全廃する」制御が Codex CLI には存在しないため、実質的に shell
コマンド実行とプロジェクト内外のファイル読み書きまで許可することになる(descriptor の
`capability: 'unrestricted'` として UI 側にも正直に表示される)。加えて、非対話での MCP
ツール呼び出し承認に使っている `codex exec --approve-for-me` は、bd MCP ツールの承認だけでなく
プロジェクト外(例: `$HOME` 直下)へのファイル書き込みを要求するサンドボックスエスカレーションも
自動承認してしまうことを実測で確認しており(2026-08-16、codex-cli 0.147.0)、これを個別に
無効化できる `-c` オーバーライドは現時点で見つかっていない(詳細は
`src/infrastructure/chat/specs/codex-spec.ts` のコード内コメントを参照)。

**この opt-in を有効にすると、トンネル経由の外部アクセスからも codex アダプタを選択・実行できる**
(`BDBOARD_CHAT_AGENTS` はローカル/トンネルを区別しない意図的な設計。bdboard-9a9
の裁定に基づく)。実際に到達を絞っているのは他の書き込み系エンドポイントと同じ認可
(CSRF チェック + 強トンネルパスワード + セッション Cookie) のみで、opt-in 後の到達範囲を
ローカルに限定する仕組みは無い。つまり opt-in した状態でトンネルを公開すると、トンネル
認証を突破した相手であれば誰でも codex アダプタを使え、かつチケット本文などの説得力のある
テキスト(guardian LLM へのプロンプトインジェクション)経由で上記の `$HOME` 書き込みにまで
到達し得る。有効化するかどうかは、この二点(既定オフの opt-in であること／opt-in 後は
通常のトンネル認可の範囲でしか絞れないこと)を理解した上で判断すること。

また `codex exec resume <id>`(既存セッションへの追いメッセージ)は `--approve-for-me` を
受け付けないため、resume ターンでは bd MCP ツール呼び出しが常に承認されず失敗する既知の制約が
ある(bdboard-l1t.10)。

各チャットターンは `$CODEX_HOME/sessions` に rollout として全文が永続化される(トンネル越しの
入力・ツール実行結果を含む)。resume でこのセッションを参照し続ける必要があるため、
`--ephemeral`(セッションを残さないモード)は使えない。

`BDBOARD_CHAT_AGENTS=cursor` で Cursor Agent アダプタを opt-in すると、`cursor-agent --print` が
write/shell を含む全ツールへアクセスできることが CLI 自身の `--help` に明記されているため、これも
codex と同様 `capability: 'unrestricted'` として正直に申告する。cursor アダプタは常に
`--sandbox enabled` を付けて起動する(制限方向のフラグで危険フラグではない)。実測(2026-08-16、
使い捨て `mktemp -d` ディレクトリで実施)では、このフラグが無いと運用者の実際の
`~/.cursor/cli-config.json`(approvalMode: allowlist、許可済みは `Shell(ls)` のみ)の下で
シェルツール呼び出しが非対話実行時に全て拒否され bd 運用が一切できなかったが、
`--sandbox enabled` を付けるとサンドボックス化されたシェル実行が承認モードに関わらず
自動承認され、シェル経由の `bd` コマンド呼び出しが実際に成功することを確認した。

**`--sandbox enabled` の書き込み封じ込め範囲について**(2026-08-16 に再実測して結論を更新):
当初は「使い捨てディレクトリからプロジェクト外の `/tmp` への書き込みを指示したところ
ブロックされずに成功した」ことから「プロジェクト配下に閉じ込めるものではない」としていたが、
これは計測アーティファクトだった。再実測では、ワークスペース外かつ `/tmp`/`/var/folders` の
ような temp 系でもないパス(`$HOME` 直下)への書き込みを使い捨てディレクトリから指示したところ
`operation not permitted` で拒否され、モデルがサンドボックス外での再実行を要求してもその昇格は
承認されず、実際に `$HOME` にファイルは作成されなかった。つまり `--sandbox enabled` は
ワークスペース(+ temp 系ディレクトリ)への書き込みに封じ込めている可能性が高く、以前の
「プロジェクト配下に制限されない」という記述は誤りだった。

ただし bdboard はこの封じ込めを自ら継続検証・保証しているわけではなく(挙動は運用者の
cursor-agent のバージョンや設定次第で変わり得る)、bdboard 側のシステムプロンプトは
「bdboard は `--sandbox enabled` を常に付けて起動しており、書き込みはワークスペースと一時
ディレクトリ(`/tmp` 等)に封じ込められる見込みだが、bdboard 自身はその封じ込めを保証していない」
という記述的な言い方にしている(bdboard-l1t.5 最終レビュー FF1: 以前の「bdboard 側では
制限していない」という文言は、bdboard が無条件で `--sandbox enabled` を渡している事実と
矛盾する誤りだった — 制限を課しているのは運用者の設定ではなく bdboard 自身である)。
読み取りについては、`--sandbox enabled` 下でも seatbelt プロファイル実測
(`(allow file-read-data (subpath "/"))`)により全域 allow であることを確認済みで、
codex/claude 分岐と同じく「読み取りは実行ユーザーの権限で全域に及ぶ」という事実をシステム
プロンプトに明記している。詳細・実測ログの要約は `src/infrastructure/chat/bd-system-prompt.ts` と
`src/infrastructure/chat/specs/cursor-spec.ts` のコード内コメントを参照。

**cursor アダプタには codex/claude のような「bdboard 用に隔離された設定」を作る仕組みが無い**:
codex は `$CODEX_HOME` を専用ディレクトリに切り替えられ、claude は組み込みツールを bd MCP だけに
絞れるが、cursor-agent CLI にはそのようなプロセス単位の設定分離フラグが存在しない。そのため
cursor アダプタは、起動したホストにログイン済みの運用者の `~/.cursor` 配下の設定を丸ごと
引き継いで動く — グローバルに登録済みの MCP サーバー、approvalMode/permissions(上記の
サンドボックス自動承認の話もこの一部)、サンドボックス設定、プロジェクトの `.cursor/rules` や
`AGENTS.md` まで含む。実測(2026-08-16、`cursor-agent mcp list`)では、この開発機に
グローバル登録済みの MCP サーバーのうち 3 個(`microsoft.docs.mcp` / `vastai-manager` /
`apple-docs`)が `ready`(接続済み・利用可能)と表示された。つまり cursor アダプタは
「bd MCP ツールだけを渡す」どころか、bdboard がまったく関与しない任意のツール群へ
運用者の設定次第でアクセスできる可能性がある、という点を理解した上で opt-in すること。

ただし codex と違い、**cursor アダプタには bd MCP ツールが一切接続されていない**: `cursor-agent` にはターン単位で
MCP サーバーを注入する引数(claude の `--mcp-config` や codex の `-c mcp_servers.*` に相当するもの)が
存在せず、MCP サーバーは `.cursor/mcp.json` への永続的な書き込みと `cursor-agent mcp enable` による
ローカル承認リストへの追加を必要とする設計になっている(2026-08-16、cursor-agent
2026.08.11-e8db854 で実測確認)。この承認を非対話で自動化する唯一の手段と見られる
`--approve-mcps` は、他の危険フラグと同様 bdboard では使わない方針のため、cursor アダプタは
bd ツール無しの素のチャットとして動く(bd チケットの操作をしたい場合はシェルで `bd` コマンドを
直接呼び出すよう、システムプロンプト内で案内している。詳細は
`src/infrastructure/chat/specs/cursor-spec.ts` と `src/infrastructure/chat/bd-system-prompt.ts` の
コード内コメントを参照)。

また `cursor-agent` は初めて実行するディレクトリごとに「このディレクトリを信頼するか」という
ワークスペース信頼プロンプトを表示し、これに答えないと非対話実行(`--print`)がエラー終了する
(実測: 未信頼ディレクトリで `--print --mode ask` を試したところ `Workspace Trust Required` と表示され
終了コード 1 で失敗した)。これを一度だけスキップさせる `--trust` フラグが存在するが、
bdboard はこれを他の危険フラグ(`--force`/`--yolo`/`--allow-all` 等)と同列に扱い、**意図的に
一度も使わない**(コード側でも `src/infrastructure/chat/chat-specs-are-safe.test.ts` の
FORBIDDEN_CHAT_TOKENS に `--trust` を含めて機械的に禁止している)。そのため、bdboard の chat 経由で
cursor アダプタを使う各プロジェクトディレクトリは、事前に(bdboard の外で)一度
`cursor-agent` を対話実行してワークスペース信頼プロンプトに答えておく必要がある — 実測では、
一度信頼したディレクトリはその後 `--trust` なしの非対話実行でも成功することを確認済み。
信頼していないディレクトリでは、chat のそのターンは失敗として扱われる。この固定の
`Workspace Trust Required` stderr メッセージは専用の失敗コード `agent-workspace-untrusted`
として分類され(汎用の `agent-exit-nonzero` ではなく)、UI にも「このプロジェクトを信頼させる
必要がある」という趣旨の定型メッセージが表示される(生の stderr はサーバーログにのみ出す。
サーバー側の判定ロジックは `src/infrastructure/chat/specs/cursor-spec.ts` の
`classifyFailure`、UI 側のマッピングは `web/src/components/ChatPanel.tsx` の
送信エラー分岐(`error.status === 502 && error.code === 'agent-workspace-untrusted'`)、
`code` をサーバーの `{ error, code, detail }` レスポンスから運ぶ経路は `web/src/api.ts` の
`ApiError` を参照)。

cursor アダプタも codex と同様、opt-in さえ済んでいればトンネル経由の外部アクセスからも
選択・実行できる(`BDBOARD_CHAT_AGENTS` はローカル/トンネルを区別しない意図的な設計。
bdboard-9a9 の裁定に基づく。詳細は上記 codex の節を参照)。

`--resume <chatId>` によるセッション継続は codex と違い専用サブコマンドを必要とせず、
存在しない/でたらめな id を渡してもエラーにはならずその id を新規セッションの
`session_id` としてそのまま返す(実測: 未知の resume id を渡しても通常応答が返り、
`--approve-for-me` 相当の非対話 MCP 承認問題(bdboard-l1t.10)は元々 bd ツールが
接続されていないため cursor アダプタには存在しない)。

`BDBOARD_CHAT_AGENTS=agy` で Antigravity CLI (`agy --print`) アダプタを opt-in できる
(実測はすべて 2026-08-16、agy 1.1.13、使い捨てディレクトリで実施)。descriptor の capability は
`unrestricted` として正直に申告する — agy が実際に到達できるツール面は後述の運用者側
permissions 設定に依存し、bdboard はそれを書き換えも検証もできないため、狭い宣言をすると
嘘になる。agy にはターン単位の MCP 注入手段が無く(claude の `--mcp-config` / codex の
`-c mcp_servers.*` 相当が存在しない)、ワークスペースの `.agents/plugins/` や
`.agents/hooks.json` も CLI 1.1.13 は読み込まない(実測: hooks manager が
`loaded 0 named hooks` のまま)。そのため cursor と同様 bd MCP ツールは一切接続せず、
bd 操作はシステムプロンプトの案内どおりシェルの `bd` コマンドで行う。

agy の headless モード(`--print`)では、承認が必要なツール呼び出し(シェル実行・ファイル
読み取りを含む)が既定ですべて自動拒否される(stderr に「headless mode cannot prompt」を含む
固定メッセージ)。このマーカーはツール呼び出し1件単位の通知であってターン失敗の宣言では
ないため、bdboard はターンの応答が空のときだけ専用の失敗コード `agent-headless-denied` に
分類し、定型メッセージだけを UI に返す(生の stderr はサーバーログのみ。bdboard-pvl)。
マーカーが出ていても最終応答が得られたターンは応答をそのまま返し、サーバーログに警告だけを
残す。cursor の `--sandbox enabled` に相当する「非対話でもシェルを通す制限方向のフラグ」は
agy には無い — agy 自身の `--sandbox` は実測で headless の自動拒否を解除せず、さらに
sandbox 下では許可済みの bd コマンド自体が壊れる(Dolt が `$HOME/.dolt/config_global.json`
を開けず `operation not permitted` → `failed to open database`。同一設定で sandbox 無しなら
同じコマンドが成功)ため、意図的に渡していない。全ツールを自動承認する危険フラグは
方針どおり使わない。

そのため agy アダプタで bd 運用をするには、運用者が bdboard の外で
`~/.gemini/antigravity-cli/settings.json` に `{"permissions":{"allow":["command(bd)"]}}` を
追加しておく必要がある(実測でこの設定が headless に効くことを確認済み)。これは運用者の
agy 全セッションに効くグローバル設定であり、bdboard がこのファイルを書くことは無い
(cursor の「事前にワークスペース信頼を済ませておく」前提と同種の、運用者側の明示的な
セットアップ)。許可ルールのマッチ挙動は実測(agy 1.1.13)では次のとおり:
`command(bd)` は `bd version` や `bd -C "/path/to/proj" ready`(引数側の引用符は問題ない)を
許可する一方、先頭のコマンド語を引用した `"bd" version`、`bd version; echo X` のような
複合コマンド、`bdfoo --version` のような別単語、`bd $(echo version)` のようなコマンド置換は
いずれも拒否された。つまり素朴な「先頭一致」ではなく「先頭のコマンド語がルール文字列と
そのまま一致し、複合・置換構文を含まない」構造的な判定に見える。ただしこのセマンティクスは
上記プローブ以外(パイプ、`&&`、リダイレクト、環境変数前置等)は未検証で、実装は公開されて
いないため、実測より広い/狭い可能性がある。システムプロンプトはこの挙動に合わせて
「コマンドラインは素の bd で始め、1呼び出し1コマンド、連結・置換構文を使わない」と案内する。

注意: 許可ルールは「実際にコマンドラインの先頭に来る文字列」と一致する形で書く必要がある。
`BDBOARD_BD_PATH` を既定の `bd` 以外(例: `/usr/local/bin/bd` のような絶対パス)に設定した
場合、システムプロンプトはその文字列でコマンドを始めるよう案内するため、`command(bd)` では
覆えず、許可ルール側も同じ文字列(例: `command(/usr/local/bin/bd)`)で書く必要がある。
また `BDBOARD_BD_PATH` に空白を含むパスは(引用が必要になり、先頭語の引用は拒否されるため)
agy アダプタでは対応しない。

agy アダプタは運用者がログイン済みの OAuth アカウント(`~/.gemini` 配下)をそのまま使い、
会話履歴も agy 標準の `~/.gemini/antigravity-cli/` に保存される(bdboard はそこへ設定を
追加しない)。API キーをプロセス環境に流し込む経路は cursor と同じ方針で持たない。opt-in
さえ済んでいればトンネル経由の外部アクセスからも選択・実行できる点も codex/cursor と同じ
(bdboard-9a9 の裁定。詳細は上記 codex の節を参照)。タイムアウトは、agy 内部の
`--print-timeout` に `BDBOARD_CHAT_TIMEOUT_MS` + 60 秒を渡すことで bdboard 側の
タイムアウトが常に先に発火するよう固定し、一律 `agent-timeout` として報告される
(`BDBOARD_CHAT_TIMEOUT_MS` に 1 秒未満の値を設定した場合はこの先後関係を守るため
1 秒に切り上げる)。詳細は
`src/infrastructure/chat/specs/agy-spec.ts` と `src/infrastructure/chat/bd-system-prompt.ts` の
コード内コメントを参照。

`BDBOARD_AUTH_USER` は、Basic 認証を有効化する目的では既定値が無い(パスワードとセットで
明示設定が必須)。トンネル公開ボタンも、両方が揃って Basic 認証が有効なときだけ使える。
スマホへ渡す QR コードは Basic 認証情報そのものではなく、約5分有効・1回限りの
セッショントークン URL である。

認証情報の実値や `.env` の中身をコミットしたり Issue/PR に書いたりしないこと。設定すると
Cloudflare トンネル経由の公開には Basic 認証がかかる(ローカル直アクセスにはかからない)。
ローカルとトンネルの区別は `src/interface/http/local-request.ts` で、TCP 接続元が loopback、
Cloudflare 転送ヘッダ(`cf-connecting-ip` / `cf-ray` / `cf-visitor`)が無いことを確認し、
Basic 認証の免除ではさらに `Host` が `localhost` / `127.0.0.1` / `[::1]` と実際の待受ポートに
一致することも要求する(不一致・判定不能は免除しない)。

この区別が安全に使えるのは、bdboardへ直接接続するローカルブラウザと、HTTP モードの
`cloudflared` quick tunnel に限る。`ssh -L` / `ngrok` / `socat` /
`kubectl port-forward` など、Cloudflare ヘッダを付けず loopback で終端する橋渡しは認証免除の
前提外なので、このサーバーへ向けて使用しないこと。必要ならローカル免除を無効化する仕組みを
先に追加する。

## 外部 MCP クライアント (Claude Code / Codex / Cursor)

bdboard 同梱の bd 操作 MCP サーバーは、ポート 8787 の Web UI とは独立した stdio プロセスとして、
任意の MCP 対応ツールから起動できる。設定スニペットは次で生成する:

```bash
npm run mcp:config -- --project-root /abs/path/to/bd-project
```

出力は stdout のみ。絶対パスを含むのでリポジトリへコミットしないこと。各ツールへの貼り付け手順、
セキュリティ上の注意、動作確認レシピは [docs/MCP-CLIENTS.md](docs/MCP-CLIENTS.md) を参照。

## アーキテクチャ

サーバー側 (`src/`) はオニオンアーキテクチャで、依存方向を `dependency-cruiser`
(`.dependency-cruiser.cjs`、`npm run check:boundaries` で実行)により機械的に強制している。

```
src/
  domain/          # 純粋ロジック。外部依存ゼロ
  application/     # ユースケース + ポート(interface)定義。infrastructure・interface に依存禁止
  infrastructure/  # ポートの実装(bd CLI 実行 / fs / sqlite / process 等)
  interface/       # Hono ルート・SSEハブ・Basic認証などの HTTP 層
web/               # Vite + React。src/ を import しない別ビルド(devはVite proxyでAPIに接続)
```

不変条件(`.dependency-cruiser.cjs` で強制、違反すると `check:boundaries` が失敗する):

- `domain` は `application` / `infrastructure` / `interface` のいずれにも依存しない
- `application` は `infrastructure` にも `interface` にも依存しない
- `interface` は `infrastructure` に直接依存しない
- `infrastructure` は `interface` に依存しない
- `child_process` の import は `infrastructure/process` または `infrastructure/runners` 配下からのみ許可

(`infrastructure → domain` と `interface → domain` の直接依存は意図的に禁止していない。詳細と
経緯は `.dependency-cruiser.cjs` 冒頭のコメントを参照。)

`web/` は `src/` を import しない。ビルドも別(`npm run build:web` が `web/` 側の `tsc --noEmit` +
Vite ビルドを行う。`npm run build` はサーバー側 `src/` の型チェックのみ)。

## 設計時の前提(実装前に必ず読むこと)

以下は `bd` CLI を扱う上で実測して確認済みの罠で、実装が進んだ今も有効な知見(削除しない):

- bd のバックエンドは **SQLite ではなく Dolt**。直接触らず必ず `bd` CLI 経由
- 依存でブロック中のチケットも **`status` は `"open"` のまま**
- 依存の `type` には `blocks` 以外に **`parent-child` が混ざる**(誤読すると約5倍に誤判定)
- チケット接頭辞は**プロジェクト名とは限らない**(実例: `epic-haslett-00ae14`)
- `bd update --session` は**クローズイベント専用**でリンク用途に使えない
- トランスクリプトは合計 **1.77GB / 最大433MB**(実測当時)。全読みは論外

## 開発フローの詳細

ビルド/テストコマンドの一覧、常時ローカルホスティング運用、git ワークフロー(worktree +
ブランチ + PR)の詳細は `CLAUDE.md` を参照(このファイルの守備範囲外)。

## 当初計画(歴史的文書)

→ [docs/PLAN.md](docs/PLAN.md)

v1 着手前に書かれた実装計画の全文。bd CLI の実出力、Claude Code のセッションレジストリ、
worktree 解決の実挙動などを実機で調査した結果に基づく設計判断が記録されている。現在の
実装は v1 スコープ(可視化 + セッション紐付け中心)を大きく超えており、この文書とは
乖離している箇所がある。「なぜこの設計にしたか」の経緯を追う歴史的資料として読むこと。

## ライセンス

MIT License。詳細は [LICENSE](LICENSE) を参照。
