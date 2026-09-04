# bdboard-harness hooks

failure-catalog の「D: 文章で禁止しても再発する操作ミス」を、文章ではなく Claude Code
の hook で機械的に止めるスクリプト群 (bdboard-pkr6.1 / docs/HARNESS-EVALUATION.md
§2.3・§5 P1)。`.claude/settings.json` への登録は注入 API 側が行う (bdboard-pkr6.2)。

## 共通の約束

- **deny は exit 2**、stderr に「何を止めたか / なぜ / 代わりに何をするか」を 3 行以内。
- **allow は exit 0 で無出力**。
- **判定不能はすべて allow (fail-open)**。`set -e` は使わない。hook が壊れて作業が
  止まるより、従来どおり文章ルールへ戻るほうが安全という判断。
- 入力は stdin の Claude Code hook JSON。抽出は `jq` → `python3` の順に使い、どちらも
  無ければ正規表現で判定できる規則だけに縮退し、stderr へ 1 行
  `bdboard-harness hook: jq/python3 not found; contract patterns skipped` を出す。
- 依存は bash (3.2 互換) / coreutils / git / bd と、任意で jq・python3 のみ。**node に
  依存しない** (注入先が npm プロジェクトとは限らない)。
- 実行ビットは注入時に付ける。手で叩くときは `bash <script>` で呼ぶ。

## pre-bash-guard.sh — PreToolUse (matcher: `Bash`)

`tool_input.command` を見て次を deny する。

| # | deny 条件 | 代わりに |
|---|---|---|
| 1 | `pkill` / `killall` (単語境界。コメント内も含む) | `lsof -nP -iTCP:<port> -sTCP:LISTEN` や `pgrep -x <name>` で PID を特定し `kill <pid>` |
| 2 | `--remote` の無い `bd dolt push` / `bd dolt pull` | `bd dolt push --remote <name>` (bdboard では `legacy`)。事前に `bd dolt remote list` で `origin` が無いことを確認 |
| 3 | `git stash` のうち `push … -m …` / `apply <sha>` / `list` / `drop` / `show` 以外 (= bare `git stash`・`git stash pop`・`git stash save`) | WIP コミット。どうしても要るなら `git stash push -u -m "<tag>"` + `git stash apply <sha>` |
| 4 | `tool_input.run_in_background` が true で、コマンド末尾 (行末・`;` 直前) に単独の `&` (`&&`・`2>&1`・`>&2` は除外) | 末尾 `&` を外して `run_in_background` だけに任せる |
| 5 | 検証コントラクトの `hooks.denyBashPatterns` にマッチ | 同 index の `hooks.denyBashMessages` (無ければ既定文) が案内する手順 |

### 5 の検証コントラクト

`git -C <cwd> rev-parse --show-toplevel` で求めたリポジトリ根の
`.claude/bdboard-harness.json` (bdboard-pkr6.3 が定義) を読む。

```json
{
  "hooks": {
    "denyBashPatterns": ["npm run verify:steps"],
    "denyBashMessages": ["npm run verify:steps は直叩き禁止です。npm run verify を使ってください。"]
  }
}
```

- `denyBashPatterns` の各要素は ERE。`denyBashMessages` は同じ index で対応させる
  (対応が要るので、パターン自体に改行を含めないこと)。
- ファイルが無い・読めない・JSON が壊れている場合はこの規則ごと skip する。
- worktree でも `rev-parse --show-toplevel` は worktree の根を返すので、tracked
  ファイルであればそのまま読める。

### 誤検知について

1 は「`# pkill` のようなコメント内でも deny する」ほど緩い判定にしてある。誤検知した
ときの代償は案内が 1 回出るだけで、見逃したときの代償 (常時稼働サーバーの巻き添え停止)
より軽い、という非対称性に合わせた設計。

## pre-edit-guard.sh — PreToolUse (matcher: `Edit|Write|MultiEdit|NotebookEdit`)

`tool_input.file_path` (NotebookEdit は `notebook_path`) を絶対パスへ正規化して deny する。
正規化は `.` / `..` の字句的な畳み込みのみで、symlink は解決しない — 解決すると照合
したいパス片が消えることがあるため。

| # | deny 条件 | 代わりに |
|---|---|---|
| 1 | パスが `/.claude/skills/bdboard-harness/` を含む (注入コピー。bdboard 自身でも deny) | 原本 `harness/packs/bdboard-harness/` を直して再注入。注入先固有の内容なら `.claude/skills/project-harness/` |
| 2 | パスが `/.beads/` を含み、かつ現在ブランチが `bd/` で始まる | `.beads/` は PR ブランチで触らない (CI ガードで落ちる)。main への `chore(beads)` 直コミット例外で扱う |

ブランチは「そのパスの実在する最も近い祖先ディレクトリ」に対する
`git rev-parse --abbrev-ref HEAD` で見る (detached HEAD のときは `symbolic-ref` で再試行)。
git が無い・パスが取れない・ブランチが判らない場合は allow。

## stop-ticket-gate.sh — Stop (matcher なし)

「チケットに何も残さずセッションを終える」を差し戻す。

1. `stop_hook_active` が true なら通過 (無限ループ防止)。
2. チケット ID: ブランチが `bd/<id>` ならその `<id>`。そうでなければ cwd の
   `.claude/worktrees/<name>` の `<name>` を候補にし、`bd show <name> --json` が成功
   したら採用。どちらも駄目なら通過 (per-ticket worktree ではない)。
3. `bd show <id> --json` の status が `in_progress` でなければ通過。
4. `bd comments <id> --json` に `PR:` を含むコメントがある、または最新コメントが
   15 分以内なら通過 (痕跡は残っている)。
5. それ以外で `git status --porcelain` が非空、または `origin/<mainBranch>..HEAD` に
   未 push コミットがあれば **exit 2** で差し戻す。`mainBranch` は検証コントラクトの
   同名フィールド、無ければ `main`。`origin/<mainBranch>` が無ければこの条件は skip。
6. それ以外は通過。

`bd` が PATH に無い場合・JSON ツールが無い場合はいずれも通過する。

## 手で試す

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"pkill -f tsx"}}' \
  | bash harness/packs/bdboard-harness/hooks/pre-bash-guard.sh; echo $?   # => 2

echo '{"tool_name":"Bash","tool_input":{"command":"bd dolt push --remote legacy"}}' \
  | bash harness/packs/bdboard-harness/hooks/pre-bash-guard.sh; echo $?   # => 0
```

自動テストは `src/infrastructure/harness/pack-hooks.test.ts` (bash で spawn して stdin に
JSON を流す統合テスト。Windows では skip)。
