---
description: bdboard の初回セットアップを対話的に行う(スキャンルート等の基本設定)
---

# /setup — bdboard 初回セットアップウィザード

あなたはこのリポジトリ(bdboard)の初回セットアップを対話的に進めるウィザードです。
git clone 直後の環境を想定し、下のフェーズ 0→5 を順に実行してください。既にセットアップ済みの
環境で実行された場合も安全です(既存設定を表示して、変更したい項目だけ更新する動きになる)。

## 対話の原則

- **1フェーズずつ進める。** フェーズの冒頭で「これから何を確認/質問するか」を一言で伝える。
- **質問は最小限にする。** 必ず訊くのはフェーズ2(スキャンルート)とフェーズ4(任意設定を使うか)
  だけ。それ以外は自動判定し、結果だけ報告する。各質問には必ず既定値を提示し、
  「Enter相当(そのままでOK)」を選べるようにする。選択肢が明確な質問には AskUserQuestion
  ツールが使えるなら使う。
- **ユーザーの言語に合わせる。** 既定は日本語。ユーザーが他言語で話したらその言語で対話する。
- **書き込みは事前確認してから。** 設定ファイルへの書き込み・`.env` の作成/変更・依存インストールは、
  内容(またはコマンド)を見せて同意を得てから実行する。
- **秘密情報をチャットに出さない/書かせない。** パスワード類はユーザー自身にファイルを編集して
  もらい、あなたは set/missing の確認だけ行う(フェーズ4参照)。`printenv` や `env` の全ダンプは
  実行しない(個別変数のみ確認する)。

## フェーズ 0: 環境診断(質問なし・報告のみ)

以下を順に確認し、結果を短い表にまとめて報告する。

```bash
node -v && npm -v                # Node.js 20+ 推奨
bd version || echo "bd: MISSING" # bdboard は bd CLI が無いと動かない
```

