# bdboard-harness hooks

failure-catalog の「D: 文章で禁止しても再発する操作ミス」を、文章ではなく Claude Code
の hook で機械的に止めるスクリプト群 (bdboard-pkr6.1 / docs/HARNESS-EVALUATION.md
§2.3・§5 P1)。`.claude/settings.json` への登録は注入 API 側が行う (bdboard-pkr6.2)。

## 共通の約束

- **deny は exit 2**、stderr に「何を止めたか / なぜ / 代わりに何をするか」を 3 行以内。
- **allow は exit 0 で無出力**。例外は警告専用の `worktree-freshness.sh` で、止めることは
  無く常に exit 0、警告があるときだけ stdout に JSON を出す (後述)。
- **判定不能はすべて allow (fail-open)**。`set -e` は使わない。hook が壊れて作業が
  止まるより、従来どおり文章ルールへ戻るほうが安全という判断。
- 入力は stdin の Claude Code hook JSON。抽出は `jq` → `python3` の順に使い、必要な
  フィールドは 1 回の呼び出しでまとめて取り出す (US=0x1f 区切り。TAB も改行もコマンド
  文字列やパスに普通に含まれるので区切りには使えず、TAB は IFS 空白扱いで空フィールド
  も消える)。
- **どちらの JSON ツールも無い環境では、4 本とも何も判定せず exit 0 で通す
  (fail-open)**。stderr は警告 1 行だけ
  `bdboard-harness hook: jq/python3 not found; skipping all checks (fail-open)`。
  生の JSON 文字列へ正規表現/部分一致を当てる縮退判定はしない — `git stash list` の
  ような無害なコマンドが JSON 全体との一致で deny されるうえ、案内も長くなるため。
- 依存は bash (3.2 互換) / coreutils / git / bd と、任意で jq・python3 のみ。**node に
  依存しない** (注入先が npm プロジェクトとは限らない)。
- 実行ビットは注入時に付ける。手で叩くときは `bash <script>` で呼ぶ。
- `lib-main-checkout.sh` は hook 本体ではなく共有ライブラリ (単独では実行しない、
  `.claude/settings.json` にも登録しない)。「このディレクトリの属する checkout が main
  checkout (per-ticket worktree の親) か」を `server-guard.sh` (規則 8) と
  `pre-edit-guard.sh` (規則 2) の両方から `.` で読み込み、判定ロジックを一本化する
  (bdboard-kxqb)。

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
| 7 | 検証コントラクトに `alwaysOnServer.port` があるとき (本体は `server-guard.sh`): **7a** サブエージェント (hook 入力に `agent_id` がある) から main checkout での `git pull` / **7b** 同じくサーバー起動 (`npm run start`・`tsx src/main.ts`) と `alwaysOnServer.restartScript` の実行 (cwd 不問) / **7c** 呼び出し元を問わず listener PID (とその親 npm/node) の直接 `kill`、`$(lsof … <port> …)` や同一コマンド内の変数・パイプ経由で port から引いた PID の kill | 再起動は議長が `BDBOARD_SERVER_CALLER=chair <restartScript> restart --expect-pid <PID>`。サブエージェントは最終報告に「議長で再起動が必要」と書く。議長が手で止めるなら `BDBOARD_SERVER_OVERRIDE="<理由>"` を前置 |
| 8 | `alwaysOnServer.port` の有無に関係なく有効 (本体は `server-guard.sh`)。サブエージェントが main checkout を対象に `git checkout` / `switch` / `commit` / `reset` / `merge` / `rebase` / `stash` / `restore` / `cherry-pick` / `revert` / `am` を実行する (`pull` は含まない。既存の 7a がその役目を持つので二重化しない — 下記「8 の main checkout 保護」参照) | worktree で作業する: `cd <worktree> && git <cmd> ...` か `git -C <worktree> <cmd> ...`。無ければ `git -C <main> worktree add .claude/worktrees/<id> -b bd/<id> origin/main` |
| 9 | 本体は `worktree-owner-guard.sh` (bdboard-gsnn)。持ち主でないサブエージェントが per-ticket worktree (`bd/<id>` ブランチが存在する `.claude/worktrees/<id>` のみ対象。chair 作成やisolation:"worktree"用のスクラッチworktreeは対象外) を対象に公開/マージ系操作をする。詳細は下記「9 の worktree 所有権保護」 | 自分の worktree で作業する。持ち主が動けないなら議長に `bash .claude/skills/bdboard-harness/scripts/worktree-owner.sh release <id>` を頼む |

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
「宣言されているセルが `models.exclude` で候補 0 件になっていて、member が不明か、解決した
member が除外中だった」とき (`route.sh --excluded` で判定。bdboard-p5l.22 / bdboard-uaqe) だけ。
member 不明を止めるのは、`--member` 無しだと aimix がレジストリの既定から除外中の member を
選びうるため。次はすべて素通り:

- `scripts/route.sh` が読めない。
- `route.sh` が非 0 で終わる — 契約の JSON が不正 (exit 1)、jq も python3 も無い (exit 127)。
- `route.sh` の出力が空 — 契約に `models` 節が無い / その工程が無い / そのセルが無い。
- 除外で候補 0 件になったセルで、解決した member が除外中ではない (空セルを全面
  deny にすると、枠逼迫の退避がそのセルの委譲の全停止になるため。名指しすれば通る)。
  `route.sh --excluded` が非 0 で終わったときも判定しない。
- セグメントが引用符の途中で割れていて (後述の「限界」)、割れ目より前に member
  (`--member` / `--members`) と `--complexity` の両方が明示されていない。割れ目の後ろの
  フラグは見えないので、既定値 (member 不明 / `med`) を実効値とみなすと誤判定になる。
- `--complexity` を明示したが `low` / `med` / `high` でない (大文字小文字は区別する。
  `--complexity LOW` は素通りする)。**`--complexity` 省略は aimix の既定 `med` として判定する。**
  これは aimix が実際に使うセルで照合するだけで、チケットの `bdboard.complexity` 未記録を deny
  にするかは引き続き Phase 2 (bdboard-p5l.19) の話。

member / `--model` の必須チェックも**この fail-open の後ろ**にある。順序は
1 回のフラグ走査 (最初の `aimix run` 以降だけ) → mode ゲート → エスケープハッチ →
complexity の choices 確認 → member 解決 → (セグメントが割れていれば、member と
`--complexity` の明示を確認) → `route.sh` → (候補が空なら `route.sh --excluded` で、除外で
空になったセルなら member 不明と除外中 member を deny) → member 不明 → `--members` 由来 →
`--model` 必須 → セル所属照合。

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
  改行はその前段のコマンド分割で割れてしまう。割れたセグメント (閉じない引用符が残る) は
  割れ目より後ろのフラグが見えないので、割れ目より前に member と `--complexity` が明示されて
  いるときだけ判定し、それ以外は素通りする (既定値で照合すると誤 deny・誤照合になるため)。
  走査対象はセグメント内の最初の `aimix run` 以降だけで、前置部で引用符が開いたまま
  (`bash -c "aimix run ..."` / `"$(aimix run ...)"`) なら閉じる引用符の手前までを aimix の
  引数とみなす。前置部 (ラッパーコマンド) の `--xxx` は読まない。曖昧・未知な断片で走査を中断しないのは、この近似で
  拾った断片によって後続の正規フラグまで判定放棄させないため。
- 規則 1〜5 と同じく、判定はコマンド文字列への照合なので「そのコマンドを実行する意図」と
  「そのコマンドについて書いているだけの文字列」を区別しない。`aimix run --mode implement
  --model ...` を例示として heredoc やテストフィクスチャに書くと deny されうる。実測例:
  規則 1 の禁止事項リストをそのまま heredoc に書き写した委譲ブリーフが、規則 1 自身に
  弾かれた (2026-09-05)。回避はプレースホルダで書いてから別プロセスで置換する。

### 7 の常時稼働サーバー保護 (bdboard-hpu8)

2026-09-20 に 3 件連続で「PR をマージしたサブエージェントが、CLAUDE.md の後片付け手順
(掃除 → 常時稼働サーバー再起動) どおりに main checkout を `git pull` し、8787 の listener を
`kill` して `npm run start` し直す」事故が起きた。手順は文章としては正しく、サブエージェントは
正しく従っただけで、**誰が実行してよいか**が文章でしか区別されていなかった。委譲ブリーフの
禁止文言だけが歯止めで、failure-catalog の「D: 文章で禁止しても再発する操作ミス」そのもの。

本体は `hooks/server-guard.sh` で、`pre-bash-guard.sh` の規則 6 の直後から `.` で読み込む
(`pre-bash-guard.sh` の行数上限を守るための分離。無ければ素通り)。**契約に
`alwaysOnServer.port` が無い注入先では何もしない。**

```json
{ "alwaysOnServer": { "port": 8787, "restartScript": "scripts/always-on-server.sh" } }
```

- **呼び出し元の区別**は hook 入力 JSON の `agent_id` (Claude Code がサブエージェント内で
  hook を発火させたときだけ付ける) の有無。環境変数には何も出ないので、これが唯一の手掛かり。
  空ならトップレベル (議長) からの呼び出し。
- **main checkout** は `git -C <cwd> rev-parse --git-common-dir` の親。worktree からでも同じ
  場所に解決する。「そのディレクトリが main checkout か」は前方一致ではなく
  `git -C <dir> rev-parse --show-toplevel` が main と一致するかで見る (worktree は main の下
  `.claude/worktrees/` に置かれるため)。
