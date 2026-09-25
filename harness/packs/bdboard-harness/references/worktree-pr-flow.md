# per-ticket worktree + branch + PR フロー

1チケット = 1 worktree = 1ブランチ = 1 PR。main への直接コミットはしない。
この対応を崩すと、並列セッション間で「どの変更がどの作業か」が追えなくなり、
排他（SKILL.md 規律2）の前提も壊れる。

検証コマンド・PR の要否・main ブランチ名は、**(1) 注入先の検証コントラクト
`.claude/bdboard-harness.json` → (2) 無い/壊れていれば CLAUDE.md / AGENTS.md → (3) どちらにも
無ければ検証せずに進めない**（SKILL.md 規律4 手順1）の順で決める。

コントラクトのキーの意味（この節が正本。SKILL.md 側はここへのポインタ）:

| キー | 意味 |
|---|---|
| `verify` | 回して **exit 0 が合格**の検証コマンド |
| `prFlow` | `pr` = PR 必須 / `direct` = main 直コミット可 / `none` = git 手順を省く |
| `mainBranch` | rebase と、マージ直前 CAS（層2）の基準ブランチ名 |
| `merge`（任意） | マージ手順の段階。`mode` が `S0`（既定）/ `S1` / `S2`、`hotFiles` は S2 の hot file グロブ。§5「S1」「S2」参照 |

**(3) に落ちたときのエスカレーション**（この文言をそのまま使う）:

```bash
bd comment <id> "検証ループ未定義: このプロジェクトに検証コマンドの宣言がありません (.claude/bdboard-harness.json を作成してください)"
```

そのうえで **human ラベル＋human gate（SKILL.md 規律3 手順1–3）**を付け、回答を待たずに次の
チケットへ回る。検証コマンドが無いまま「たぶん通る」で PR を開かない。

コントラクトが持たない値（ブランチ命名・worktree 置き場・マージ方式）は従来どおり
CLAUDE.md / AGENTS.md が正。以下では既定の推奨としてブランチ `bd/<id>`、worktree
`.claude/worktrees/<id>/` と書く。main ブランチはコマンド中では `<mainBranch>`（検証コントラクトの
`mainBranch`、省略時 `main`）と書き、手順・規律の本文の「main」もこのブランチを指す。

## 規律2 の手順（全文）

SKILL.md 規律2 の手順の全文。本文には骨格だけを残している（brushup-protocol.md §7 の予算）。
手順番号は本文と同じ。

1. 空き確認は worktree とブランチの**両方**が「無い」こと。
2. **`git worktree add <path> -b <branch>` の成否が排他** — 失敗（既存）なら次の候補へ。
3. **成功して初めて `bd update <id> --claim`。** claim を worktree より先に打たない。
4. 実装前に既存実装を1回探す（`git grep -n` と `bd search --status in_progress` を各1回）。
5. **heartbeat は scripts/bd-heartbeat.sh で**（保持中の全チケット・寿命はセッション束縛）。失敗＝所有権喪失、直ちに停止。
   ただし **heartbeat は排他の最後の砦ではない** — bdboard の reclaim は `bd/<id>` ブランチか
   `.claude/worktrees/<id>` が残っているチケットを回収対象から外す（作業開始から 12 時間まで、
   かつ git を読めた巡回のみ。lease-params.md）。**この保護を当てにして heartbeat を切らさない**。
