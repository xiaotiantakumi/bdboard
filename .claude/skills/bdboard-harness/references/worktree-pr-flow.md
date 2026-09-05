# per-ticket worktree + branch + PR フロー

1チケット = 1 worktree = 1ブランチ = 1 PR。main への直接コミットはしない。
この対応を崩すと、並列セッション間で「どの変更がどの作業か」が追えなくなり、
排他（SKILL.md 規律2）の前提も壊れる。

検証コマンド・PR の要否・main ブランチ名は、**(1) 注入先の検証コントラクト
`.claude/bdboard-harness.json` → (2) 無い/壊れていれば CLAUDE.md / AGENTS.md → (3) どちらにも
無ければ検証せずに進めない**（SKILL.md 規律4 手順1）の順で決める。

コントラクトの3キーの意味（この節が正本。SKILL.md 側はここへのポインタ）:

| キー | 意味 |
|---|---|
| `verify` | 回して **exit 0 が合格**の検証コマンド |
| `prFlow` | `pr` = PR 必須 / `direct` = main 直コミット可 / `none` = git 手順を省く |
| `mainBranch` | rebase と、マージ直前 CAS（層2）の基準ブランチ名 |

**(3) に落ちたときのエスカレーション**（この文言をそのまま使う）:

```bash
bd comment <id> "検証ループ未定義: このプロジェクトに検証コマンドの宣言がありません (.claude/bdboard-harness.json を作成してください)"
```

そのうえで **human ラベル＋human gate（SKILL.md 規律3 手順2–3）**を付け、回答を待たずに次の
チケットへ回る。検証コマンドが無いまま「たぶん通る」で PR を開かない。

コントラクトが持たない値（ブランチ命名・worktree 置き場・マージ方式）は従来どおり
CLAUDE.md / AGENTS.md が正。以下では既定の推奨としてブランチ `bd/<id>`、worktree
`.claude/worktrees/<id>/`、main ブランチ `main` と書く。

## ライフサイクル

```
空き確認 → worktree作成(=排他獲得) → claim → 実装(+heartbeat) → 検証
→ rebase → 再検証 → PR → CI green → マージ排他3層 → マージ → close → 掃除
```

### 1. 空き確認と worktree 作成（排他獲得）

**なぜ排他が git なのか**: 並列セッションは全て**同じユーザー（同じ assignee）**で動くため、
`bd update --claim` のアトミック性（CAS）は先行 claim を検出できず、**両方成功しうる**
（さらに `--claim` は `--if-status` / `--if-assignee` と併用不可で、ガード付きの1コマンドは
書けない）。一方 `git worktree add -b <branch>` は、既存ブランチ/worktree があれば git が
拒否するので、先着1名だけが成功する。よって**排他はチケット台帳ではなく git が裁く**
（SKILL.md 規律2）。

**着手前の空き確認は worktree とブランチの両方を見る。** ブランチだけが先に存在する
ケースがあり、片方だけでは取りこぼす:

```bash
ls .claude/worktrees/<id>          # 「存在しない」ことを確認
git rev-parse --verify bd/<id>     # 「存在しない」ことを確認
```

両方の不存在を確認してから:

```bash
git -C <メインチェックアウト> fetch origin
git -C <メインチェックアウト> worktree add .claude/worktrees/<id> -b bd/<id> origin/main
```

- `origin/main` 起点で作る（ローカル main が古くても最新から始められる）。
- 成功 = 排他獲得。失敗（ブランチ/パス既存）= 他セッションが着手中。別チケットへ。
- 成功したら `bd update <id> --claim`。
- **複数チケットを一括で並列着手するときも、2本目以降を毎回この `git -C
  <メインチェックアウト>` 形式で実行する**（生シェルで cd している場合は `pwd` で
  メインチェックアウトに居ることを確認してから）。cwd が既存 worktree の中のまま
  相対パスで add すると、新しい worktree がその worktree の**内側にネストして**作られる
  （実測: 2026-08-17、`.claude/worktrees/<A>/.claude/worktrees/<B>/`）。ネストを発見したら
  **内側の worktree から先に** `git worktree remove` する — 外側から消すと内側の作業ごと
  再帰的に破壊される（failure-catalog.md の nested-worktree）。

