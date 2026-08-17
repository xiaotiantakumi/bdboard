# 外部 MCP クライアント向け bd サーバー設定

## これは何か

bdboard には、Claude 依存ゼロの stdio MCP サーバー (`bd-mcp-server-main.ts`) が同梱されている。
`bd ready` / `bd show` / `bd create` などの bd 操作を、MCP 対応ツールから直接呼び出せる。

- bdboard の Web UI (ポート 8787) とは無関係。新しい常駐プロセスは起こさない。
- 各ツールが必要なときに子プロセスとして MCP サーバーを起動する。
- サーバーは `--project-root` で指定したディレクトリを bd プロジェクトルートとして扱う
  (bdboard 自身の checkout とは限らない)。

## 設定の生成

リポジトリルートで次を実行する:

```bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 22

npm run mcp:config -- --project-root /abs/path/to/bd-project
```

オプション:

| フラグ | 意味 | 既定値 |
|---|---|---|
| `--project-root <abs>` | bd 操作対象のプロジェクトルート | `process.cwd()` を絶対化 |
| `--bd-path <path>` | `bd` バイナリのパスまたは名前 | `bd` |
| `--name <name>` | MCP サーバー登録名 | `bd` |
| `--target claude\|codex\|cursor\|all` | 出力するセクション | `all` |

出力は stdout のみ。ファイルは書き込まない。冒頭の `#` 行は注意書きなので、
JSON/TOML に貼るときは該当セクションの本文だけを使う。

## Claude Code

生成された `## Claude Code` セクションの JSON を使う。

### プロジェクト固定で使う

プロジェクト直下に `.mcp.json` を置き、生成された JSON (`mcpServers` を含む全体) を貼る。

`.mcp.json` 経由で登録したサーバーは初回に承認が要る。承認前は
`claude mcp list` に `⏸ Pending approval (run \`claude\` を実行して承認)` と出て接続されない。
対話セッションで `claude` を一度起動して承認すること。

### CLI で登録する

`claude mcp add-json` に渡すのは **`mcpServers` を剥がした内側のサーバーオブジェクト**であって、
生成 JSON 全体ではない。ここを間違えると登録は通るのに接続できない。

```bash
claude mcp add-json bd '{"command":"/abs/node","args":["/abs/tsx","/abs/bd-mcp-server-main.ts","--project-root","/abs/project","--bd-path","bd"]}' --scope user
```

生成物から内側だけ取り出すなら:

```bash
npm run mcp:config --silent -- --project-root /abs/path --target claude \
  | sed -n '/^{/,$p' \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["mcpServers"]["bd"]))'
```

`--scope` は `local` (既定) / `user` / `project`。CLI で登録したサーバーは承認済み扱いになり、
`claude mcp list` が `✔ Connected` になる。

### 呼び出しごとに上書きする

```bash
claude --mcp-config /path/to/mcp.json --strict-mcp-config ...
```

`--strict-mcp-config` を付けると、他の MCP 設定ソースを無視して指定ファイルだけが使われる。
このファイルは `mcpServers` を含む生成 JSON 全体をそのまま使える。

### 本番設定を汚さずに試す

`CLAUDE_CONFIG_DIR` を一時ディレクトリに向ければ、`~/.claude.json` を触らずに検証できる。

```bash
CLAUDE_CONFIG_DIR=$(mktemp -d) claude mcp add-json bd '<inner json>' --scope user
```

## Codex

生成された `codex mcp add ...` ワンライナーを実行すると、
`$CODEX_HOME/config.toml` (既定 `~/.codex/config.toml`) が書き換わる。
**副作用がある**ので、本番の設定を汚したくないときは一時ディレクトリを使う:

```bash
export CODEX_HOME=$(mktemp -d)   # 以降の codex コマンドすべてに効かせる
codex mcp add bd -- ...
codex mcp list
codex mcp get bd
```

`CODEX_HOME` を export せずに `CODEX_HOME=... codex mcp add` とだけ書くと、
続く `codex mcp list` は**本番の `~/.codex/config.toml` を読んでしまう**ので注意。
本番に入れたものを消すときは `codex mcp remove bd`。

なお `codex mcp list` / `get` は登録内容を表示するだけで、MCP サーバーを起動しない。
サーバーが実際に動くかは下の「動作確認レシピ」で確かめること。