6. **負けたら**相手を戻さない・kill しない（成果は patch へ退避）。空の worktree を「放棄」
   と断定しない。

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
git -C <メインチェックアウト> worktree add .claude/worktrees/<id> -b bd/<id> origin/<mainBranch>
```

- `origin/<mainBranch>` 起点で作る（ローカルの main が古くても最新から始められる）。
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
git rebase origin/<mainBranch>
# → 検証コマンドをもう一度全部回す（テキスト上クリーンな rebase でも意味的衝突は残る）
git rev-parse origin/<mainBranch>   # ← この base SHA を控える（後述の直前CASで使う）
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

**`Closes: <id>` (bd チケット) と `Closes #N` (GitHub issue) は別物**。上のテンプレートの
`Closes: <id>` は bd チケット ID を指す社内の記法で、GitHub の closing keyword ではない
(コロン付き、`#` を使わない)。チケットの external-ref が `gh-<N>` のとき、対応する GitHub
issue を自動で閉じるには、PR 本文に別途 GitHub の closing keyword — `Closes #N` / `Fixes #N`
/ `Resolves #N` (大小文字無視) — を書く。閉じずに参照だけしたいとき (同じ issue の他チケットが
後で閉じる場合) は `Refs #N` を書く。1 つの issue に複数チケットがあるときは、最後にマージする
PR だけ `Closes #N`、それ以外は `Refs #N`。`npm run merge-pr -- prepare <N>` が、external-ref
が `gh-<N>` のチケットについてこれを機械的に確かめる (無ければ前提条件エラーで止める。bd が
読めないときは fail-open で警告のみ)。bdboard 固有の事故・exit code は
docs/GIT-WORKFLOW.md「PR 本文で external-ref の issue を閉じる」節。