### 2. worktree 内でのセットアップと実装

- **依存インストールの前に Node のバージョンを確認する**（`node --version`）。プロジェクトの
  `package.json` の `engines.node` を満たさないバージョンで `npm install` すると、依存関係の
  解決結果・`package-lock.json` の内容（例: `license` フィールドの有無）が変わりうる。これは
  ハーネスのシェルスナップショットが `nvm` 関数は持つが `NVM_DIR` を欠くために `.zshrc` の
  `nvm use --silent default` が無言で失敗し、意図しない Node バージョンが PATH に残る既知の
  ハーネス側バグに起因する（bdboard-hmj）。要件を満たさなければ、原因調査に進む前にまず
  正しいバージョンを PATH の先頭に通してからやり直す:

  ```bash
  node --version   # package.json の engines.node と突き合わせる
  # 満たさない場合の例（インストール済みバージョンのパスは環境依存。nvm ls で確認）:
  export PATH="$HOME/.nvm/versions/node/<必要なバージョン>/bin:$PATH"
  node --version   # 期待値に一致することを確認してから続行
  ```

  この節はハーネス側バグの検知と回避（回復コマンド）を目的としており、根本原因（`NVM_DIR`
  欠落そのもの）の修正はこの skill の対象外 — 該当ハーネスの開発元へ別途報告する。
- 依存インストール（`node_modules` 等は worktree 間で共有されない）。コマンドは
  プロジェクトの CLAUDE.md に従う。
- **実装に入る前に既存実装を1回探す**（重複実装の予防。SKILL.md 規律2 手順4 の実体）:
  変更予定の領域名・関数名で `git grep -n <キーワード>` と
  `bd search "<キーワード>" --status in_progress`（title/ID しか検索しない。説明文まで見るなら
  `bd list --status in_progress --desc-contains "<キーワード>"` を併用する）を各1回。既存
  ヘルパー・同目的の実装が見つかったら再利用し、`bd comment <id> "再利用: <path>"` を残す
  （見つからなければコメント不要）。同じ領域を触っている in_progress チケットがあれば双方に
  コメントし、`bd dep add <自分> <相手> --type related` を張る。根拠: 2026-08 に並列実装
  由来の重複ヘルパー解消チケットが10件超（failure-catalog.md の duplicate-helper-parallel）。
- **worktree からポートを掴む常駐プロセス（dev サーバー等）を起動しない。** ポートは
  メインチェックアウトの常設サーバーのものというプロジェクトが多く、衝突すると本体側を
  巻き込む。テスト・型チェック・lint はポートを掴まないので並列 worktree で問題なく走る。
- 実装中は `bd heartbeat <id>` を打ち続ける（`scripts/bd-heartbeat.sh`。lease-params.md）。
- **`.beads/` 配下を PR ブランチ内で変更しない。** 台帳の同期は Dolt 側
  （`bd dolt push/pull`）が担い、コード PR の diff に混ぜない。

### 3. 検証 → rebase → 再検証

検証コマンド（上の参照順で決めたもの。コントラクトの `verify`、無ければプロジェクト規約の
フルの検証チェーン）をローカルで緑にしてから PR を開く。`prFlow` が `direct` / `none` の
プロジェクトでは以降の PR 手順を省いてよいが、**検証を省いてよいわけではない**。その直前に:

```bash
git fetch origin
git rebase origin/main
# → 検証コマンドをもう一度全部回す（テキスト上クリーンな rebase でも意味的衝突は残る）
git rev-parse origin/main   # ← この base SHA を控える（後述の直前CASで使う）
```

詳細な理由と merge-base 基準の diff の読み方は [verification.md](verification.md)。

### 4. PR 作成

```bash
gh pr create --fill --body "Closes: <id>

<変更サマリ>"
bd comment <id> "PR: <url>"
```

PR を開いた時点では **close しない**（SKILL.md 規律4）。CI が緑になるのを待つ
（待ち時間に他チケットを進めてよい）。