- `bd` が無ければ: bdboard は [gastownhall/beads](https://github.com/gastownhall/beads) の
  `bd` CLI のフロントエンドなので、先に bd のインストールが必要と案内する(macOS:
  `brew install beads`)。ユーザーがインストールするまでフェーズ5の動作確認は保留してよいが、
  設定ファイルの作成(フェーズ2〜3)自体は先に進められる。
- bd のバージョンが v1.2.1 以外なら、README「bd CLI の前提バージョン」節の注意(不用意に
  upgrade しない)を一言添える。ブロックはしない。

```bash
ls node_modules > /dev/null 2>&1 && echo "root deps: OK" || echo "root deps: MISSING"
ls web/node_modules > /dev/null 2>&1 && echo "web deps: OK" || echo "web deps: MISSING"
ls web/dist/index.html > /dev/null 2>&1 && echo "web build: OK" || echo "web build: MISSING"
```

設定ファイルのパスを決める(サーバー実装 `src/infrastructure/fs/config-path.ts` と同じ規則。
`BDBOARD_SCAN_ROOTS_CONFIG_PATH` が設定されていればそちらが優先):

```bash
node -p 'process.env.BDBOARD_SCAN_ROOTS_CONFIG_PATH || (process.platform === "win32" ? require("path").join(process.env.APPDATA || require("path").join(require("os").homedir(), "AppData", "Roaming"), "bdboard", "config.json") : require("path").join(require("os").homedir(), ".config", "bdboard", "config.json"))'
```

既存設定と環境変数オーバーライドを確認する:

```bash
cat "<上で決めたパス>" 2>/dev/null || echo "(設定ファイルなし)"
node -p 'process.env.BDBOARD_SCAN_ROOTS ?? "(未設定)"'   # 設定されていると保存済み設定より優先される
grep -E '^BDBOARD_(SCAN_ROOTS|PORT|HOST)=' .env 2>/dev/null || true
```

ポートと稼働中サーバーを確認する(既定ポート 8787。`.env` や環境変数で `BDBOARD_PORT` が
あればそれを使う):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/health
# 200 → bdboard が既に稼働中(フェーズ5で起動をスキップ)
# 000 → 未稼働。lsof -nP -iTCP:8787 -sTCP:LISTEN で別プロセスが掴んでいないかも見る
#        (別プロセスが掴んでいる場合はフェーズ4でポート変更を提案)
```

## フェーズ 1: 依存インストール(不足時のみ)

フェーズ0で deps が MISSING だった場合のみ、確認を取ってから実行する:

```bash
npm install
npm --prefix web install
```

## フェーズ 2: スキャンルートの対話(このウィザードの本体)

まず1〜2文で説明する: bdboard は「スキャンルート」配下を再帰的に走査し、`.beads/` を持つ
プロジェクトを自動発見して1枚の看板に集約する。ここではその走査起点を決める。

現在の有効値を整理して見せる。優先順位は **`BDBOARD_SCAN_ROOTS` 環境変数 > 設定ファイル >
OS既定値**。OS既定値は `~/Documents`(存在しなければホームディレクトリ。Windows は
`%USERPROFILE%\Documents`)。

- `BDBOARD_SCAN_ROOTS` が設定されている場合はここで明示的に扱う: 環境変数がある限り
  設定ファイルは**無視される**。ユーザーに「(a) 環境変数を外して設定ファイルに一本化する
  (推奨) / (b) 環境変数運用を続ける」を選んでもらう。(b) なら設定ファイルの書き込みは
  スキップしてフェーズ4へ。(a) で `.env` に書かれている場合はその行を削除する
  (シェル環境由来ならユーザーに unset してもらう)。

質問: **「どのディレクトリ配下をスキャンしますか?(複数可)」** 既定値 = 保存済み設定が
あればその値、無ければ OS 既定値。ユーザーが普段 bd プロジェクトを置いている親ディレクトリを
答えてもらう(例: `~/src`)。`~` はホームディレクトリに展開して扱う。

入力を検証する(サーバー側 `src/domain/scan-root-policy.ts` と同じ判定。不正なら理由を伝えて
訊き直す):

- **絶対パスのみ**(相対パスは拒否)。最大50件、各4096文字以内。
- **危険ルートは完全一致で拒否**: `/` そのもの、および `/etc` `/usr` `/bin` `/sbin` `/var`
  `/dev` `/proc` `/sys` `/boot` `/lib` `/lib64` `/tmp` `/private` `/System` `/Library`
  `/Volumes` `/System/Volumes` `/System/Volumes/Data` `/run` `/mnt` `/media` `/srv`
  (大文字小文字無視)。Windows はドライブ直下(`C:\` 等)と `C:\Windows`
  `C:\Program Files` `C:\Program Files (x86)` `C:\ProgramData`。これらの**さらに深い配下**
  (例: `/usr/local/src`)は許可される。
- 存在確認: ディレクトリとして存在しないパスは警告する(保存自体は可能だが、まず typo を疑う)。
- ホームディレクトリ直接指定は許可されるが、走査上限(`BDBOARD_SCAN_DIR_LIMIT`、既定5万
  ディレクトリ)に当たってプロジェクトが欠ける可能性を警告し、より狭い親ディレクトリを勧める。

続けて軽く1問: **「走査から除外したい配下はありますか?(任意、通常は無しでOK)」**
excludePaths も絶対パスで受け、末尾のパスセパレータは取り除いて保存する(ルート/ドライブ
ルート単体は除く)。

## フェーズ 3: 設定ファイルの書き込み

書き込む JSON をプレビューとして見せ、同意を得てから実行する。**既存ファイルの無関係なキー
(boardThresholds / aiQuotaAlert 等)は必ず保持する**。以下はサーバー自身の保存形式
(2スペースインデント + 末尾改行、マージ書き)と同じ結果になる:

```bash
CONFIG_FILE="<フェーズ0で決めたパス>"
node -e '
const fs = require("fs"), path = require("path");
const [file, rootsJson, excludesJson] = process.argv.slice(1);
let existing = {};
try {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  if (p && typeof p === "object" && !Array.isArray(p)) existing = p;
} catch {}
fs.mkdirSync(path.dirname(file), { recursive: true });
const merged = { ...existing, scanRoots: JSON.parse(rootsJson), excludePaths: JSON.parse(excludesJson) };
fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
console.log("wrote " + file);
' "$CONFIG_FILE" '["/abs/path/one","/abs/path/two"]' '[]'
cat "$CONFIG_FILE"
```

書き込み後、`cat` の結果をユーザーに見せる。

## フェーズ 4: 任意設定(ポート / Basic認証)

1問にまとめて訊く: **「ローカルで使うだけなら追加設定は不要です。ポート変更(既定8787)か、
スマホ等からのトンネル公開に必要な Basic 認証を設定しますか?(通常はスキップでOK)」**

- **ポート変更**(フェーズ0で8787が別プロセスに使われていた場合はここで能動的に提案する):
  `.env`(git管理外、`npm run start`/`npm run dev` が自動読込)に `BDBOARD_PORT=<番号>` を
  追記する。`.env` が無ければ `cp -f .env.example .env` してから追記。
- **Basic認証**(トンネル公開・リモートアクセスに必須。ローカル直アクセスには不要):
  `.env` を用意した上で、**値はユーザー自身に編集してもらう**。あなたはパスワードをチャットで
  受け取らない・ファイルから読み上げない。編集後の確認は set/missing のみ:

  ```bash
  grep -qE '^BDBOARD_AUTH_USER=.+' .env && echo "BDBOARD_AUTH_USER: set" || echo "BDBOARD_AUTH_USER: missing"
  grep -qE '^BDBOARD_AUTH_PASSWORD=.+' .env && echo "BDBOARD_AUTH_PASSWORD: set" || echo "BDBOARD_AUTH_PASSWORD: missing"
  ```

その他の細かい調整(チャットバックエンドの opt-in、走査上限、更新間隔など)はここでは
設定しない。README「主要な環境変数」の表を案内するだけに留める。

## フェーズ 5: ビルドと起動確認

**フェーズ0で既に稼働中(health 200)だった場合**: 起動はスキップし、
`curl -sS http://127.0.0.1:<port>/api/settings/scan-roots` で保存した scanRoots /
excludePaths がそのまま返ること(および `envOverride: false`)を確認して結果を見せる。
プロジェクト一覧への反映は定期リフレッシュ(既定5分)またはサーバー再起動で行われることを
伝える。稼働中のサーバーを勝手に再起動しない。

**未稼働の場合**: 確認を取ってから起動する。

```bash
# web build が MISSING のときだけ(API だけなら無くても起動はする)
npm run build:web

# バックグラウンドで起動し、health が 200 になるまで数秒待つ
npm run start
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/api/health
```

起動したら検証する:

1. `/api/health` が **200**(ステータスコードで判定する。`curl -f` は使わない)。
2. `/api/settings/scan-roots` の応答の `scanRoots` / `excludePaths` がフェーズ3で書いた値と
   一致し、`envOverride` が false であること(フェーズ2で (b) を選んだ場合は
   `envOverride: true` と `envScanRoots` が期待値であること)。
3. `/api/projects` にプロジェクトが載ること。**0件の場合は失敗ではなく診断する**: スキャン
   ルート配下に `.beads/` を持つプロジェクトが実在するか(`ls <root>/*/.beads` 等)、ルートの
   指定階層が深すぎ/浅すぎないかを確認し、必要ならフェーズ2に戻って調整する。

最後にまとめを提示して終了する:

- 設定ファイルのパスと最終内容
- ボードの URL(`http://127.0.0.1:<port>`)と、起動したままにするか止めるかの確認
  (止める場合はこのウィザードが起動したプロセスだけを止める)
- 次の一歩: README の「Quick tour」節、設定の変更はヘッダーの「設定」画面からいつでも可能、
  Claude Code 以外の MCP クライアント連携は `docs/MCP-CLIENTS.md`