TOML を直接編集する場合は、生成された `[mcp_servers.bd]` ブロックを
`~/.codex/config.toml` に追記する。

## Cursor

Cursor (`cursor-agent`) には呼び出しごとの `--mcp-config` 相当フラグがない。
次のいずれかのファイルに JSON を置く必要がある:

- プロジェクト配下: `.cursor/mcp.json`
- ユーザー全体: `~/.cursor/mcp.json`

ファイルを置いただけでは `not loaded (needs approval)` のままなので、承認が要る:

```bash
cursor-agent mcp list          # bd: not loaded (needs approval)
cursor-agent mcp enable bd     # ✓ Enabled and approved MCP server: bd
cursor-agent mcp list-tools bd # ツール 14 個が列挙される
```

`enable` はホーム側 (`~/.cursor/cli-config.json`) の承認リストを書き換える。
本番の承認リストを触らずに試したいときは `HOME=$(mktemp -d)` を付けて実行する。

プロジェクト配下に置く場合、そのリポジトリの `.gitignore` に `.cursor/mcp.json` を
足すか、ホーム側 (`~/.cursor/mcp.json`) に置くこと。生成物には絶対パスが含まれるため、
誤ってコミットしないよう注意する。

## パスの差し替え方

- `--project-root` は「どの bd プロジェクトを操作するか」を決める。
  bdboard の checkout パスと一致させる必要はない。
- `--bd-path` には `command -v bd` の結果を渡すと PATH に依存しなくなり、確実になる。
- `node` / `tsx` / サーバーエントリのパスは bdboard の checkout 位置に依存する。
  checkout を移動したら `npm run mcp:config` を再実行して差し替える。

このリポジトリでは、素の shell の `node` が古い場合がある。
生成設定は `process.execPath` (v22 以上) を明示的に `command` に使う。
`tsx` の shebang (`#!/usr/bin/env node`) だけに任せると壊れる。

## セキュリティ

- 生成物はホームディレクトリ配下の絶対パスを含む。リポジトリにコミットしない。
- API キーやトークンは不要。bd はローカルの Dolt DB を見るだけ。
- 生成 JSON に `env` フィールドは含めない (シークレット混入を防ぐ)。手で足さないこと。
- 公開されるツールには書き込み系 (`bd_create` / `bd_update_status` / `bd_close` など) も含まれる。
  MCP を接続したツールはチケットを変更できる。信頼できるプロジェクトルートだけを指定すること。

## 動作確認レシピ

課金なし・外部送信なしで、生成された `command` / `args` が正しいか確認できる。

1. 設定を生成する:

   ```bash
   npm run mcp:config -- --project-root /abs/path/to/bd-project --target all
   ```

2. 出力された `command` / `args` に JSON-RPC を流し込む。サーバーは stdin を
   1 行 1 メッセージで読むので、複数行を一度にパイプすれば 1 プロセスで完結する
   (`<command>` / `<args...>` は生成された値に置き換える):

   ```bash
   printf '%s\n%s\n%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-check","version":"0"}}}' \
     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
     | <command> <args...>
   ```

3. `initialize` が `serverInfo: {"name":"bd",...}` を返し、`tools/list` が 14 個の
   ツール (`bd_list` / `bd_ready` / `bd_show` ...) を返せば成功。

4. 読み取り系のツールを 1 つ叩くところまで確認するなら、上に次の行を足す:

   ```json
   {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bd_ready","arguments":{"limit":2}}}
   ```

各ツール側からの確認 (どれもモデル呼び出しを伴わないので課金されない):

| ツール | コマンド | 確認できること |
|---|---|---|
| Claude Code | `claude mcp list` / `claude mcp get bd` | 実際に接続してヘルスチェック (`✔ Connected`) |
| Codex | `codex mcp list` / `codex mcp get bd` | 設定の登録内容のみ (サーバーは起動しない) |
| Cursor | `cursor-agent mcp list-tools bd` | サーバーを起動してツール 14 個を列挙 |

`cursor-agent` は事前に `cursor-agent mcp enable bd` で承認が要る
(承認前は `not loaded (needs approval)` になる)。

実際のツールから使う前に、まず手順 2 でサーバー単体が起動できることを確認しておくと
切り分けが楽になる。
