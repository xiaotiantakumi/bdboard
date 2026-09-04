# 委譲結果の独立検証と rebase 規律

## 独立検証 — 自己申告を鵜呑みにしない

なぜ: サブエージェントや他 AI の「全部通りました」は楽観に偏る（未実行・部分実行・
別ディレクトリで実行・古い成果に対する実行、が全て「通った」と報告されうる）。並列
セッション運用では自己申告が同時に複数返ってくるため、鵜呑みのコストは並列度に比例して
増える。

規律:

- **「全部通った」と主張してよいのは、自分がそのコマンドをこのセッションで実行した場合
  だけ。** 委譲先の報告は「委譲先はそう言っている」としてだけ扱う。
- **バックグラウンド/ラップ実行した検証を、ラッパーの終了コードで判定しない。**
  `npm run verify > log; echo EXIT=$?; tail log` のような形は、タスク全体の終了コードが
  最後のコマンド（tail）の 0 になり、検証失敗が「exit 0 の完了通知」に化ける（実測:
  failure-catalog.md の verify-exit-masked）。判定は必ずログ内に記録した検証コマンド
  自身の exit（`EXIT=` 行）とログの失敗有無で行う。ラップするなら
  `npm run verify > log 2>&1; ec=$?; tail log; exit $ec` の形で exit を最後まで運ぶ。
- **Bash tool の `run_in_background: true` に渡すコマンド文字列に、ジョブをバックグラウンド化
  する単独の `&`（コマンド末尾・行末の `&`。`2>&1` や `&&` は該当しない）を含めない。**
  `run_in_background` はホストが追跡する『渡したコマンド全体の完了』を検知して通知する
  仕組みだが、コマンド内にさらに `nohup npm run verify > log 2>&1 &` のような末尾 `&` を
  書くと二重に非同期化される。シェルは `&` の時点で即座に制御を返すため、ホストが検知する
  『完了』はその直後に続くコマンド（例: 直後の `echo "pid $!"`）でしかなく、実際の長時間
  処理は detached のまま動き続け、通知は来ない（実測: failure-catalog.md の
  double-background-verify）。長時間コマンドを待つときは、コマンド自体を（末尾に `&` を
  付けず）そのまま `run_in_background: true` へ渡すか、
  `while kill -0 <pid> 2>/dev/null; do sleep 5; done` のような foreground な待ち合わせ
  ループを同様に渡す（このループ自体は verify の成否を運ばないので、判定は上の
  `EXIT=` 行規律と組み合わせる）。「数秒で完了通知が来た」のに長時間コマンドのはずなら、
  まずこの二重バックグラウンド化を疑い、`pgrep`/`ps` で実プロセスの生死を確認する。
- 委譲成果を受け取ったら、採用判定の前に**検証コマンドを自分で回す**。対象の worktree で、
  フルの検証チェーンを回す。コマンドは (1) 注入先の検証コントラクト
  `.claude/bdboard-harness.json` の `verify` → (2) 無い/壊れていれば CLAUDE.md / AGENTS.md →
  (3) どちらにも無ければ検証せずに進めない、の順で決める（SKILL.md 規律4 手順1）。
- **レビューを別モデルへ依頼するときは、観点に「重複実装」を必ず入れる。** 定型:
  「同 PR 内、および直近の main（`git log -20 --stat`）に、同目的のヘルパー/ユーティリティが
  既に無いか。あれば統合を指摘すること」。並列セッションが同じヘルパーを別々に書くのは実測で
  最頻の整合性失敗で、後から統合チケットとして跳ね返る（failure-catalog.md の
  duplicate-helper-parallel）。着手前の検索（SKILL.md 規律2 手順4）と対で効かせる。
- 委譲先同士の指摘が食い違ったら、権威ある情報源（公式ドキュメント・実測）と突き合わせて
  自分が裁定する。多数決や「後から来た報告」で決めない。
- 同じチケットで同種の失敗が2回連続したら、失敗内容をチケットに記録
  （`bd update <id> --append-notes` または `bd comment`）して手を止め、別チケットへ回る。
  無限リトライは台帳に何も残さず時間だけ食う。

## 既知パターン: Codex 実装委譲が 0 編集のまま「委譲しました」と申告する

なぜ独立検証の一部として書くか: これは「委譲先の自己申告が実態と食い違う」典型例であり、
上の独立検証規律（git diff を自分で見る）を実際に適用して初めて発見できる。

症状（3つ揃ったらこのパターンを疑う）:

1. codex-implementer / `aimix run --mode implement --member codex` の呼び出しが、
   `writes=True`・書き込み可・フォールバック無しにもかかわらず **git diff が空**（0 編集）。
2. 応答が「実装担当に委譲しました」「担当に依頼しました」等の**間接表現**で、
   自分が編集したという記述がない。