- **実効ディレクトリ**は cwd から始めて、コマンド列を `;` `&&` `||` `&` 改行で割った各
  セグメントの `cd` / `pushd` / `popd` を静的に追う (`(` … `)` のサブシェルは閉じで巻き戻す)。
  `git -C <dir>` / `npm --prefix <dir>` の明示も見る。同一コマンド内の `NAME=値` 代入は
  `$NAME` / `${NAME}` として展開する。`BDBOARD_PORT=<別ポート>` を前置した `npm run start`
  は常時稼働サーバーではない (worktree の一時サーバー) ので 7b の対象外。
- **7c の PID** は kill を含むセグメントを見つけたときだけ
  `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` (無ければ `ss`) で引き、その親を 3 段まで
  (`node` / `npm` / `sh` 系なら) 加える — `npm run start` → `node (tsx)` → listener の鎖の
  どこを kill しても同じ結果になるため。`kill -0` / `kill -l` は判定しない。
- **エスケープハッチ** `BDBOARD_SERVER_OVERRIDE=<理由>` はコマンド先頭の前置きだけを見て、
  **議長のときだけ**効く (サブエージェントには効かない)。
- deny のたびに `${TMPDIR:-/tmp}/bdboard-server-guard.log` へ 1 行 (時刻 / 規則 / agent /
  cwd / コマンド先頭 300 文字) を残す。stderr 3 行では「誰が何を止められたか」を後から
  追えないため。
- 再起動スクリプト側 (`alwaysOnServer.restartScript`) は `BDBOARD_SERVER_CALLER=chair` の
  宣言を要求し、`--expect-pid` で「いまの listener がその PID のときだけ」kill する (CAS)。
  スクリプトの中の kill/pull/start は hook には見えないので、議長のスクリプト実行は通る。

#### 限界

- 別ファイルにコマンドを書いてから実行する迂回 (`bash /tmp/x.sh`) は見えない。hook は
  「観測された事故の形 (インラインで pull → kill → start)」を止めるガードで、サンドボックス
  ではない。
- `preview_start` (MCP ツール) は Bash ではないのでこの hook の対象外。worktree からの
  `preview_start` 禁止は引き続き文章の規律 (failure-catalog `worktree-preview-start`)。
- 変数展開は同一コマンド内の単純代入だけ。`$MAIN` が別のコマンドで設定されていれば
  解決できず fail-open。`agent_id` の有無は Claude Code の hook 入力仕様に依る
  (2.1.x で確認)。無い版では 7a/7b は発火せず、7c だけが効く。
- `pgrep -f … | xargs kill` のように port を含まないパターン kill は 7c では止めない
  (規則 1 の pkill/killall 禁止と同じ精神だが、worktree の一時サーバーを狙う正当な用途と
  区別できないため)。

### 8 の main checkout 保護 (bdboard-kxqb)

2026-09-25 に議長を main checkout (worktree ではなくリポジトリ本体) で動かす運用に
切り替えた。そうするとサブエージェントも main checkout を cwd として起動しうる。既存の規則 7 が
サブエージェントに禁じていたのは main checkout での `git pull`・サーバー起動・listener
kill だけで、`git checkout` / `switch` / `commit` / `reset` / `merge` / `stash` 等の
working tree/HEAD 変更と Edit・Write によるファイル編集は止めていなかった。2026-09-25 に
別チケット (bdboard-p5l.18) の担当が議長の worktree で自分のブランチへ `checkout`
した実例があり、main checkout で同じことが起きると常時稼働サーバーの配信元 checkout が
汚れ、デプロイの `git pull --ff-only` も失敗する。

main checkout の判定・実効ディレクトリの静的追跡は規則 7 と共有する
(`hooks/lib-main-checkout.sh` を `server-guard.sh` から `.` で読み込む。二重実装しない)。
規則 7 との違いは、`alwaysOnServer.port` の有無に関係なく常に有効なこと (main checkout の
working tree/HEAD を守ること自体は常時稼働サーバーの有無と独立の理由による) と、
サブエージェントだけを対象にすること (議長は対象外)。

**必ず allow する (誤検知させてはならない)** — 他セッションが依存する日常操作:

- `git -C <main> worktree add/remove/list`、`git branch -D bd/<id>`、
  `git push origin --delete bd/<id>`、`git remote prune origin`、`git fetch`
- 読み取り系全般 (`log` / `status` / `diff` / `show` / `rev-parse` 等)
- `cd <worktree> && git commit ...` / `git -C <worktree> checkout ...`
  (実効ディレクトリが worktree に解決されるため)
- commit メッセージ・`bd comment` 本文・`gh pr create --body` 引用符内に
  `git checkout` 等の文字列が現れるだけのもの (規則 6 と同じ引用符マスク
  `sg_mask_quoted_separators` を再利用し、先頭語だけで判定するので誤爆しない)