**`gh pr checks <N> --watch` はネットワーク由来で exit 1 を返すことがある（CI失敗と誤読
しない）**: CI 自体は緑でも、`gh pr checks --watch` は GraphQL 呼び出しの読み込みタイムアウト
で異常終了し、その時点の一覧には一部チェックが pending のまま残ることがある（実測
2026-09-04、同一セッション内で3回発生）。見分け方: 出力末尾が `Post
"https://api.github.com/graphql": read tcp ...: read: operation timed out` で、個別チェックの
fail 行が無ければ通信断であって CI 失敗ではない。誤読して原因調査や再実装に時間を使わず、
`gh pr checks <N>`（`--watch` 無しで単発実行）をやり直せばよい（実測では再実行で全チェック
pass が返った。CI がまだ走行中なら pending が返るだけで、これも失敗ではない）。`--watch` を
張り直す場合は既定の 10 秒間隔のままにせず `--interval 30` 以上を付ける（下の GraphQL 枠の
節にある短間隔ポーリング禁止と同じ理由）。再実行しても失敗し続けるなら通信断ではなく実際の
障害の可能性があるので次項へ進む。

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
   python3 -c 'import json; open("create-pull.json", "w").write(json.dumps({"title": "<title>", "head": "<branch>", "base": "<mainBranch>", "body": "Closes: <id>\\n\\n<変更サマリ>"}, ensure_ascii=False))'
   ```

   merge-pull.json は `merge_method`、`commit_title`、`commit_message` を持たせる。REST の
   `PUT .../merge` 後も、マージ成否は CLI の終了 status ではなく層2で控えた SHA と
   `git ls-remote origin <mainBranch>` の再読みを比較して判定する（詳細は層3）。

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
   盲目リトライは二重マージ・状態不整合のもと）。第一の判定は `git ls-remote origin <mainBranch>`
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

**ゲート判定コマンドをパイプに通して `&&` で繋がない** — パイプの終了ステータスは末尾
コマンド（例: `tail`）のものになり、先頭コマンドの失敗を隠す。実例（2026-09-04）: `bd
merge-slot acquire 2>&1 | tail -2 && gh pr merge ...` を実行したところ、acquire 自体は
「slot held by: fable-chair-pkr6」で失敗していたのに `tail` の exit 0 で `&&` が通り、
スロット外マージ（PR #296）が発生した。`npm run verify ... | tail -N` の exit code を
verify 自身のものと誤読する事故も同日に別途発生している。同じ機序（ラッパー/パイプの
終了コードを検証コマンド自身のものと取り違える）の既知事故は failure-catalog.md の
verify-exit-masked（2026-08-29, PR #134。`npm run verify > log; echo EXIT=$?; tail log` の
セミコロン連結の変種）にも記録されている。対策: ゲートになるコマンドは (1) パイプせず
単独で実行して `$?` を見る、または (2) 出力をファイルへリダイレクトし直後に
`echo "EXIT=$?"` を取る。特に `bd merge-slot acquire` と検証コマンド（`npm run verify` 等）は
必ずこの形で実行する — 下の層1の例も単独実行を前提にしている。

**層1 — 協調ロック（bd merge-slot）**: マージ作業を一度に1セッションへ直列化する。

```bash
bd merge-slot create    # プロジェクトで初回のみ（<prefix>-merge-slot bead が1個できる）
bd merge-slot acquire   # マージ手順の開始前
# ...層2・層3を含むマージ手順...
bd merge-slot release   # 完了後（失敗して撤退するときも必ず release）
```

**waiters は参考情報 — 先頭待ちをしない**: `bd merge-slot acquire`（`--wait` 無し）の可否判定は
`status`（open/in_progress）のみで行われる（`acquire --help` の記述どおり）。`--wait` を付けると
`metadata.waiters` に自分のエントリが積まれるが、対応する waiter が実際に acquire・release
した後もエントリを自動で取り除く経路が無い（`release --help` は「status を open に戻し holder を
クリアする」と書くが、実測ではリリース後も `metadata.holder` が古い値のまま残ることがある —
フィールドの説明文を鵜呑みにせず `bd show <slot-id> --json` で実態を確認する）。よって
**`acquire --wait` は使わない**（順番は保証されず残骸を増やすだけ）。保持中（in_progress）なら
`bd merge-slot check` を数分おきに再実行し、**available になったら waiters の中身に関わらず
そのまま `acquire`（`--wait` 無し）する**（先頭待ちのポーリングを自作しない。mutual exclusion
自体は status が守るので二重取得は起きない）。実測（起票契機: 2026-09-19 深夜, bdboard-wadg /
PR #480 マージ時のキュー飛び観測。停滞事故: その約2時間後の2026-09-20 未明, 議長観測。詳細:
failure-catalog.md の merge-slot-waiters-stale）: 2026-09-04 以来の残骸3件に PR #480 マージ後の
自分のエントリが加わった計4件を先頭待ちの根拠にした2エージェントが、available な状態のまま
停滞し、議長の「available なら acquire せよ」という指示でようやく解消した。

**残骸 waiters の扱い**: waiters は 2026-09-20 時点で2週間超（2026-09-04〜）残存した実例がある。
掃除には `<prefix>-merge-slot` bead の `metadata.waiters` 書き換えが要るが、**全セッション共有の
状態を書き換える操作なのでこの skill からは自律実行しない** — 手順の文書化に留める:
(0) `bd merge-slot check` が available（holder が既に居ない状態）であることを確認してから行う
（保持中に行うと holder を巻き込みかねない）、
(1) `bd show <slot-id> --json` で現在の waiters を確認、
(2) 現在アクティブな PR/セッションに対応しない明らかに古いエントリを特定、
(3) 全エントリが古いなら `bd update <slot-id> --unset-metadata waiters` で一括除去する方が
`--metadata` での配列丸ごと置換より安全（`--metadata` の置換/マージ挙動は未確認）。一部だけ
残すなら `bd update <slot-id> --metadata '{"waiters": [<残す分だけの配列>]}'` を提示するが、
実行後に `bd show <slot-id> --json` で `holder` が意図せず消えていないか確認する、
(4) いずれもチャットで人間の承認を得てから実行する（不可逆・共有状態への書き込みは SKILL.md
規律3 手順7 の即時確認対象）。waiters の自動失効や acquire/release 時のエントリ除去など
bd 本体（上流ツール）側の改修が必要な部分は harness-upstream チケット（bdboard-c6wu）へ
切り出し済み（layering.md「アップストリーム経路」）。

bd を読むセッションには効くが、規約に従わないプロセスには効かない。だから層2が要る。

**層2 — マージ直前の CAS（必ずやる）**: CI 緑を確認した*後*、マージを実行する**直前**に
remote main が動いていないか突き合わせる:

```bash
git ls-remote origin <mainBranch>   # ← 手順3で控えた base SHA と比較
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
**常に** `git ls-remote origin <mainBranch>` を再読みして層2で控えた base SHA と比較する。SHA が進んで
いればマージ成功であり、後処理へ進む。GraphQL が死んでいる症状と重なると `gh pr view` 自身も
使えないため、これが最終的な判定手段である。

