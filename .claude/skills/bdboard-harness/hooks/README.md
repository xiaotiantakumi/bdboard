# bdboard-harness hooks

failure-catalog の「D: 文章で禁止しても再発する操作ミス」を、文章ではなく Claude Code
の hook で機械的に止める仕組み (bdboard-pkr6.1 / docs/HARNESS-EVALUATION.md
§2.3・§5 P1)。`.claude/settings.json` への登録は注入 API 側が行う (bdboard-pkr6.2)。

bdboard-cm2q.10 (2026-09) で、コマンド文字列/パスを正規表現や argv で読んで判定していた
`pre-bash-guard.sh` / `pre-edit-guard.sh` / `server-guard.sh` / `worktree-owner-guard.sh` と
共有ライブラリ `lib-main-checkout.sh` を削除した。理由は fable による設計レビュー
(bdboard-cm2q の 2026-09-26 のコメント「bdboard ガードの棚卸しと置き換え方針」) で、これらの判定が `bash -c`・絶対パス・
`FOO=1` 前置き・引用符崩れ等で構造的にすり抜けられ、保守コストに見合わなくなったため。
今この `hooks/` に残るのは、コマンド文字列を読まずセッション/リポジトリの**状態**だけを
見る 2 本 (`stop-ticket-gate.sh` と `worktree-freshness.sh`) だけ。削除した判定が
守っていたリスクは、下の「deny・隔離・merge-pr との分担」にある別の機構が引き継ぐ。

## deny・隔離・merge-pr との分担

コマンド文字列/パスを読んで機械的に止める役目は、hook から次の機構へ移した。

| 旧 hook (規則) | リスク | 引き継ぎ先 |
|---|---|---|
| pre-bash-guard 規則1 (pkill/killall) | プロセス誤 kill | `permissions.deny` (`Bash(pkill *)` / `Bash(killall *)` / `Bash(kill *)`) |
| pre-bash-guard 規則2 (`--remote` 無し dolt push/pull) | 誤った remote への同期 | `permissions.deny` (`Bash(bd dolt push)` 等。`--remote origin`/`=origin` の形・push の `--yes`/`-y` も列挙) |
| pre-bash-guard 規則3 (bare `git stash`) | 他セッションの stash を取り違えて pop | `permissions.deny` (`Bash(git stash)` / `Bash(git stash pop *)` / `Bash(git stash save *)`) |
| pre-bash-guard 規則5 (契約 `hooks.denyBashPatterns`) | プロジェクト固有の禁止コマンド | 廃止。プロジェクト固有の禁止は各プロジェクトの `permissions.deny` に直接書く |
| pre-bash-guard 規則6 (aimix 振り分け照合) | 規律6 (モデル振り分け表) の無視 | `scripts/aimix-run.sh` (argv ラッパー)。素の `aimix run` は `permissions.deny` (`Bash(aimix run *)`) で止め、委譲をラッパー経由に寄せる。詳細は `references/model-routing.md`「aimix-run.sh — 規律6 の照合ラッパー」 |
| pre-bash-guard 規則7/8 (常時稼働サーバー・main checkout 保護) | サブエージェントが main checkout を pull/commit/checkout したり listener を kill する | `isolation: "worktree"` (bdboard-worker はサブエージェントとして常に隔離 worktree で動く。File edits / Command working directory / Git redirects / Command shape の4チェック) + `scripts/always-on-server.sh` の `BDBOARD_SERVER_CALLER=chair` 宣言必須 + `--expect-pid` CAS + `permissions.deny` の kill 系 |
| pre-bash-guard 規則9 (worktree 所有権保護) | 他人の worktree を乗っ取って merge-pr/gh pr merge | 構造的に 1 チケット = 1 隔離 worker (`isolation: "worktree"`) にしたことで乗っ取る対象自体が薄くなった上、`scripts/merge-pr/*` の `BDBOARD_MERGER=chair` 必須宣言・レビュー記録の前提条件、GitHub 側の protect-main ruleset (bypass を "pull requests only" に制限) |
| pre-edit-guard 規則1 (注入コピー編集) | `.claude/skills/bdboard-harness/` を直接編集して原本と分岐 | `permissions.deny` (`Edit(**/.claude/skills/bdboard-harness/**)`) |
| pre-edit-guard 規則2 (main checkout への Edit/Write) | サブエージェントが main checkout のファイルを直接編集 | `isolation: "worktree"` の File edits チェック |
| pre-edit-guard 規則3 (`.beads/` への Edit) | bd 台帳ファイルを直接編集して CI の diff チェックに落ちる | `permissions.deny` (`Edit(**/.beads/**)`。旧規則のブランチ条件は deny では表せないので無条件) |