- `alwaysOnServer.port` を宣言していない契約下での、サブエージェントによる main checkout
  での `git pull` (下記「pull を対象外にした理由」)

**実際の判定境界 (正直な記述、opus レビューで訂正)**: `sg_check_main_git_mutate` は
「対象ディレクトリが main checkout だと確定できたとき」だけ deny する。逆に言うと、
**実効ディレクトリの解決自体が不確実な場合は deny ではなく allow (fail-open) になる** —
これは規則 7 からそのまま引き継いだ既存の制約で、`cd` の静的追跡・同一コマンド内
`NAME=値` 代入の展開の範囲を超えるもの (別ファイルに書いて実行する迂回 `bash /tmp/x.sh`、
別コマンドで設定した変数の参照、`git -C "$(pwd)"` のような未解決の `-C` 引数、
`GIT_DIR`/`GIT_WORK_TREE` 環境変数、絶対パス `git` 呼び出し、パイプ・`if`/`for` 等の
制御構文の後段に置かれた `git`) はどれも解決できず allow に倒れる (下記「限界」)。
当初の設計意図は「main checkout かつ変更系サブコマンドと判定できるが確信が持てない
ケースは deny に倒す」だったが、実装は規則 7 の実効ディレクトリ解決エンジンをそのまま
再利用しており (二重実装しない方針、上記)、そのエンジン自体を deny 優先の新しい
判定ロジックへ作り替えることはこのチケットのスコープ外とした — 規則 7 は既にレビュー
済みで他セッションが依存する挙動のため、十分なテスト無しに判定方針を変えるとむしろ
誤検知の新規リスクを増やすと判断したため。残存する具体的なすり抜けパターンは
「限界」に列挙する。

#### pull を対象外にした理由

`git pull` は working tree/HEAD を変えるので性質上は他の 16 個と同列だが、規則 8 の
サブコマンド一覧には**含めていない**。既存の 7a が「サブエージェントから main checkout
での `git pull`」を `alwaysOnServer.port` があるときに deny 済みで、規則 8 の役割は
「7 が元から対象にしていなかった working tree/HEAD 変更系を追加で塞ぐ」ことだけだからで、
7a と重ねて判定すると deny 経路が二重になり保守面が増えるだけで得るものがない。
`alwaysOnServer.port` を宣言していない契約 (bdboard 自身の契約には常にある) では
サブエージェントの main checkout での `pull` は従来どおり fail-open のまま — これは
規則 8 が新規に緩めたのではなく、7a の既存スコープをそのまま維持しているだけである。

#### 限界

規則 7 の「限界」節と同じ (`hooks/lib-main-checkout.sh` を共有するため)。加えて:

- 対象は列挙した 16 個の git サブコマンドのみ。`git log --format=... > FETCH_HEAD` の
  ような迂回や、git 以外のコマンドで working tree を書き換える経路 (`tar` 展開・`sed -i`・
  `cp`/`mv`/`rm`/`tee` 等) は対象外 (Bash hook 全体が対象とするのは「git/npm/再起動
  スクリプトのサブコマンド認識」であって、任意のファイル書き換えコマンドの追跡ではない)。
- 実効ディレクトリの解決を欺ける具体的な形が opus レビュー (2026-09-25) で複数実測された。
  いずれも規則 7 から引き継いだ既存の制約の範囲内 (新規の後退ではない): `git` がセグメント
  先頭語ではない形 (`echo x | git commit`、`if git checkout other; then …`、
  `nice git checkout other`)、絶対パス/バックスラッシュ経由の `git` 呼び出し
  (`/usr/bin/git checkout` 、`\git checkout`)、`-C` 引数が `$(pwd)` や別コマンドで設定した
  変数など静的に解決できない形、`GIT_DIR`/`GIT_WORK_TREE` 環境変数、`cd -` (直前の
  `SG_PREV_DIR` を巻き戻す前に上書きしてしまう)、末尾に空白を持つサブシェル閉じ
  `... ) &&` の一部の並び。これらは意図的な回避手段の構築を要し、通常の (不注意な)
  サブエージェント運用では起こりにくいと判断し、このチケットのスコープでは対応しない
  (follow-up 課題として個別に起票する)。