**main チェックアウトの作業ツリーが汚れていて着地後検証が赤くなることがある** —
原因をマージ回帰と決めつけない。検証コマンド（コントラクトの `verify`）は main
チェックアウトの**作業ツリー**を読むため、別セッションが未コミットの変更を残していると
（実例 2026-09-05: 正本 `harness/packs/bdboard-harness/SKILL.md` ではなく注入コピー
`.claude/skills/bdboard-harness/SKILL.md` を直接編集して未コミットのまま放置し、
`injected-pack-is-in-sync.test.ts` が content hash mismatch で失敗）、CI が緑のまま main 側の
検証だけ落ちる（実例 2026-09-05 / bdboard-kj4s: 直前にマージした PR #337 とは無関係だった）。
着地後検証が落ちたら、マージ回帰と決めつける前にまず main チェックアウトで確認する:

```bash
git -C <メインチェックアウト> status --porcelain   # 汚れているか
```

汚れていれば **他セッションの WIP を `git checkout --` で絶対に捨てない**。復旧手順:
(1) `git -C <メインチェックアウト> diff > <退避先>/<tag>.patch` で追跡ファイルの差分を
退避する。未追跡ファイルも含めて退避したいときの bare `git stash` / `git stash pop` は
hook（pre-bash-guard.sh）に拒否され、拒否メッセージは WIP コミットを勧めてくるが、これは
**他セッションの WIP であり自分が main へコミットしてよい理由にはならない**ので従わない —
`git stash push -u -m "<tag>"` を使い、直後に `git stash list --format='%H %gs'` で SHA を
控える（復元は `pop` ではなく `apply <sha>`）。(2) 発見をチケット化
（`bd create ... --deps discovered-from:<自分>`、退避先パスを本文に書く）。(3) `git checkout
-- <path>` で作業ツリーを戻す。(4) 再検証。ハーネスパックを編集するときは常に正本側
`harness/packs/` を編集し、注入コピーと同じ PR で両方を更新する（layering.md）ことが
そもそもの予防策。

**汚れを避けたいなら、着地後検証は「main のツリー」ではなく「PR ブランチの tip」で代用できる**
— 手順3の rebase で PR ブランチを検証コントラクトの `mainBranch` の最新 SHA に乗せておけば、
squash 後の main のツリーはブランチ tip のツリーと同一になる。マージ後に `git fetch origin`
して取得した `origin/<mainBranch>`（squash コミット）と PR ブランチ tip との
`git diff --stat` が空であることを確認すれば（ブランチ worktree 内だけで完結し、main
チェックアウトには一切触れない）、そのブランチ worktree で回した検証結果がそのまま着地後
ゲートの証拠として使える。rebase を省くとこの同一性が壊れるため、この代替を使うなら手順3の
rebase は必須（他セッションの WIP で main が汚れている状況でも、汚れに触れずに着地後ゲートを
満たせる）。

マージは worktree から打ち切る。メインチェックアウトは常時稼働サーバーを抱えるため、そこへ
作業を移す手順を増やすとサーバー停止や別ブランチ配信の事故面が広がる。worktree から実際に
壊れるのはブランチ削除の後処理だけで、マージ本体は成功する。上の SHA 判定と後述の remote
削除を手順化するほうが副作用が小さい。`git pull --ff-only` と着地後検証は原則メイン
チェックアウトで行う（メインチェックアウトが汚れている場合の代替は前掲のブランチ tip 検証）。