**CI待ち中に `gh pr checks`/`gh pr view` が503等で失敗し続ける場合**（GitHub障害時など）:
「障害で確認できないだけ」と決めつけない。これらはGraphQL裏付けのコマンドで、GraphQLが
落ちていてもREST APIは動いていることが多い。まずRESTへ切り替えて実態を確認する:

```bash
gh api repos/<owner>/<repo>/pulls/<N> --jq '{state,merged,mergeable,mergeable_state}'
gh api repos/<owner>/<repo>/commits/<HEAD_SHA>/check-runs --jq '.check_runs[] | {name,status,conclusion}'
gh api "repos/<owner>/<repo>/actions/runs?branch=<branch>&per_page=5" --jq '.workflow_runs[] | {name,status,conclusion,head_sha,created_at}'
```

**非自明な落とし穴**: 障害中の force-push は、CIワークフロー自体が一度も起動しないことが
ある（webhookの`synchronize`イベント配送が無言でドロップされる）。上記の`check-runs`/
`actions/runs`に対象コミットのSHAに対応する行が一件も無ければ、それは「pending中」ではなく
「起動していない」——いつまで待っても状態は変わらないので、Monitorで503/pendingを
リトライし続けても無意味。判定は次で行う:

```bash
gh api repos/<owner>/<repo>/commits/<HEAD_SHA>/check-suites --jq '.check_suites[] | {app: .app.name, status, conclusion}'
```

CI(GitHub Actions)のcheck-suiteそのものが存在せず、GitGuardian等サードパーティのappだけが
並んでいれば起動漏れと確定できる。復旧は空コミットで新しいsynchronizeイベントを強制発生
させるだけでよい（コード変更不要・可逆）:

```bash
git commit --allow-empty -m "chore: retrigger CI (Actions dispatch missed during GitHub outage)"
git push
```

実例: [failure-catalog.md](failure-catalog.md) の ci-webhook-drop（さらに詳しい経緯は
グローバル orchestration skill の `reference/lessons-learned.md`「GitHub Actionsの
webhook dispatchが障害中に無言で失われる（bdboard, 2026-08-17）」— 参考。本則はこちら）。

**CI待ちのポーリングで GraphQL rate limit を食い潰さない**: `gh pr create`・`gh pr merge`・
`gh pr checks`・`gh pr view --json` は、gh CLI の内部実装がいずれも GraphQL API 経由で、
REST(core) とは**独立した** GraphQL 枠を消費する（`git push` は裸の git プロトコルなので
この枠と無関係）。しかも枠は**アカウント（トークン）単位でリポジトリ単位ではない**ため、
同一アカウントで動く他セッション・他リポジトリの gh 呼び出しとも共有され、自分の
セッションが節約していても枯渇しうる。実測: bdboard-p5l.10（3並列レーン運用中に
GraphQL 枠だけが 0/5000 になり `gh pr create` が失敗。core 枠は 5000/5000 で無傷、
`git push` は成功済みだった）。

- `gh pr checks --watch --interval 15` のような**短間隔の内蔵 watch を常用しない**。
  ポーリングは既定 30 秒以上の間隔にする。Monitor のような能動的なポーリング手段が
  あるなら、`gh pr checks <N> --json name,bucket` を 30 秒間隔で叩いて前回結果との
  差分だけを報告し（実装例: 前回スナップショットと `comm -13` で突き合わせる）、
  bucket が pending のチェックが無くなったら終了する形にする。CI の典型所要時間が
  分かっているなら、初回ポーリングまでその分待ってから始めるのも呼び出し削減に効く。
  さらに枠を温存したければ、上の 503 障害時と同じ `check-runs` の REST 照会で
  ポーリングしてもよい（こちらは core 枠を消費する）。
- **複数 PR を同時に見張るときは、PR ごとに watch を立てず 1 本の監視ループへ集約する**。
  1 周で全対象 PR をまとめて照会すれば、ポーリング回数（= 枠の消費速度）が PR の
  本数に比例して増えない。

**GraphQL 呼び出しが `GraphQL: API rate limit already exceeded ...` で拒否されたら**:

