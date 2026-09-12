# bdboard-harness hooks

failure-catalog の「D: 文章で禁止しても再発する操作ミス」を、文章ではなく Claude Code
の hook で機械的に止めるスクリプト群 (bdboard-pkr6.1 / docs/HARNESS-EVALUATION.md
§2.3・§5 P1)。`.claude/settings.json` への登録は注入 API 側が行う (bdboard-pkr6.2)。

## 共通の約束

- **deny は exit 2**、stderr に「何を止めたか / なぜ / 代わりに何をするか」を 3 行以内。
- **allow は exit 0 で無出力**。
- **判定不能はすべて allow (fail-open)**。`set -e` は使わない。hook が壊れて作業が
  止まるより、従来どおり文章ルールへ戻るほうが安全という判断。
- 入力は stdin の Claude Code hook JSON。抽出は `jq` → `python3` の順に使い、必要な
  フィールドは 1 回の呼び出しでまとめて取り出す (US=0x1f 区切り。TAB も改行もコマンド
  文字列やパスに普通に含まれるので区切りには使えず、TAB は IFS 空白扱いで空フィールド
  も消える)。
- **どちらの JSON ツールも無い環境では、3 本とも何も判定せず exit 0 で通す
  (fail-open)**。stderr は警告 1 行だけ
  `bdboard-harness hook: jq/python3 not found; skipping all checks (fail-open)`。
  生の JSON 文字列へ正規表現/部分一致を当てる縮退判定はしない — `git stash list` の
  ような無害なコマンドが JSON 全体との一致で deny されるうえ、案内も長くなるため。
- 依存は bash (3.2 互換) / coreutils / git / bd と、任意で jq・python3 のみ。**node に
  依存しない** (注入先が npm プロジェクトとは限らない)。
- 実行ビットは注入時に付ける。手で叩くときは `bash <script>` で呼ぶ。

## pre-bash-guard.sh — PreToolUse (matcher: `Bash`)

`tool_input.command` を見て次を deny する。

| # | deny 条件 | 代わりに |
|---|---|---|
| 1 | `pkill` / `killall` (単語境界。コメント内も含む) | `lsof -nP -iTCP:<port> -sTCP:LISTEN` や `pgrep -x <name>` で PID を特定し `kill <pid>` |
| 2 | `--remote` の無い `bd dolt push` / `bd dolt pull` | `bd dolt push --remote <name>`。事前に `bd dolt remote list` で `origin` が無いことを確認 |
| 3 | `git stash` のうち `push` + メッセージ指定 / `apply <sha>` / `list` / `drop` / `show` 以外 (= bare `git stash`・`git stash pop`・`git stash save`・メッセージ無しの `push`) | WIP コミット。どうしても要るなら `git stash push -u -m "<tag>"` + `git stash apply <sha>` |
| 4 | `tool_input.run_in_background` が true で、行末 (または `;` 直前) に単独の `&` (`&&`・`2>&1`・`>&2` は除外) | 末尾 `&` を外して `run_in_background` だけに任せる |
| 5 | 検証コントラクトの `hooks.denyBashPatterns` にマッチ | 同 index の `hooks.denyBashMessages` (無ければ既定文) が案内する手順 |
| 6 | `aimix run` の実効 mode が `implement` / `refactor` で、`models.routes` の該当セルに候補があるのに member が不明、`--members` 由来、`--model` 無し、または `<member>:<model>` が候補外。セルが `models.exclude` で候補 0 件なら、実効 member が除外中のとき | `scripts/route.sh <工程> <low\|med\|high>` で候補を引き、`--member <member> --model <model>` で渡す。表から外れるなら `BDBOARD_ROUTE_OVERRIDE="<理由>"` を前置 |

2・3 は**コマンド列を `;` `&` `|` と改行で「コマンド 1 個」へ割ってから**、その 1 個ずつ
判定する。列全体をまとめて見ると `bd dolt push --remote backup; bd dolt push` や
`git stash list; git stash pop` のように「先頭だけ行儀の良い」列が素通りする。

3 のメッセージ指定は `-m` / `-um` のような短オプションの束・`-m"x"`・`--message`・
`--message="x"` のいずれでもよい (` -m ` のリテラル一致ではない)。