**注入先の契約に `alwaysOnServer` があるとき、サブエージェント（Agent ツールから起動された
セッション）からのメインチェックアウトでの `git pull` は hook 規則 7 が deny する**
（bdboard-hpu8。メインチェックアウトは常時稼働サーバーを抱え、pull → build → 再起動は議長の
仕事）。その場合は前掲のブランチ tip 検証で層3を満たし、メインチェックアウトの pull と再起動は
議長が `alwaysOnServer.restartScript` で行う。最終報告に「議長で再起動が必要（PR #N）」と書く。

独立に緑だった2本の意味的衝突は、main 上の着地後検証か前掲のブランチ tip 検証の**どちらか**
でしか捕まらない。squash マージなら壊れていても revert 1発で戻せる。緑を確認するまで次の
PR をマージしない。

#### S1 — 枠は CAS とマージの一瞬だけ握る（契約の `merge.mode` が `S1` のとき）

ここまでの層1〜3 の手順は `merge.mode` が `S0`（既定・省略時）の手順。`S0` では枠を
握ったまま rebase → CI 待ち → 着地後検証をするため、並列度が上がると枠の占有そのものが
律速になる（failure-catalog.md の merge-slot-held-through-ci: 11 時間中 7.6 時間）。
`S1` は手順をスクリプト化したプロジェクト（bdboard の `npm run merge-pr`）だけが宣言し、
3 層の中身を次のように置き換える。**どちらの手順で動くかは `<mainBranch>` に入っている
契約の `merge.mode` で決まる**（PR ブランチ側の古い値ではない。スクリプトは fetch 後の
`origin/<mainBranch>` の契約を読む）。

- **層1**: 枠の中は `acquire → git ls-remote（CAS）→ gh pr merge → release` だけ（数十秒）。
  rebase・CI 待ち・検証はすべて枠の外。`--wait` は使わない。**他人の枠は release しない** —
  空かなければ時間を置いて並び直し、握りっぱなしに見えるなら議長に報告する。
- **層2**: CAS の比較対象は「rebase 元」ではなく **PRED_BASE**（prepare が「この main の上に
  マージする」と記録した SHA）。S1 では PR head が PRED_BASE を含むとき（main 不動）だけ
  進み、main が進んでいれば枠の外で rebase → CI → prepare からやり直す（CAS 負けも同じ。
  rebase に直行せず prepare で分類し直す）。
- **層3**: 台帳は GitHub commit status（context は契約の `merge.statusContext`、既定
  `bdboard/landed-verify`）。**マージしたエージェント自身が PR worktree で**
  `git checkout --detach <着地した SHA>` → 検証コマンド → success / failure を記録する。
  main checkout に触れないので hook 規則 7 に当たらない。次の merger は PRED_BASE の台帳を
  ゲートにする: success なら進む / failure ならマージしない（下の「main が壊れたとき」）/
  pending か無しなら LEASE（`merge.leaseMinutes`、既定 8 分）まで待ち、過ぎていれば自分で
  検証して台帳を書く（自己修復。failure には適用しない）。
- **マージコマンドはスクリプトが印字し、エージェントが 1 回だけ実行する**（スクリプトの中で
  `gh pr merge` を打たない — 権限判定に拒否されたときにスクリプト経由で通すと迂回になる）。

```bash
npm run merge-pr -- prepare <N>   # 枠の外。PR / 必須チェック / main を確かめ PRED_BASE を記録
                                  #   exit 3 = main が動いた → rebase → push → CI → prepare から
npm run -s merge-pr -- gate <N>   # 層3 ゲート → acquire → CAS → stdout にマージ行を印字 (枠は保持)
gh pr merge <N> --squash --delete-branch --match-head-commit <head> --subject '<title> (#N)'  # 印字どおり
npm run merge-pr -- finish <N>    # 結果にかかわらず必ず打つ。枠を返す → 着地後検証 → 台帳
```