1. **`git push` は影響を受けていない**。`gh pr create` が枯渇で失敗しても、ブランチは
   既にリモートに存在している — 復旧は `gh pr create` のリトライだけでよく、worktree や
   ブランチの作り直しは不要。状態確認だけなら、上の 503 障害時の REST コマンド群も
   core 枠なのでそのまま使える。**原因の切り分けに時間を使わず、PR 操作一式を REST へ
   切り替える**。これは GraphQL 一次枠の枯渇・スナップショットのラグ・後述の secondary
   rate limit のいずれにも有効で、GraphQL を一切使わない:

   ```bash
   # create-pull.json は下の例のように json.dumps で作る
   gh api repos/<owner>/<repo>/pulls --method POST --input create-pull.json --jq .html_url
   gh api repos/<owner>/<repo>/pulls/<N>/merge --method PUT --input merge-pull.json
   gh api repos/<owner>/<repo>/commits/<sha>/check-runs
   gh api repos/<owner>/<repo>/git/refs/heads/<branch> --method DELETE
   ```

   本文に日本語や改行を含むと `-f key=value` は壊れうるため、ペイロードをシェルで組み立てず
   `python3` の `json.dumps` で一時ファイルへ書き出し、`--input` で渡す。PR 作成の例:

   ```bash
   python3 -c 'import json; open("create-pull.json", "w").write(json.dumps({"title": "<title>", "head": "<branch>", "base": "main", "body": "Closes: <id>\\n\\n<変更サマリ>"}, ensure_ascii=False))'
   ```

   merge-pull.json は `merge_method`、`commit_title`、`commit_message` を持たせる。REST の
   `PUT .../merge` 後も、マージ成否は CLI の終了 status ではなく層2で控えた SHA と
   `git ls-remote origin main` の再読みを比較して判定する（詳細は層3）。

   実測（2026-08-29, PR #134 / bdboard-2w3）: `gh api rate_limit` の graphql が
   **remaining=5000 を示していても GraphQL 呼び出しが exceeded で拒否され続ける**
   ことがある。bdboard-2w3 で `gh api graphql ... -i` の実レスポンスヘッダを直接
   probe したところ `X-Ratelimit-Remaining: 0` が返っており、原因は「rate_limit
   スナップショットの取得後、実際の呼び出しまでの間に他セッションの並行消費で枯渇した」
   （スナップショットが実態より新しく見えるラグ）と確認できた — 表示自体が誤りなの
   ではなく、アカウント単位で共有される枠を他セッションが同時に食う速さにスナップ
   ショットが追いつかない。加えて実測（2026-09-05, PR #387 / bdboard-69w1）では、
   `gh api rate_limit` が core / graphql とも 5000/5000 なのに同じエラーで PR 作成が失敗した。
   GitHub 側が secondary rate limit と明示したわけではないが、コンテンツ作成に対する
   **secondary rate limit と考えられる**。この場合 `.resources.graphql.reset` は一次枠の
   リセット時刻であり待っても解けないため、手順2・3の sleep に頼り切らず即 REST へ
   切り替える。満タン表示時はラグか secondary かを確定しなくても、対処は同じである。
2. 正確なリセット時刻を取る（`gh api rate_limit` 自体は REST(core) 枠なので、GraphQL が
   枯渇していても通る）:

   ```bash
   gh api rate_limit --jq '.resources.graphql | {remaining, reset, wait_sec: ((.reset - now) | floor)}'
   ```

3. `wait_sec` に数秒の余裕を足した秒数を待ってからリトライする。待ちは **`sleep <秒数>`
   単体の Bash 呼び出し 1 回**で行い、後続コマンドとチェーンしない
   （`sleep N && gh pr create ...` の形はハーネスにブロックされる既知の制約がある）。
   リトライは sleep 完了後の**別の** Bash 呼び出しで行う。待ちが長いなら、その間に
   GraphQL を使わない作業（実装・検証・`git push` まで）を進めてから戻ってよい。
   Monitor/loop 等の能動ポーリング文脈では、sleep で滞留せず ScheduleWakeup
   （等のスケジュール手段）で reset 時刻以降の再開を予約してターンを返してよい。