- 引用符マスク (`sg_mask_quoted_separators`) は bdboard-u4ne (2026-09-25, PR #775) 以降
  ヒアドキュメント本体 (`<<EOF ... EOF`) も専用の状態で追跡し、区間内の改行・`;`/`&`/`|` を
  無害化する (このファイル冒頭のコメント、および規則 7/8 が共有する)。`bd comment` /
  `gh pr create --body` / commit メッセージの本文を `$(cat <<'EOF' ... EOF)` のような
  ヒアドキュメントで渡しても、本体の行が `git checkout` のような語で始まるだけでは規則 8 は
  誤って main checkout 判定に巻き込まない (bdboard-kmh2/PR #767 時点の既知の制限は解消済み)。
- pre-edit-guard.sh の main checkout 保護 (下記) とは別実装 (Bash の引用符付きコマンド
  文字列と Edit/Write の `file_path` は形が違うため、判定の入口は共有できない)。
  main checkout 判定関数 (`bh_main_checkout` / `bh_dir_is_main`) 自体は共有する。
  Bash 経由の `sed -i` / `cp` / `tee` 等によるファイル書き換えは pre-edit-guard.sh の
  対象外でもある (Edit|Write|MultiEdit|NotebookEdit ツールだけを見る hook のため)。

### 9 の worktree 所有権保護 (bdboard-gsnn)

2026-09-25 に、main 破損の修復 PR #781 (bdboard-yv45) を進めていた worktree
`.claude/worktrees/bdboard-yv45` (bdboard-9pzt の担当が作成) へ、別チケット
(bdboard-rftd) の担当が「持ち主が死んでいる」と誤認して `cd` し、
`npm run merge-pr -- prepare 781` → `gate 781 --repair` を実行した (最後の
`gh pr merge` は Claude Code 自身の権限判定でたまたま拒否され実害は無かった)。
worktree-first 排他 (`git worktree add` の衝突) は worktree の二重作成は防ぐが、
作成後の worktree と作成したサブエージェントを結び付けておらず、`gate --repair`
の枠引き継ぎ (`scripts/merge-pr/gate.mjs` の `holderFor`、PRED_BASE の 12 桁 suffix
一致だけで誰の worktree からでも乗っ取れる) と組み合わさると、他人の修復を横取り
できてしまった。

**記録の置き場所**: main checkout (`git rev-parse --git-common-dir` の親) の
`.git/bdboard-worktree-owners/<ticket-id>` に、持ち主の `agent_id` を平文 1 行で
記録する。`.git/` 配下なので git 追跡されない。

**記録のタイミング (遅延クレーム)**: `git worktree add` の成功時点ではなく、下の
表にある操作のどれかを、あるチケットの worktree を実効ディレクトリとして最初に
実行しようとしたサブエージェントが、その場で自分の `agent_id` を記録して持ち主に
なる。記録が既にあれば、自分の `agent_id` と一致するときだけ通す。この方式を選んだ
理由:

- `git worktree add` の成功だけを捉えるには PostToolUse (`tool_response` の成功
  判定) が要り、実装・テストが PreToolUse 1 本より複雑になる。
- 「持ち主の記録が無い worktree (このガードより前に作られたもの) は最初に触った
  サブエージェントが持ち主になる」という要件も同じコードパスで自然に満たせる。
- 理論上、worktree 作成者が一度もこれらの操作をする前に**別の**サブエージェントが
  先に触れば、その別のサブエージェントが持ち主になってしまう狭い race がある。
  実際に報告されたインシデントでは、修復 PR の担当が他人に触られる前に必ず自分で
  `git commit`/`git push`/`npm run merge-pr` のいずれかを最初に行っているはずなので
  発生しないが、既知の限界として明記する。

**deny する操作 (対象は agent_id ありのサブエージェントが「他人の持ち物である
worktree」を実効ディレクトリ/対象として実行しようとしたときだけ。議長は常に対象外)**:

| 操作 | 判定 |
|---|---|
| `git push` | サブコマンドが `push` |
| `git commit` | サブコマンドが `commit` |
| `git worktree remove <path>` | `<path>` を解決した先が per-ticket worktree |
| `git branch -D bd/<id>` (`-D` 短縮形のみ。`--delete --force` は対象外) | 引数に `-D` と `bd/<id>` が両方 |
| `npm run merge-pr -- <prepare\|gate\|finish\|verify> ...` (`gate --repair` を含む) | `run merge-pr` |
| `gh pr merge <N>` | `pr merge` |
| 議長専用解除コマンド `scripts/worktree-owner.sh release <id>` をサブエージェントが実行 | `worktree-owner.sh` の直後のトークンが `release` |

**必ず allow する**: 読み取り・テスト実行・Edit/Write (これらの持ち主チェックは
このチケットのスコープ外)、自分の worktree での上の全操作、議長の全操作、
`worktree-owner.sh show`/`list`、上の表に無い git/npm/gh サブコマンド。

**解除**: 議長専用の `scripts/worktree-owner.sh release <id>` (`--main <path>`
省略可)。記録ファイルを削除するだけで、次にその worktree で上の操作を行った
サブエージェントが新しい持ち主になる (上の遅延クレームと同じコードパス)。
サブエージェントからの `release` 実行は worktree-owner-guard.sh が deny する。

**実効ディレクトリの解決はこのファイル専用の簡易版**: `cd`/`pushd`/`popd` と
`git -C`・`npm --prefix` の直接指定だけを追う。規則 7/8 (`server-guard.sh`) の
実効ディレクトリ解決エンジンは再利用しない。`NAME=値` 代入の展開・別ファイルへ
書いて実行する迂回・絶対パス/バックスラッシュ経由の `git` 呼び出しは追わない
(規則 7/8 と同種の既知の限界。見逃しは fail-open = このチケット以前と同じ)。

**引用符を考慮したセグメント分割 (`sg_mask_quoted_separators`) はあえて使わない**:
規則 9 が見るのはセグメントの先頭語 (`git`/`npm`/`gh`) と直後のサブコマンドだけなので、
引用符内の `;`/`&`/`|` を素朴な分割で余分なセグメントに割っても、本物の呼び出しの
先頭語が分断されることは通常の書き方では起きない。唯一の副作用は「引用符の中に
たまたま `git commit` 等の並びがあると誤検知で deny 側に倒れる」ことだけで、これは
規則 6 (bdboard-wa48) と同じ「言及しただけで deny」方針・「見逃しより誤検知」原則と
整合する。既にレビュー済みで他セッションが依存する規則 7/8 のコード
(`server-guard.sh`) へ、この機能のために手を入れるリスクの方が大きいと判断し、
`server-guard.sh` は一切変更していない。

**agent_id について確認したこと**: Claude Code の hook 入力の `agent_id` は
サブエージェント内で発火した hook にだけ付与され、トップレベル (議長) の呼び出しでは
付与されない (既存の規則 7/8/pre-edit-guard.sh 規則 2 が同じ前提で `AGENT_ID` を
使っており、このチケットで新規に採用した前提ではない)。同一サブエージェントが
`SendMessage` で再開されても値が変わらないかは、ドキュメント/実測のどちらでも
確定できなかった — 変わらない前提でこの設計は動くが、変わる場合は「持ち主が
急に他人に見える」形の誤検知 (fail-safe な方向) になるだけで、すり抜け方向の
悪化にはならない。PR 本文に明記する。

**既知の限界**:

- `aimix` 経由で起動される Codex/Cursor の子プロセスは Claude Code の hook を
  通らない (bdboard-1zrs と同じ限界)。Codex/Cursor 自身が `git push`/`git commit`
  等を直接実行する運用ではこのガードは効かない。
- Edit/Write の持ち主チェックはこのチケットのスコープ外 (レビュー用の子エージェントが
  親の worktree で mutation 確認の一時編集をする既存フローを妨げないため)。
- 遅延クレームの狭い race (上記)。
- 実効ディレクトリ解決の限界 (上記)。
- `git branch -D` は短縮形のみ対応。

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
| 2 | hook 入力に `agent_id` があり (サブエージェント)、対象パスの実在する最も近い祖先ディレクトリが main checkout (worktree ではない) 配下 | worktree で作業する: `git -C <main> worktree add .claude/worktrees/<id> -b bd/<id> origin/main` を作り、その worktree 内のパスを指定する |
| 3 | パスが `/.beads/` を含み、かつ現在ブランチが `bd/` で始まる | `.beads/` は PR に含めない。台帳の変更は bd コマンド経由で行う（ファイルを直接編集・コミットしない） |

ブランチ (規則 3) は「そのパスの実在する最も近い祖先ディレクトリ」に対する
`git rev-parse --abbrev-ref HEAD` で見る (detached HEAD のときは `symbolic-ref` で再試行)。
git が無い・パスが取れない・ブランチが判らない場合は allow。

規則 2 の main checkout 判定は `server-guard.sh` の規則 8 と同じ `hooks/lib-main-checkout.sh`
(`bh_main_checkout` / `bh_dir_is_main`) を共有する (main checkout 判定ロジックの二重実装を
避けるため。bdboard-kxqb)。議長 (`agent_id` なし) は対象外。`.claude/worktrees/<id>/...`
配下は、そのディレクトリ自身の `git rev-parse --show-toplevel` が main とは異なる worktree
自身に解決するため、特別扱いせずに自然と除外される — 逆に main checkout の中に手で作った
`.claude/worktrees/` 配下の非 worktree ディレクトリ (登録されていない普通のフォルダ) は
toplevel が main のままなので deny される。ABSOLUTE_PATH が (Write での新規作成などで) まだ
存在しない場合は、実在する親ディレクトリまで遡って判定する。git が無い・main checkout を
解決できない場合は allow (fail-open)。**既知の限界 (opus レビュー 2026-09-25)**:
main checkout の `.git/` 配下 (`.git/config`・`.git/hooks/*` 等、全 worktree で共有される
ファイル群) への Edit/Write は対象外 — `git rev-parse --show-toplevel` は `.git/` 内部では
失敗するため main checkout 判定自体が成立せず allow に倒れる。follow-up 課題とする。

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
   `<mainBranch>` へ未取り込みのコミットがあれば **exit 2** で差し戻す (push 済みでも
   `<mainBranch>` へマージされるまではカウントされ続けるため、「未 push」ではなく
   「`<mainBranch>` 未取り込み」と数えている — bdboard-pkr6.25)。`mainBranch` は
   検証コントラクトの同名フィールド、無ければ `main`。`origin/<mainBranch>` が
   無ければこの条件は skip。
6. それ以外は通過。

`bd` が PATH に無い場合・JSON ツールが無い場合はいずれも通過する。`bd` はすべて
`-C <hook の cwd>` 付きで呼ぶ — Stop hook のプロセス cwd は Claude Code 側の都合で
決まり、対象 worktree とは限らないので、渡さないと別チェックアウトの `.beads/` を
読みかねない。

## worktree-freshness.sh — SessionStart / UserPromptSubmit / PostToolUse (matcher: `Agent|Task`)

「hook の読み込み元の checkout が既定ブランチから取り残されている」をセッション自身に知らせる
(bdboard-flpp)。**警告だけで、自動の checkout / merge はしない** (作業中の変更を壊しうるため)。
常に exit 0。

### なぜ要るか

hook の登録 (`.claude/settings.json`) も本体 (この `hooks/` や `scripts/*.mjs`) も、セッションを
起動した checkout (`$CLAUDE_PROJECT_DIR`) から読まれる。Agent ツールで起動したサブエージェントの
hook も**親と同じ** `$CLAUDE_PROJECT_DIR` から読まれる。何日も動く議長セッションの checkout は
誰も更新しないので、main に入った hook の追加・修正が議長にも、議長が起動した全サブエージェントにも
届かない。2026-09 には議長の worktree が公開前の旧履歴のまま 1 か月以上動き、規則 7 (#645) が
一度も効いていなかった。ボードの Hygiene (`nonTicketHarnessWorktrees`) は外から同じ遅れを
出していたが、セッション自身には届いていなかった。

### 判定 (すべてローカルの ref だけで行う。fetch しない)

見る checkout は `$CLAUDE_PROJECT_DIR` (未設定なら hook 入力の `cwd`) の toplevel。cwd では
ない — 議長が別 worktree へ `cd` しても hook の読み込み元は変わらないため。既定ブランチは
検証コントラクトの `mainBranch` (無ければ `main`)、比較先は `origin/<mainBranch>`。

| 状態 | 条件 | 案内 |
|---|---|---|
| 共通祖先なし | `git merge-base HEAD origin/<main>` が空 (shallow clone は除く) | merge / rebase では追いつけない。退避して新しい worktree を作り、そこでセッションを起動し直す |
| hook が古い | `HEAD..origin/<main>` のうち `.claude/settings.json`・`.claude/bdboard-harness.json`・`.claude/skills/*/hooks/**`・`.claude/skills/*/scripts/**`・settings が参照する本体を触ったコミットが **1 件以上** | 下の追従コマンド |
| ハーネスが古い | 同じく `.claude` / `harness` を触ったコミットが **3 件以上** (ボードの閾値と同じ) | 同上 |
| 本体欠落 | `settings.json` / `settings.local.json` が `$CLAUDE_PROJECT_DIR/…`・`${CLAUDE_PROJECT_DIR}/…`・`${CLAUDE_PROJECT_DIR:-.}/…` で参照するファイルが無い (登録コマンドの `[ -f "$0" ] \|\| exit 0` で無言のまま何もしない) | 追従するか再注入 |

数えるのは `HEAD..origin/<main>` (既定ブランチ側にだけあるコミット) なので、自分のブランチで
hook を直している PR worktree は自分のコミットでは警告されない。

追従コマンドは条件を満たすときだけ出す (いずれも `git -C '<checkout>'` 形。議長の cwd が別の
場所でも正しい checkout に当たるように。パスは空白を含みうるので単引用で包む):

- main checkout で、契約に `alwaysOnServer.restartScript` がある → コマンドは出さず、
  議長がその再起動スクリプトで更新するよう案内 (build と常時稼働サーバーの再起動を迂回させない)。
- HEAD が detached、または merge / rebase / cherry-pick / revert / bisect の途中 → コマンドを出さない
  (merge-pr の prepare が PR worktree を detach して verify している最中などに HEAD を動かさない)。
- 追跡ファイルに未コミットの変更がある → 「ユーザーに確認のうえ、コミットしてから
  `git merge origin/<main>`」。
- 独自のコミットが無い (HEAD が merge-base) → `git merge --ff-only origin/<main>`。
- 独自のコミットがある → 「ユーザーに確認のうえ `git merge origin/<main>`」(rebase は案内しない)。
  案内を読んだ議長がそのまま実行しうるので、merge コミットを作る案内には確認を添える。
- `HEAD..origin/<main>` に `package-lock.json` を触ったコミットがある → 追従後の `npm install` を添える。
- `HEAD..origin/<main>` に `.claude/settings.json` を触ったコミットがある → 「追従後に `/hooks`
  で新しい hook が載っているか確認し、載っていなければセッションを起動し直す」を添える
  (本体は毎回読み直されるが、登録の変更がいつ反映されるかは Claude Code 側の版に依存するため)。

### 出力と抑制

- stdout に JSON 1 行: `systemMessage` (ユーザーに見える 1 文) と
  `hookSpecificOutput.additionalContext` (Claude への文脈。`hookEventName` は入力の
  `hook_event_name`)。PostToolUse は plain text を文脈に入れないので JSON に揃えている。
- **サブエージェント (`agent_id` あり) では何も出さない** — 直せるのは議長だけで、
  サブエージェントに議長の checkout を触らせないため。
- SessionStart (startup / resume / clear / compact) は毎回出す。UserPromptSubmit と
  PostToolUse(Agent) は「HEAD / origin の先端」が同じなら 60 分に 1 回だけ。この打ち切りは
  遅れの計算より前に行い、既定ブランチの先端が HEAD の祖先なら遅れの計算自体を省く
  (毎プロンプト走るため)。
  状態ファイルは `${TMPDIR:-/tmp}/bdboard-harness-freshness/<checkout のハッシュ>-<session_id>`
  (checkout の中に置くと `git status` を汚し、Stop ゲートの dirty 判定に響くため)。
- PostToolUse(Agent) は、ユーザー入力が来ないまま委譲を回し続ける自律ループの議長にも
  届かせるため。全 Bash 呼び出しに足すより頻度が桁違いに低い。
- 差し戻し (exit 2) はしない。UserPromptSubmit の exit 2 はユーザーの入力を消してしまう。

### 限界

- **この hook 自身が登録されていない古い checkout では効かない** (鶏と卵)。最初の 1 回の
  追従は、ボードの Hygiene (`nonTicketHarnessWorktrees` / チケット worktree の遅れ警告) と
  議長のマージ後手順 (docs/GIT-WORKFLOW.md) で拾う。
- `origin/<main>` を fetch しないので、誰も fetch しない環境では「最新」と誤認しうる。文脈に
  `origin/<main>` の先端のコミット日時を添えている。
- 閾値は 1 / 3 の固定値。`.claude/bdboard-packs.json` の `injectedAt` だけの更新もハーネスの
  コミットとして数える。

## pack.json の `hooks[]` 宣言 (P1b への契約)

各エントリは `event` / `matcher` / `script` / `timeout` を持つ。P1b (bdboard-pkr6.2) が
`.claude/settings.json` へ登録するときは、**この 4 つをそのまま書き写す**。

- **`timeout` は秒。契約値として `10` を宣言してある** — P1b は自分で決めずこの値を
  settings.json に書く。Claude Code の command hook の既定 timeout は 600 秒で、Stop
  イベントにはそれを短くする既定が無い。`bd` が刺さると 10 分セッションが止まりうるので、
  「fail-open のガードが原因で作業が止まる」ことのないよう明示的に縮める。
- **Stop / SessionStart / UserPromptSubmit エントリの `matcher` は空文字**。空文字は「matcher 無し」の
  意味で置いてあるだけなので、**P1b は settings.json に `matcher` キーを書かない**
  (PreToolUse の 2 本と PostToolUse の `Agent|Task` は書く)。同じ script を複数 event に
  宣言してよい (worktree-freshness.sh は 3 event)。登録状態の評価は event ごとに見る。

## 手で試す

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"pkill -f tsx"}}' \
  | bash harness/packs/bdboard-harness/hooks/pre-bash-guard.sh; echo $?   # => 2

echo '{"tool_name":"Bash","tool_input":{"command":"bd dolt push --remote backup"}}' \
  | bash harness/packs/bdboard-harness/hooks/pre-bash-guard.sh; echo $?   # => 0
```

自動テストは `src/infrastructure/harness/pack-hooks.test.ts` (bash で spawn して stdin に
JSON を流す統合テスト。Windows では skip) と、規則 7 用の
`src/infrastructure/harness/pack-hooks-server-guard.test.ts` (テストプロセス自身が空きポートで
listen し、その PID を「守られる対象」にする。本物のサーバーには触れない)、
`worktree-freshness.sh` 用の `src/infrastructure/harness/pack-hooks-worktree-freshness.test.ts`
(bare の origin と worktree を tmp に作り、origin を進めて遅れを再現する)、規則 8 と
pre-edit-guard.sh 規則 2 (main checkout 保護) 用の
`src/infrastructure/harness/pack-hooks-main-checkout-guard.test.ts` (tmp に main + worktree の
組を作り、`.claude/bdboard-harness.json` を `git worktree add` より前にコミットしてから
サブエージェント/議長 × main/worktree × 各種フォーム × 引用符内言及の deny/allow 表を
網羅する)。