**pack 注入は `permissions` を配らない** — 注入 API が `.claude/settings.json` へ
自動登録するのは `hooks` キーだけで、`permissions` はパックの管轄外 (各プロジェクトが
自分で設定する領域だから)。このパックを新しく注入するプロジェクトは、
`references/settings-snippet.json` の内容を自分の `.claude/settings.json` の
`permissions.deny` へ手で足す必要がある (bdboard 固有の 2 行 — `Bash(npm run verify:steps *)`
と deny の実測プローブ `Bash(bdboard-deny-canary *)` — は同ファイルに含めていない。
`.beads/` を直に触る運用がある注入先は `Edit(**/.beads/**)` の 1 行を消してよい)。足さなければ、上の表の「引き継ぎ先」のうち deny 側は一切効かない。

kill だけは元々これを説明する hook 側の案内が無く、deny が理由を出さずに拒否する点は
変わっていない (bdboard-cm2q.1)。プロセスの生死確認は `ps -p <pid>`、常時稼働サーバーの
再起動は議長が `scripts/always-on-server.sh`、Claude が起動したバックグラウンドタスクの
停止は `TaskStop`、それ以外は議長かユーザーに聞く。

## 共通の約束 (残る 2 本)

- **allow は exit 0 で無出力。どちらも「止める」ための hook ではない** —
  `stop-ticket-gate.sh` だけがセッション終了を差し戻す (exit 2)。`worktree-freshness.sh`
  は常に exit 0 で、警告があるときだけ stdout に JSON を出す。
- **判定不能はすべて allow (fail-open)**。`set -e` は使わない。hook が壊れて作業が
  止まるより、文章ルールへ戻るほうが安全という判断。
- 入力は stdin の Claude Code hook JSON。抽出は `jq` → `python3` の順に使う。
  **どちらの JSON ツールも無い環境では、判定せず exit 0 で通す (fail-open)**。
- 依存は bash (3.2 互換) / coreutils / git / bd と、任意で jq・python3 のみ。node に
  依存しない (注入先が npm プロジェクトとは限らない)。
- 実行ビットは注入時に付ける。手で叩くときは `bash <script>` で呼ぶ。

## stop-ticket-gate.sh — Stop (matcher なし)

「チケットに何も残さずセッションを終える」を差し戻す。

1. `stop_hook_active` が true なら通過 (無限ループ防止)。
2. チケット ID: ブランチが `bd/<id>` ならその `<id>`。そうでなければ cwd の
   `.claude/worktrees/<name>` の `<name>` を候補にし、`bd -C <cwd> show <name> --json` が
   成功したら採用。どちらも駄目なら通過 (per-ticket worktree ではない)。
3. `bd -C <cwd> show <id> --json` の status が `in_progress` でなければ通過。
4. `bd -C <cwd> comments <id> --json` に `PR:` を含むコメントがある、または最新コメントが
   4 時間以内なら通過 (痕跡は残っている。旧 15 分の窓を bdboard-cm2q.10 で拡げた —
   短い窓は「調査だけで一区切りついたセッション」を頻繁に差し戻していた)。
5. それ以外で `git status --porcelain` が非空、または `origin/<mainBranch>..HEAD` に
   `<mainBranch>` へ未取り込みのコミットがあれば、まず
   `${TMPDIR:-/tmp}/bdboard-stop-ticket-gate/` の session_id マーカーを確認する。
   **同じセッションで一度案内済みならそのまま通過**(繰り返し差し戻さない)。未案内なら
   **exit 2** で差し戻し、マーカーを書いてから終える。
6. それ以外は通過。

`bd` が PATH に無い場合・JSON ツールが無い場合はいずれも通過する。`bd` はすべて
`-C <hook の cwd>` 付きで呼ぶ — Stop hook のプロセス cwd は Claude Code 側の都合で
決まり、対象 worktree とは限らないので、渡さないと別チェックアウトの `.beads/` を
読みかねない。

## worktree-freshness.sh — SessionStart / UserPromptSubmit / PostToolUse (matcher: `Agent|Task`)

「hook の読み込み元の checkout が既定ブランチから取り残されている」をセッション自身に
知らせる (bdboard-flpp)。**警告だけで、自動の checkout / merge はしない** (作業中の
変更を壊しうるため)。常に exit 0。

### なぜ要るか

hook の登録 (`.claude/settings.json`) も本体 (この `hooks/` や `scripts/*.mjs`) も、セッションを
起動した checkout (`$CLAUDE_PROJECT_DIR`) から読まれる。Agent ツールで起動したサブエージェントの
hook も**親と同じ** `$CLAUDE_PROJECT_DIR` から読まれる。何日も動く議長セッションの checkout は
誰も更新しないので、main に入った hook の追加・修正が議長にも、議長が起動した全サブエージェントにも
届かない。2026-09 には議長の worktree が公開前の旧履歴のまま 1 か月以上動き、常時稼働サーバー
保護 (当時の規則7) が一度も効いていなかった。ボードの Hygiene (`nonTicketHarnessWorktrees`) は
外から同じ遅れを出していたが、セッション自身には届いていなかった。

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

## 守らないもの（既知の限界）

hook を削除して deny・isolation・merge-pr の宣言的なゲートに置き換えたことで、
「文字列/argv を読んで巧妙な迂回まで機械的に潰す」動きから「素直な操作は機械的に
止めるが、意図的な回避は文書の規律に戻る」動きへ後退した面がある。以下は受容済みの
既知の限界 (fable レビューの決定4):