- 実行場所は **PR の worktree（linked worktree）**。main checkout では着地後検証を拒否する
  （detach すると常時稼働サーバーの配信物まで置き換わるため）。`-s` は npm の見出し行を stdout に
  出さないため（stdout はマージ行 1 行だけになる）。状態とログは git common dir の `bdboard-merge/`。
- 終了コード 75 は「並び直し」（CAS 負け・main が動いた・ls-remote 失敗・枠が空かない・CI pending・
  GitHub API に届かない）。prepare からやり直す。4 / 6 は main が壊れている（下記）。1 は実行
  できなかった（bd が使えない・作業ツリーが dirty・npm ci 失敗など。表示に従って直す。着地後検証を
  実行できなかったときは直してから `npm run merge-pr -- verify <sha>`）。
- 着地後検証の間は pending を LEASE の 1/3 ごとに更新し続ける（verify スロット待ちで長引いても
  他の merger が自己修復に走らない）。npm ci の失敗は環境要因とみなし failure と記録しない。
- `gh pr merge` が権限判定で拒否された / 409（head 不一致）でも **finish を打って枠を返す**
  （finish は REST の `merged` で成否を判定し、未マージなら枠を返して exit 5）。拒否の後は
  再試行・別経路をせず人間判断へ（SKILL.md 規律3）。
- 着地後検証が success なら、着地した木と PR head の木が同一かを finish が表示する（S0 の
  「ブランチ tip 検証」に相当。S1 では検証そのものを着地した木で行うので代用は要らない）。
- **main が壊れたとき**（台帳 failure・main の CI の verify/e2e が赤）: 見つけた者が枠を取って
  修復まで握る（finish は failure を記録すると自分で取る。これが唯一の長時間保持）→
  P0 バグを起票 → commit status の SHA 単位の履歴で最後の success と最初の failure を特定 →
  短時間で直せるなら fix-forward、それ以外は `git revert --no-edit <壊した squash SHA>` の PR →
  その PR は prepare → `gate <N> --repair`（台帳の failure を無視し、`… / main-broken <PRED_BASE 12 桁>`
  の枠を引き継ぐ）→ 印字行 → finish で入れる（finish は success のときだけ枠を返す）→ 壊した PR の
  チケットを再 open して理由を残す。`--repair` は P0 バグの修復 PR 専用。
  bdboard-gsnn 以降はこれを機械的にも強制する: `npm run merge-pr -- gate <N> --repair`
  は規則 9 (worktree 所有権保護) の対象で、修復 PR の worktree の持ち主以外の
  サブエージェントが実行すると deny される。実質的に `--repair` はその持ち主が、
  自分の worktree からだけ実行できる。
- 巻き戻し（S1 → S0）は契約の 1 行。gate 済みの PR があっても finish は動き、枠を返す。

#### S2 — rebase を省き、着地予定ツリーを手元で verify する（契約の `merge.mode` が `S2` のとき）

S2 は S1 の層2 だけを変える（gate / finish / 台帳は S1 のまま）。S1 では main が進んでいれば
常に rebase → push → CI やり直しだったが、その大半は衝突の無い「main が先に進んだだけ」
だった。S2 の prepare は main が進んだ PR を分類する:

| クラス | 条件 | prepare の動き |
|---|---|---|
| N | `origin/<mainBranch>` が PR head の祖先（main 不動） | S1 と同じ |
| R | merge-base が 1 個でない / `git merge-tree` がテキスト衝突か実行できない / main 側と自分の変更が同じ `merge.hotFiles` パターン（= 同じ種類の hot file）に当たる / GitHub が `mergeable: false` | exit 3。S1 と同じく rebase → push → CI → prepare |
| F | それ以外（衝突も hot file の衝突も無い） | `git merge-tree --write-tree origin/<mainBranch> HEAD` の木を `git commit-tree`（親 = PRED_BASE と PR head、push も ref 作成もしない）でコミットにし、**PR の worktree で** detach して契約の検証コマンドを回す。success → PRED_BASE と着地予定ツリーを記録して gate へ / failure → exit 3（R に格下げ） |