4 は `grep` の行単位マッチなので `$` は行末を指す。**途中行の末尾にある `&` も deny
する** — 複数行コマンドの 2 行目以降でバックグラウンド化しても二重非同期化は同じに
起きるため。

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
- **`denyBashMessages` の文言は注入先プロジェクトが書いたテキストとして扱う**。改行/CR/
  TAB は空白へ潰し、200 文字で切り、`bdboard-harness: (project contract) <文言>` の形で
  必ず 1 行だけ出す。そのまま流すと「stderr は 3 行以内」の不変条件が壊れ、エージェント
  への指示文を紛れ込ませるプロンプト注入面にもなるため。
- worktree でも `rev-parse --show-toplevel` は worktree の根を返すので、tracked
  ファイルであればそのまま読める。

### 6 の振り分け照合

規律 6 (SKILL.md) の「工程 × 複雑度のモデル振り分け表」を機械で強制する。文章だけの規律は
failure-catalog の「D: 文章で禁止しても再発する操作ミス」に落ちるため。

判定対象は `command_segments` で割った各コマンドのうち、`aimix run` かつ実効 mode が
`implement` / `refactor` のもの。mode 省略時は aimix と同じ `consult` なので、`consult` /
`review` / `debate` と `aimix` 以外は素通りする。

#### フラグ解釈

1 セグメントを左から右へ 1 回走査し、長オプションの名前解決は aimix 本体の argparse
(`allow_abbrev=True`) と同じ「完全一致、無ければ一意な前方一致」にする。

- `--flag value` と `--flag=value` の両形式を受け、同じオプションが複数あれば後勝ち。
- 名前は完全一致を優先し、完全一致が無ければ既知オプションの一意な前方一致を受ける。
  例えば `--co` / `--compl` / `--complexit` は `--complexity`、`--ca` は `--category`、
  `--cw` は `--cwd` になる。一方 `--memb` は `--member` / `--members`、`--mod` は
  `--mode` / `--model` のどちらにも一致して曖昧。aimix 本体はここで argparse エラーになり実行
  されないが、hook はそのトークンだけを無視して走査自体を続ける。hook の素朴な分割が
  引数文字列内の断片をオプションと誤認しても、後続の正規フラグまで判定放棄しないためである。
  未知の長オプションも同様に、そのトークンだけを無視する。
- 値を取るオプションの `=` 無し形式は次トークンを値として消費する。ただし次が `-` で始まる
  2 文字以上のトークンなら、argparse と同じく値とはみなさず消費しない (空白を含む語は argparse
  でも位置引数扱いなので値として消費する。`--task "--member cursor"` 等)。
- 対象オプションは、値ありの `--mode --member --members --category --model --complexity
  --task --task-file --diff-file --rounds --cwd --run-dir` と、値なしの `--git-diff --qa --json
  --no-log --brief --help`。短い `-h` は規則 6 の判定材料にしない。
- `--complexity` 省略時は aimix の既定どおり `med`。明示値が `low` / `med` / `high` 以外なら
  aimix 自身が argparse エラーで実行しないため、hook は素通りする。
- member は、空でない `--member` があればそれを使う。そうでなければ `--members` を `,` で
  分割し、引用符を除いて前後空白を落とした先頭の空でない要素を使う。後者では aimix が
  `--model` を無視して各 member の tier 既定モデルを使い、implement は先頭 member だけを
  実行するため、候補のあるセルでは `--members` の呼び出しを deny する。

- **セルを引けたときは空でない `--member` と `--model` が必須**。member 不明なら、
  `--member` が無い経路では aimix が `--model` を無視して registry 等から自動選択する旨を示して
  deny する。`--members` 由来なら上記の tier 既定モデルになる旨を示して deny する。`--model` が
  無ければ従来どおり deny する。どの候補を使ったのかが
  記録に残らないため。**逆に言うと、`models` 表を宣言していないプロジェクトでは
  member / `--model` 無しや `--members` でも通る** — 照合が必ず fail-open になる場所で deny だけ発火させると、
  deny 文が案内する `route.sh` は無出力なので従いようがなく、摩擦だけが残るため。
- **判定は「そのセルの候補配列に `<member>:<model>` が含まれるか」だけで行う。**
  vendor 名 (`codex` / `cursor` / `claude`) で弾く実装にしてはならない — セルの正当な
  2 番手である `cursor:...` が道連れになる。
- 候補の抽出は **`scripts/route.sh` に一本化**する。jq / python3 の抽出ロジックをこの
  hook 側へコピーしない (二重実装は片方だけ直って静かにズレる)。`hooks/` の隣が
  `scripts/` という関係は正本 (`harness/packs/bdboard-harness/`) でも注入コピー
  (`.claude/skills/bdboard-harness/`) でも同じなので、`$0` からの相対で解決している。