- **`permissions.deny` はコマンド行の文字列一致**。`bash -c '...'`・絶対パス
  (`/bin/kill`)・`FOO=1 kill ...` のような前置き・フラグ付き `xargs`・別言語
  (`node -e`/`python3 -c`) 経由の kill/pkill/killall/dolt push/`aimix run` はいずれも対象外
  (旧 hook はこれらの一部を実際に判定していたが、その判定コード自体を削除した)。
  規則6 が拾っていた `FOO=1 aimix run`・`~/.agent/skills/ai-mix/bin/aimix run`・
  `bash -c 'aimix run …'` も素通りする。正規経路 (ラッパー) は cursor-implementer /
  codex-implementer の定義と SKILL.md 規律6 が担う。`bd sync` は deny に無い。
- **Codex / Cursor が aimix 経由で起動する子プロセスには Claude Code の設定が届かない**
  (deny も isolation も効かない)。委譲先の書き込み範囲は各 CLI 側の設定と文書規律に依る。
- **`bd dolt push <flags>`** は `--remote` を付けていても、deny に列挙していない
  flag の組み合わせまでは網羅していない。
- **git 以外で Bash から main checkout へ絶対パスで書くこと** (`sed -i`/`cp`/`tee` 等)
  は、規則8 を bdboard-cm2q.10 で削除した後、`isolation: "worktree"` も deny も止めない。
  サンドボックス導入までの既知の限界として受容する (導入は別チケットで検討)。
- **`isolation: "worktree"` は frontmatter で宣言したエージェント (bdboard では
  `bdboard-worker`) の子にだけ効く**。cursor-implementer / codex-implementer /
  general-purpose など非隔離で起動される子と議長セッション自身は、main checkout の
  pull/commit/checkout/Edit を機械的には止められない (旧規則7/8・pre-edit 規則2 は全
  サブエージェントを対象にしていた)。これらは文書の規律 (bdboard-worker.md・CLAUDE.md) に依る。
- **`BDBOARD_MERGER=chair` / `BDBOARD_SERVER_CALLER=chair` は身元の証明ではなく宣言**。
  サブエージェントがこれらの環境変数を自分で設定して呼べば通ってしまう (Claude Code 側に
  サブエージェント/議長を機械的に区別する手掛かりが無いため)。
- **`run_in_background` と行末 `&` の二重非同期化** (旧 pre-bash-guard 規則4の懸念) は、
  規則自体を丸ごと削除したため完全に既知の限界に後退した。

これらは個別には起票せず、この一覧で受容を記録する。実測で悪用/事故が起きたら
failure-catalog に追加する。

## pack.json の `hooks[]` 宣言 (P1b への契約)

各エントリは `event` / `matcher` / `script` / `timeout` を持つ。P1b (bdboard-pkr6.2) が
`.claude/settings.json` へ登録するときは、**この 4 つをそのまま書き写す**。現在の
エントリは 2 スクリプト・4 エントリ — `stop-ticket-gate.sh` (Stop) と `worktree-freshness.sh`
(SessionStart / UserPromptSubmit / PostToolUse) — で、PreToolUse の登録は無い
(コマンド文字列/パスを読む hook を bdboard-cm2q.10 で全廃したため)。

- **`timeout` は秒。契約値として `10` を宣言してある** — P1b は自分で決めずこの値を
  settings.json に書く。Claude Code の command hook の既定 timeout は 600 秒で、Stop
  イベントにはそれを短くする既定が無い。`bd` が刺さると 10 分セッションが止まりうるので、
  「fail-open のガードが原因で作業が止まる」ことのないよう明示的に縮める。
- **Stop / SessionStart / UserPromptSubmit エントリの `matcher` は空文字**。空文字は「matcher 無し」の
  意味で置いてあるだけなので、**P1b は settings.json に `matcher` キーを書かない**
  (PostToolUse の `Agent|Task` は書く)。同じ script を複数 event に宣言してよい
  (worktree-freshness.sh は 3 event)。登録状態の評価は event ごとに見る。

## 手で試す

```bash
echo '{"hook_event_name":"Stop","stop_hook_active":false,"cwd":"'"$PWD"'"}' \
  | bash harness/packs/bdboard-harness/hooks/stop-ticket-gate.sh; echo $?

echo '{"hook_event_name":"SessionStart","cwd":"'"$PWD"'"}' \
  | bash harness/packs/bdboard-harness/hooks/worktree-freshness.sh
```

自動テストは `src/infrastructure/harness/pack-hooks.test.ts` (bash で spawn して stdin に
JSON を流す統合テスト。Windows では skip) と、`worktree-freshness.sh` 用の
`src/infrastructure/harness/pack-hooks-worktree-freshness.test.ts` (bare の origin と
worktree を tmp に作り、origin を進めて遅れを再現する)。旧 `server-guard.sh` /
`worktree-owner-guard.sh` / `pre-edit-guard.sh` 用の統合テストは、対応する hook の削除に
合わせて役目を終えている。