4. `gh pr merge` の途中で拒否された場合は、リトライの前に**マージが実際どこまで進んだかを
   確認する**（GitHub 側は成功していて、CLI のレスポンス取得だけが失敗した可能性がある。
   盲目リトライは二重マージ・状態不整合のもと）。第一の判定は `git ls-remote origin main`
   の再読みと層2の base SHA の比較であり、SHA が進んでいれば成功である。補助的な REST 確認は
   次のとおり:

   ```bash
   gh api repos/<owner>/<repo>/pulls/<N> --jq '{state, merged}'
   ```

   `merged: true` ならマージ済み — リトライせず層3（着地後検証）へ進む。
5. **merge-slot を保持したまま長時間待たない**。リセットまでの待ちが 15 分を超えるなら、
   いったん `bd merge-slot release` して待ち、リセット後に acquire し直してから再試行する
   （slot を握ったまま待つと、他セッションのマージを丸ごと止める）。

### 5. マージ排他3層

並列セッションが同時に main へマージしてくること自体は（branch protection が無い環境では）
止められない。独立に CI 緑だった2本の PR が組み合わさると壊れる「意味的衝突」も CI では
捕まらない。3層で守る。層2は単独で機械的に効き、層1と層3は協調規律。

マージ手順のコマンド列は **1行連結（`cmd1; cmd2; ...`）にしない** — `;` はエラーで
止まらないため、途中の失敗（acquire の誤構文等）を素通りして後半の `bd close` まで
無条件実行された実例がある（failure-catalog.md の merge-chain-semicolon）。1コマンド
ずつ結果を確認して進めるか、スクリプト化するなら `set -euo pipefail` を付ける。

**層1 — 協調ロック（bd merge-slot）**: マージ作業を一度に1セッションへ直列化する。

```bash
bd merge-slot create    # プロジェクトで初回のみ（<prefix>-merge-slot bead が1個できる）
bd merge-slot acquire   # マージ手順の開始前
# ...層2・層3を含むマージ手順...
bd merge-slot release   # 完了後（失敗して撤退するときも必ず release）
```

bd を読むセッションには効くが、規約に従わないプロセスには効かない。だから層2が要る。

**層2 — マージ直前の CAS（必ずやる）**: CI 緑を確認した*後*、マージを実行する**直前**に
remote main が動いていないか突き合わせる:

```bash
git ls-remote origin main   # ← 手順3で控えた base SHA と比較
```

- 一致 → そのままマージ。
- 不一致（誰かが先にマージした）→ ブランチを update/rebase して CI を待ち直し、
  もう一度この CAS からやり直す。レース窓が「CI 待ちの数分」から「数秒」に縮む。

**層3 — 着地後検証を次のマージのゲートにする**: マージしたら main 上で検証してから
次の1本に進む:

```bash
gh pr merge --squash --delete-branch
git -C <メインチェックアウト> pull --ff-only
# → main 上で検証コマンド（コントラクトの verify）を実行し、緑を確認
```

`gh pr merge --squash --delete-branch` の exit status はマージ本体ではなくローカルブランチ
削除の後処理で非0になりうる。成否は exit status にも GraphQL 依存の `gh pr view` にも頼らず、
**常に** `git ls-remote origin main` を再読みして層2で控えた base SHA と比較する。SHA が進んで
いればマージ成功であり、後処理へ進む。GraphQL が死んでいる症状と重なると `gh pr view` 自身も
使えないため、これが最終的な判定手段である。

マージは worktree から打ち切る。メインチェックアウトは常時稼働サーバーを抱えるため、そこへ
作業を移す手順を増やすとサーバー停止や別ブランチ配信の事故面が広がる。worktree から実際に
壊れるのはブランチ削除の後処理だけで、マージ本体は成功する。上の SHA 判定と後述の remote
削除を手順化するほうが副作用が小さい。`git pull --ff-only` と着地後検証は従来どおりメイン
チェックアウトで行う。

独立に緑だった2本の意味的衝突は**ここでしか**捕まらない。squash マージなら壊れていても
revert 1発で戻せる。緑を確認するまで次の PR をマージしない。

### 6. close と掃除

マージ成功後（層3の検証まで済んでから）。**`bd close` の前に
[close-template.md](close-template.md) の書式で証拠コメントを残す**:

```bash
bd comment <id> "<close-template.md の4行: 検証 / PR・CI / レビュー / 未了>"
bd close <id>
git worktree remove .claude/worktrees/<id>
git branch -d bd/<id>          # squash マージ後は -D が必要なことがある
git remote prune origin
```

掃除はマージした本人の責務。残骸は全セッションの空き確認（規律2）を狂わせる。

**層3の `gh pr merge --delete-branch` はブランチ削除の後処理がまず失敗する — エラーが
指すブランチ名で2パターンを見分ける**。観測例ではいずれも squash マージ自体は GitHub 側で
成功していた（マージが失敗したように見えて実は成功している）。どちらのパターンでも慌てて
再マージせず、まず `git ls-remote origin main` を再読みして層2で控えた base SHA から進んだかを
確認する。進んでいればマージ済みである。`gh pr view` は GraphQL 依存で症状2と重なると使えない
ため、次は補助確認にとどめる:

```bash
gh pr view <N> --json state,mergedAt,mergeCommit   # state が MERGED ならマージ済み
```

どちらのパターンでも、remote ブランチが残っていないかを必ず確認する。残っていれば削除する:

```bash
git ls-remote origin refs/heads/bd/<id>   # 出力があれば remote に未削除で残っている
git push origin --delete bd/<id>
```

GraphQL 不通時は次の REST 削除を使う:

```bash
gh api repos/<owner>/<repo>/git/refs/heads/bd/<id> --method DELETE
```

- **エラーが PR 自身のブランチを指す**（`cannot delete branch 'bd/<id>' used by worktree
  at …`）— ローカルブランチが worktree に掴まれて消せない。PR #384 / bdboard-rccf
  （2026-09-05、main `d80e993` → `c1414cb`）ではマージ本体は成功していた。上記の掃除どおり
  worktree を削除してから `git branch -D bd/<id>` で完了する。
- **エラーが `main` を指す**（`failed to run git: fatal: 'main' is already used by
  worktree at '<メインチェックアウト>'`）— こちらは**remote ブランチの削除まで実行されず
  残る**のが既知パターンとの最大の違い。実測: PR #379 / bdboard-p5l.13（merge `dfb97f4`）・
  PR #380 / bdboard-p5l.21（merge `eef8df0`）、いずれも2026-09-05。どちらのパターンでも
  マージ成功を確認したら、上の remote 残存確認と手動削除を必ず行う。

  見落とすと `bd/<id>` が remote に残骸として蓄積する。原因は未検証の推定: `gh pr merge
  --delete-branch` はマージ成功後、ローカルブランチ削除の前に一旦デフォルトブランチ
  （main）へのチェックアウトを試みるらしく、PR 自身の worktree を cwd にして実行すると
  main が常にメインチェックアウト側で使用中のため worktree 競合で失敗し、後続の remote 側
  削除まで巻き込まれて実行されない、と考えられる。実測: bdboard-3tw.104.24（PR #62）・
  bdboard-p5l.10（PR #63）、2026-08-18（記録: bdboard-p5l.11）。

## セッション開始時の残骸掃除（SKILL.md 規律1 手順4）

マージ済み worktree の残骸があれば掃除する — `git worktree list` を一覧し、対応ブランチが
**既に main へ取り込まれているものだけ** `git worktree remove` する。**判断がつかないものは
触らない。** 残骸を放置すると規律2 の空き確認が「着手中」と誤読し続け、逆に生きている
worktree を消すと実行中の作業を壊す（failure-catalog.md の live-worktree-removal /
empty-worktree-misjudge）。remove の前に、他セッションがその中に居ないかを
`lsof -a -d cwd +D <worktree>` で確認する。

## 例外・補足

- マージは常に**一度に1本**。複数 PR が溜まっていても、1本ごとに層2→マージ→層3を回す。
- チケットに紐づかない探索作業は worktree/PR フローに載せず、プロジェクト規約の
  探索ブランチ（例: `spike/`）で行い、PR にしない。
- main 直コミットの可否は検証コントラクトの `prFlow`（3値の意味は冒頭の表）が第一の根拠。
  CI 復旧などの個別例外があるかは CLAUDE.md に従う。この skill から新しい例外を作らない。