- **検証した木 = 着地する木**: squash マージの木は「その時点の main に PR head を 3-way マージした
  木」。gate の CAS（`ls-remote` == PRED_BASE、枠の中）が main を、`--match-head-commit` が head を
  固定するので、着地する木は prepare が検証した `merge-tree(PRED_BASE, head)` と同じになる — ただし
  **GitHub のマージと git の ort マージが一致する限り**（merge-tree は改名検出を git の既定値に固定して
  走らせ、利用者の gitconfig で木が変わらないようにする）。finish はその一致を測る: 着地した木と記録
  した木を比べて監査ログ `predicted-tree … match=` に残し、違えば警告する（判定は従来どおり着地後
  検証）。`gh pr merge` が 405 "not mergeable" なら GitHub だけが衝突と見ている — finish で枠を返し
  rebase する。
- ファイルの重なりは判定に使わない（重なりも merge-tree もテキストの判定で、意味的衝突は着地する
  木を検証しないと分からない）。hot file は種類ごとのグロブで、既定は依存（ルートと web の
  `package.json` / `package-lock.json`）・`.github/workflows/**`・検証設定（tsconfig / depcruise /
  verify スクリプト / vite / vitest / 契約ファイル）・`SKILL.md`（正本と注入コピー）。契約の `merge.hotFiles` を書くと既定を丸ごと置き換える。
- 終了コードは S1 に加えて: `3` = 着地予定ツリーの検証 failure（ログを読み、既知のフレークと言える
  ときだけ prepare し直す）、`75` = 検証の間に main が動いた、`1` = 検証を実行できなかった、`4` =
  PRED_BASE の台帳が既に failure（壊れた main の上で検証しない。修復 PR は `git merge
  origin/<mainBranch>` でクラス N にしてから `gate --repair`）。どれも枠と台帳に触れず、prepare の
  記録は検証を始める前に消す（古い記録で gate に進ませない）。`git merge-tree --write-tree` は
  git 2.38 以上が要る（古い git では main が動いた PR がすべて R になる）。
- クラス F の prepare は検証コマンドを丸ごと回すので数分かかる。フォアグラウンドで長いタイムアウトで
  待つ。中断されて detach のまま残ったら prepare が `git checkout <ブランチ>` を案内する。
- `prepare <N> --dry-run` はどのモードでも S2 の分類を「参考」として表示する（検証も記録もしない）。
  切り替えの前の見積もりに使う。
- 切り替え・巻き戻し（S2 ⇄ S1）は契約の 1 行。main が S1 なのにクラス F の記録で gate すると 75 で
  prepare からやり直させる。S2 対応前のスクリプトを持つ古いブランチは `S2` を未知のモードとして
  拒否する（exit 1）ので `git merge origin/<mainBranch>` してから使う。1 日に revert 2 回・着地予定
  ツリーが通った PR の着地後検証 failure・監査ログの `predicted-tree … match=false` のどれかで S1 に戻す。

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
**常時稼働サーバーの再起動は掃除に含めない** — 契約に `alwaysOnServer` がある注入先では
議長だけが `restartScript` で行う（hook 規則 7 がサブエージェントの pull / start / kill を
止める）。サブエージェントは最終報告で再起動が必要な旨を伝えて終える。

**層3の `gh pr merge --delete-branch` はブランチ削除の後処理がまず失敗する — エラーが
指すブランチ名で2パターンを見分ける**。観測例ではいずれも squash マージ自体は GitHub 側で
成功していた（マージが失敗したように見えて実は成功している）。どちらのパターンでも慌てて
再マージせず、まず `git ls-remote origin <mainBranch>` を再読みして層2で控えた base SHA から進んだかを
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