**この規則の位置は `hooks.denyBashPatterns` の読み出しより前**でなければならない。規則 5 の
後ろに置くと、その直前の「パターンが 1 件も無ければ `exit 0`」に食われて、
`denyBashPatterns` を持たない契約では規則 6 が丸ごと死ぬ。

#### fail-open する条件

deny してよいのは「セルの候補を実際に取れて、明示指定が上の契約を満たさなかった」ときと、
「宣言されているセルが `models.exclude` で候補 0 件になっていて、解決した member が除外中だった」
とき (`route.sh --excluded` で判定。bdboard-p5l.22) だけ。次はすべて素通り:

- `scripts/route.sh` が読めない。
- `route.sh` が非 0 で終わる — 契約の JSON が不正 (exit 1)、jq も python3 も無い (exit 127)。
- `route.sh` の出力が空 — 契約に `models` 節が無い / その工程が無い / そのセルが無い。
- 除外で候補 0 件になったセルで、member が不明、または解決した member が除外中ではない
  (空セルを全面
  deny にすると、枠逼迫の退避がそのセルの委譲の全停止になるため)。`route.sh --excluded`
  が非 0 で終わったときも判定しない。
- `--complexity` を明示したが `low` / `med` / `high` でない (大文字小文字は区別する。
  `--complexity LOW` は素通りする)。**`--complexity` 省略は aimix の既定 `med` として判定する。**
  これは aimix が実際に使うセルで照合するだけで、チケットの `bdboard.complexity` 未記録を deny
  にするかは引き続き Phase 2 (bdboard-p5l.19) の話。

member / `--model` の必須チェックも**この fail-open の後ろ**にある。順序は
1 回のフラグ走査 → mode ゲート → エスケープハッチ → complexity の choices 確認 →
member 解決 → `route.sh` → (候補が空なら、member が分かる場合だけ `route.sh --excluded` で
除外中 member の照合) → member 不明 → `--members` 由来 → `--model` 必須 → セル所属照合。

#### エスケープハッチ

`BDBOARD_ROUTE_OVERRIDE=<理由>` があれば通す。hook 自身の環境変数でも、コマンド先頭の
インライン代入 (`BDBOARD_ROUTE_OVERRIDE="枠逼迫" aimix run ...`。クォートは `"` / `'` /
無しのいずれでも可) でもよい。**理由が空 (`BDBOARD_ROUTE_OVERRIDE=` / `=""` / `=''`) は
通らない** — 「理由を書かせる」ことがこのハッチの目的なので。

インライン代入は **`aimix` より前のプレフィックスだけ**を見る。セグメント全体の部分一致に
すると `--task "... BDBOARD_ROUTE_OVERRIDE=x ..."` のように引数の中身でゲートが外れる。
しかも**上の deny 文言自身がこの文字列を含む**ので、deny 文やこの README を委譲ブリーフへ
貼って再試行するだけで無効化できてしまう。

インライン代入のほうが実務では望ましい。理由がそのままコマンド列としてトランスクリプトに
残り、後から「なぜ表を外れたか」を追えるため。

#### 限界

- **Bash hook は Agent ツールの `model:` を見られない。** したがって規則 6 が守れるのは
  Bash 経由の `aimix run` だけで、`claude:*` を Agent ツールで直接呼ぶ経路は素通りする。
  これは既知の穴であり、埋めるかどうかは Phase 2 (bdboard-p5l.19) の観測結果で判断する。
- 現在の `aimix run --mode` は `consult` / `review` / `debate` / `implement` のみで、
  **`refactor` は存在しない**。将来 (または別経路) のために先回りしてゲートしてある。