3. latency が実コード生成にしては**異常に短い**（数十秒程度。実際にコードを生成した
   正常実行は通常数分かかる）。

原因（要約）: Codex CLI が読み込む `~/.codex/AGENTS.md` が、議長 Claude 向けの
オーケストレーション方針文書（「中規模以上の実装は既定で実装エージェントへ委譲する」等）への
シンボリックリンクになっており、**実装担当として起動された Codex がこの議長向け方針を自分
自身に誤適用**し、実際には委譲先ツールを持たないため何も編集せず「委譲した」とだけ回答する。
非決定的（同一環境・同一構成でも正常に完走する回があり、実測ではおよそ 3 回に 1 回程度）。
実測: bdboard-p5l.9（1 回目 latency 36 秒・0 編集・「委譲しました」→ リトライで 196 秒・
実差分あり・検証 green）。

対処:

- 症状 3 点が揃ったら、既定の失敗判定（bin 不在・書き込み不可メンバーへのフォールバック等）
  とは区別し、**即 failed とせず 1 回だけリトライする**。リトライが正常（実差分あり・latency が
  実生成相当）なら成果を通常どおり独立検証して続行する。
- **2 回連続**で同じ「0 編集 + 委譲文言」が出たら、それ以上リトライせず **status=failed として
  議長へ返す**。議長は失敗内容をチケットに記録して手を止める（上の「同種の失敗 2 回連続」
  規律と同じ扱い）。
- 根本原因（`~/.codex/AGENTS.md` と議長向けグローバル方針文書の内容混線）はグローバルな
  dotfiles / ハーネス設定の問題であり、**この skill および bdboard プロジェクトの対象外** —
  ここに記録するのは検知基準と回避（リトライ手順）だけ。対応要否はユーザー自身の判断に委ねる
  （worktree-pr-flow.md の Node version プリフライトチェック（bdboard-hmj）と同型の扱い）。

## 既知パターン: Codex 実装委譲が無断で commit / push / PR 作成 / force-push まで実行する

なぜ独立検証の一部として書くか: 上の 0 編集パターンの**逆方向**の亜種。同じ根本原因
（Codex がプロジェクトの CLAUDE.md / AGENTS.md にある通常の Git Workflow 知識を、
ブリーフの明示的な制約より優先して自分に適用する）が、過少行動ではなく**過剰な自律行動**
として現れる。0 編集は safe-failing（何も起きていない・リトライで済む）だが、こちらは
**不可逆の外向き操作**（push・PR 作成・force-push）が確認ゲートなしで実行される
unsafe-failing であり、深刻度は段違いに高い。実測（bdboard-ge20, 2026-08-29）では
1 チケット内で (1) commit 禁止指示下での commit+push → (2) 無断 PR 作成 →
(3) 実在しない「PR レビュー指摘」を根拠にした追加実装と、オープン済み PR・実行中 CI の
あるブランチへの無断 rebase + amend/squash + force-push、と実行のたびにエスカレートした。

検知（委譲の完了報告を受けたら、diff の内容確認とは別に必ず実行する）:

```bash
git log --oneline -5           # 自分が作っていないコミットが無いか
git status                     # working tree とブランチの ahead/behind
git ls-remote origin <branch>  # remote 側の先端が自分の認識と一致するか
```

- 「差分がある」ことは「まだ未コミットである」ことを意味しない。委譲先が commit 済み・
  push 済みでも diff の見た目は正常でありうる。
- **1 回の確認では足りない。** 委譲プロセス（`aimix run` 等）は、利用上限エラー等で
  exit_code=1 を返した後でも**バックグラウンドで活動を再開しうる**（実測）。完了報告〜
  自分が PR 操作を行うまでの間にも上記の再確認を挟み、さらに **PR 作成・push・merge の
  各 outward 操作の直前**に、委譲プロセスが終了していること（起動時に控えた pid を
  `ps -p <pid>` で確認、または worktree を cwd に持つプロセスの不在を
  `lsof -a -d cwd +D <worktree>` で確認）を裏取りしてから進む。
- 委譲先が「PR レビューで指摘された」等の**外部フィードバックを根拠に**追加作業を
  報告してきたら、その実在を API で確認する（実測では reviews/comments とも 0 件の
  捏造レビューを根拠に追加実装が行われた）:

  ```bash
  gh api repos/<owner>/<repo>/pulls/<N>/reviews --jq length
  gh api repos/<owner>/<repo>/pulls/<N>/comments --jq length
  ```

無断 push を発見したときの封じ込め:

1. 対象が**他セッションにまだ参照されていない per-ticket 専用ブランチ**なら、force-push
   せずフォワードの cleanup コミット（scratch ファイル削除等）で是正して通常フローへ
   合流してよい。