- 規則 6 だけは、判定前に**行継続 (`\` + 改行) を畳む**。規則 1〜5 が単一トークン照合なのに
  対し、規則 6 は複数のフラグが 1 セグメントに揃っていることを前提にするため。畳まないと、
  `agents/*.md` が文書化している複数行の呼び出し形で「`--model` が別行 → 誤 deny」
  「`--complexity` が別行 → 照合を素通り」の両方が起きる。畳むのは規則 6 用の分割だけで、
  規則 1〜5 の判定は従来どおり。
- その後のトークン化は shell parser ではない。`set -f` で空白分割したあと、開いた引用符
  (`"` / `'`) が閉じるまで断片をつなぎ直し、引用符文字を取り除いて 1 語にする。これで
  `--task "x --comp y"` の中身をフラグと読まない・`"--complexity" high` をオプションとして
  読む・`--members " cursor"` の先頭 member を読む、の 3 点がシェル (= aimix が受け取る引数) と
  揃う。バックスラッシュエスケープ・`$()`・変数展開は扱わない近似で、引用符の中の `;` `&` `|`
  はその前段のコマンド分割で割れてしまう。曖昧・未知な断片で走査を中断しないのは、この近似で
  拾った断片によって後続の正規フラグまで判定放棄させないため。
- 規則 1〜5 と同じく、判定はコマンド文字列への照合なので「そのコマンドを実行する意図」と
  「そのコマンドについて書いているだけの文字列」を区別しない。`aimix run --mode implement
  --model ...` を例示として heredoc やテストフィクスチャに書くと deny されうる。実測例:
  規則 1 の禁止事項リストをそのまま heredoc に書き写した委譲ブリーフが、規則 1 自身に
  弾かれた (2026-09-05)。回避はプレースホルダで書いてから別プロセスで置換する。

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
| 2 | パスが `/.beads/` を含み、かつ現在ブランチが `bd/` で始まる | `.beads/` は PR に含めない。台帳の変更は bd コマンド経由で行う（ファイルを直接編集・コミットしない） |

ブランチは「そのパスの実在する最も近い祖先ディレクトリ」に対する
`git rev-parse --abbrev-ref HEAD` で見る (detached HEAD のときは `symbolic-ref` で再試行)。
git が無い・パスが取れない・ブランチが判らない場合は allow。

## stop-ticket-gate.sh — Stop (matcher なし)

「チケットに何も残さずセッションを終える」を差し戻す。

1. `stop_hook_active` が true なら通過 (無限ループ防止)。
2. チケット ID: ブランチが `bd/<id>` ならその `<id>`。そうでなければ cwd の
   `.claude/worktrees/<name>` の `<name>` を候補にし、`bd -C <cwd> show <name> --json` が
   成功したら採用。どちらも駄目なら通過 (per-ticket worktree ではない)。
3. `bd -C <cwd> show <id> --json` の status が `in_progress` でなければ通過。
4. `bd -C <cwd> comments <id> --json` に `PR:` を含むコメントがある、または最新コメントが
   15 分以内なら通過 (痕跡は残っている)。
5. それ以外で `git status --porcelain` が非空、または `origin/<mainBranch>..HEAD` に
   未 push コミットがあれば **exit 2** で差し戻す。`mainBranch` は検証コントラクトの
   同名フィールド、無ければ `main`。`origin/<mainBranch>` が無ければこの条件は skip。
6. それ以外は通過。

`bd` が PATH に無い場合・JSON ツールが無い場合はいずれも通過する。`bd` はすべて
`-C <hook の cwd>` 付きで呼ぶ — Stop hook のプロセス cwd は Claude Code 側の都合で
決まり、対象 worktree とは限らないので、渡さないと別チェックアウトの `.beads/` を
読みかねない。

## pack.json の `hooks[]` 宣言 (P1b への契約)

各エントリは `event` / `matcher` / `script` / `timeout` を持つ。P1b (bdboard-pkr6.2) が
`.claude/settings.json` へ登録するときは、**この 4 つをそのまま書き写す**。

- **`timeout` は秒。契約値として `10` を宣言してある** — P1b は自分で決めずこの値を
  settings.json に書く。Claude Code の command hook の既定 timeout は 600 秒で、Stop
  イベントにはそれを短くする既定が無い。`bd` が刺さると 10 分セッションが止まりうるので、
  「fail-open のガードが原因で作業が止まる」ことのないよう明示的に縮める。
- **Stop エントリの `matcher` は Claude Code 側が無視する**。空文字は「matcher 無し」の
  意味で置いてあるだけなので、**P1b は settings.json に `matcher` キーを書かない**
  (PreToolUse の 2 本は書く)。

## 手で試す

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"pkill -f tsx"}}' \
  | bash harness/packs/bdboard-harness/hooks/pre-bash-guard.sh; echo $?   # => 2

echo '{"tool_name":"Bash","tool_input":{"command":"bd dolt push --remote backup"}}' \
  | bash harness/packs/bdboard-harness/hooks/pre-bash-guard.sh; echo $?   # => 0
```

自動テストは `src/infrastructure/harness/pack-hooks.test.ts` (bash で spawn して stdin に
JSON を流す統合テスト。Windows では skip)。