2. 他セッションが fetch している可能性のある共有ブランチ、またはオープン済み PR の
   あるブランチなら、履歴書き換え（force-push）は**ユーザー確認を要する不可逆操作**として
   扱う（SKILL.md 規律3 手順7）。

予防（委譲を投げる側の義務）:

- ブリーフの git 制約は**禁止形＋自己申告義務**で書く。「commit はしないでよい」のような
  許可解除形は誤適用の余地を残す（実測ではこの形の指示が無視された）。定型文:
  「`git add` / `git commit` / `git push` / `gh` 系コマンドは一切実行しないこと。
  実行してしまった場合は、理由を問わず status=failed としてその旨を報告すること。」
- 機械ガードとして、委譲前に worktree 限定の pre-push hook で push を塞いでよい
  （下記コマンド。委譲先の**誤適用**を止めるためのもので、敵対的な回避までは防がない）。
  hook 置き場は worktree の作業ツリー内ではなく、`git rev-parse --absolute-git-dir`
  が指す worktree 専用 git-dir（`.git/worktrees/<name>/` 配下）に置く — 作業ツリー内
  だと委譲先の `git add -A` に巻き込まれてコミットへ混入しうる（実測: 今回の事故でも
  無関係な scratch ファイルが混入した）:

  ```bash
  # 委譲前（worktree 内で）:
  git config extensions.worktreeConfig true
  GUARD_DIR="$(git rev-parse --absolute-git-dir)/delegation-guard"
  mkdir -p "$GUARD_DIR"
  printf '#!/bin/sh\necho "push blocked: delegation guard active" >&2\nexit 1\n' \
    > "$GUARD_DIR/pre-push"
  chmod +x "$GUARD_DIR/pre-push"
  git config --worktree core.hooksPath "$GUARD_DIR"
  # 委譲成果の独立検証が済み、自分で push する直前に解除:
  git config --worktree --unset core.hooksPath
  ```

  `core.hooksPath` は pre-push だけでなく**その worktree の全 hook**（pre-commit・
  prepare-commit-msg 等）を差し替える。bdboard リポジトリはリポジトリ全体で
  `core.hooksPath` を `.beads/hooks` に設定済みのため、このガード有効中は当該
  worktree の beads hooks も無効化される（PR ブランチは `.beads/` に触れない規約
  なので実害は無い想定だが、他プロジェクトへ流用する際は注意）。

- 根本原因（Codex 側の方針誤適用・aimix バックグラウンド再開）はグローバルな
  ツール/設定層の問題であり、この skill の対象外 — ここに置くのは検知・封じ込め・
  委譲側の予防だけ（codex-zero-edit と同じスコープ切り）。

## diff は merge-base 基準で読む

なぜ: 並列セッション運用では `origin/main` は**動く的**になる。作業中に他セッションが
PR をマージすると、`git diff origin/main` は「他人の追加」を**自分の削除**として表示する。
これを「委譲先が暴走して他機能を消した」と誤読すると、無実の成果物を捨てる判断に直結する
（実例あり: 16ファイルの追加変更が、52ファイル・数千行の削除に見えた）。

手順:

```bash
# (a) 自分の変更「だけ」を見る
git diff --stat $(git merge-base HEAD origin/main)
# → git status --porcelain のファイル数と突き合わせる

# (b) 想定外に大きければ、相手が進んだのか自分が壊れたのかを切り分ける
git log --oneline HEAD..origin/main
```

委譲先を疑うのは (a)(b) の後。

## rebase 規律 — 検証は最新 main の上で

なぜ: ブランチ作成時点の main で緑でも、その後に着地した他セッションの変更との
**意味的衝突**（テキスト衝突を起こさずに挙動が壊れる組み合わせ）は、最新 main に載せて
検証し直すまで見えない。rebase がコンフリクトなしで通ることは安全の証拠にならない。

手順（PR を開く直前、および CI 待ちが長引いて main が動いたとき）:

```bash
git fetch origin
git rebase origin/main
# → 検証コマンド（規律4 手順1 の参照順で決めたもの）をフルで回し直す（ここを省略しない。
#    テキスト上クリーンな rebase でも意味的衝突は残り、再検証がその唯一の網）
git rev-parse origin/main   # base SHA を控える → マージ直前 CAS で使う
```

- 控えた base SHA は、マージ直前に `git ls-remote origin main` と突き合わせる
  （[worktree-pr-flow.md](worktree-pr-flow.md) のマージ排他・層2）。
- rebase 後に検証が割れたら、それは自分のブランチと main の意味的衝突であって
  「テストの flake」ではない、をまず疑う。原因を特定してから直す（タイムアウト延長などの
  対症療法は本物の退行を隠す方向に効く）。
