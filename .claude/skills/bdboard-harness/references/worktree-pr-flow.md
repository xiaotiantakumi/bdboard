# per-ticket worktree + branch + PR フロー

1チケット = 1 worktree = 1ブランチ = 1 PR。main への直接コミットはしない。この対応を崩すと
「どの変更がどの作業か」が追えなくなり、排他（SKILL.md 規律2）の前提も壊れる。操作の実体は
スクリプト（下の表）に寄せてあり、この文書は「いつ・どれを呼ぶか」と、スクリプトで防げない判断だけを持つ。

| 段階 | スクリプト | 誰が | 場所 |
|---|---|---|---|
| 着手（worktree 作成 → claim） | `scripts/start-ticket.py --spec <json>` | 議長 | メインチェックアウト（worker は isolation で worktree をもらうので呼ばない） |
| PR 作成（verify → push → PR → `PR:` コメント → auto-merge） | `scripts/open-pr.py --spec <json>` | worker・議長 | チケットの worktree |
| 確認待ち gate | `scripts/ask-human-gate.py --spec <json>` | worker・議長 | どこでも |
| 確認チケット | `scripts/post-review-ticket.py --spec <json>` | worker・議長 | どこでも |
| close と掃除 | `scripts/close-ticket.py --spec <json>` | 議長 | メインチェックアウト |

どれも `--help` でキーと制約が読め、`--dry-run` で副作用なしに確認できる。違反は `ERROR: spec.<path>: <理由>`
を全件出して非 0 終了し、副作用は検査の後だけ。手で同じ操作を打たない（欠落を機械で防ぐ入口だから）。

## 検証コントラクト `.claude/bdboard-harness.json`

検証コマンド・PR の要否・main ブランチ名は、**(1) 注入先の契約 → (2) 無い/壊れていれば CLAUDE.md /
AGENTS.md → (3) どちらにも無ければ検証せずに進めない**（SKILL.md 規律4）の順で決める。

| キー | 意味 |
|---|---|
| `verify` | フル検証。exit 0 が合格。PR 前には回さない（CI が唯一のフル実行場所） |
| `verifyQuick`（任意） | PR 前の軽い検証。`open-pr.py` が読む。既定 `npm run verify:quick` |
| `commitCheck`（任意） | コミットメッセージ検査。`{range}` が `origin/main..HEAD` になる。既定 `npm run check:commits -- --range {range}` |
| `prFlow` | `pr` = PR 必須 / `direct` = main 直コミット可 / `none` = git 手順を省く |
| `mainBranch` | PR の基準ブランチ名（省略時 `main`） |
| `merge`（任意） | `mode` は `S0`（GitHub auto-merge）。`S1`/`S2` は廃止（§5） |

(3) に落ちたら `bd comment <id> "検証ループ未定義: このプロジェクトに検証コマンドの宣言がありません (.claude/bdboard-harness.json を作成してください)"`
を残し、human gate（規律3）を付けて次のチケットへ回る。「たぶん通る」で PR を開かない。

ブランチ命名・worktree 置き場は CLAUDE.md / AGENTS.md が正。既定は `bd/<id>` と `.claude/worktrees/<id>/`。

## 規律2 の手順（全文）

手順番号は SKILL.md 本文と同じ。

1〜3. `start-ticket.py`（メインチェックアウトで）。worktree とブランチの両方が無いことの確認 →
   `git worktree add -b`（成否が排他。失敗 = 次の候補へ）→ 成功後だけ claim。
4. 実装前に既存実装を1回探す（`git grep -n` と `bd search --status in_progress` を各1回）。
5. **heartbeat は scripts/bd-heartbeat.sh で**（保持中の全チケット・寿命はセッション束縛）。失敗＝所有権喪失、直ちに停止。
   reclaim は `bd/<id>` ブランチか worktree が残るチケットを回収対象から外す（作業開始から 12 時間まで）が、
   **この保護を当てにして heartbeat を切らさない**（lease-params.md）。
6. **負けたら**相手を戻さない・kill しない（成果は patch へ退避）。空の worktree を「放棄」と断定しない。

## ライフサイクル

```
空き確認 → worktree作成(=排他獲得) → claim → 実装(+heartbeat) → 軽い検証
→ push → PR → auto-merge 有効化 → (CI green で GitHub がマージ) → deploy → close → 掃除
```

### 1. 空き確認と worktree 作成（排他獲得）

なぜ git が排他を裁くか: 並列セッションは同じ assignee で動くので `bd update --claim` は先行 claim を検出できず
両方成功しうる。`git worktree add -b` は既存ブランチ/worktree があれば拒否するので先着1名だけが成功する。
`start-ticket.py` がこの順序（git → 成功後だけ claim → `bdboard.complexity` 記録）を固定する。

- 成功 = 排他獲得。stdout 最終行が worktree の絶対パス。終了コード 2（ブランチ/パス既存）= 他セッションが着手中。claim せず別チケットへ。
- linked worktree の中からは拒否する → ネストを防ぐ（failure-catalog.md の nested-worktree）。

### 2. worktree 内でのセットアップと実装

- **`npm install` の前に `node --version` を `package.json` の `engines.node` と突き合わせる。** ハーネスの
  シェルが `nvm use` に無言で失敗し、意図しない Node が PATH に残る既知バグがある（bdboard-hmj）。合わなければ
  正しい Node の `bin` を PATH の先頭に通してからやり直す。根本原因の修正は対象外。依存は worktree 間で共有されない。
- 実装前の既存実装探索（規律2 手順4）: 見つかった既存ヘルパーは再利用して `bd comment <id> "再利用: <path>"`。
  同じ領域を触る in_progress チケットがあれば双方にコメントし `bd dep add <自分> <相手> --type related`
  （根拠: failure-catalog.md の duplicate-helper-parallel）。
- **worktree からポートを掴む常駐プロセス（dev サーバー等）を起動しない。** 衝突すると本体側を巻き込む。
  テスト・型チェック・lint は並列 worktree で問題ない。
- **`.beads/` 配下を PR ブランチ内で変更しない**（台帳の同期は Dolt 側。`open-pr.py` が diff にあれば拒否する）。

### 3. 軽い検証（フル検証は CI に任せる）

2026-10-22 のユーザー決定（bdboard-415t）以降、PR 前は**型チェック + lint + 触った範囲のテスト**だけ。
契約の `verifyQuick`（`open-pr.py` が実行）と、触った範囲の `npx vitest related --run <変更ファイル>`（落ちても push は止めない）。
フル `verify` は PR 前に回さず、rebase と再検証も不要（衝突は GitHub の mergeable 判定、意味的衝突は main の push CI が拾う）。
`prFlow` が `direct` / `none` で CI が無いときだけフル検証を回す。

### 4. PR 作成

`python3 .claude/skills/bdboard-harness/scripts/open-pr.py --spec <spec.json>`（キーと検査は `--help`）。
verifyQuick → push → `gh pr create`（本文は `Closes: <id>` 始まり）→ `bd comment <id> "PR: <url>"` → low/med は
auto-merge、high は議長待ち。手で `gh pr create` を打たない。PR を開いた時点では close しない（規律4）。

**`Closes: <id>`（bd チケット）と `Closes #N`（GitHub issue）は別物。** 前者は社内記法で GitHub の closing keyword
ではない。チケットの external-ref が `gh-<N>` のとき、issue を閉じるには PR 本文に別途 `Closes #N` / `Fixes #N` /
`Resolves #N` を足す。閉じずに参照だけなら `Refs #N`。1 つの issue に複数チケットがあるなら最後にマージする PR だけ `Closes #N`。
（`open-pr.py` はこの `gh-<N>` 規則を検査しない。`npm run merge-pr -- prepare` を使う構成では機械で確かめられる。）

CI 待ちで GitHub 側が不安定なとき（いずれもスクリプト化していない。事例は failure-catalog.md）:

- **`gh pr checks <N> --watch` の exit 1 は通信断のことがある**（末尾が `Post "https://api.github.com/graphql": ... timed out` で個別の
  fail 行が無い）。CI 失敗と読まず `gh pr checks <N>` を単発でやり直す。`--watch` は `--interval 30` 以上。
- **`gh pr checks`/`gh pr view` が 503 等で落ち続けるなら REST に切り替える**:
  `gh api repos/<owner>/<repo>/pulls/<N>`、`.../commits/<sha>/check-runs`、`.../commits/<sha>/check-suites`、`.../actions/runs?branch=<b>`。
  対象 SHA の check-suite が無く GitGuardian 等しか並ばないなら、CI が起動していない（webhook 取りこぼし）。
  空コミットで再 push すれば復旧する（failure-catalog.md の ci-webhook-drop）。
- **GraphQL rate limit**（`API rate limit already exceeded`）: `git push` は無関係なのでブランチは remote にある。reset を待たずに
  PR 操作を REST（`gh api repos/<owner>/<repo>/pulls --method POST --input <json>`、`pulls/<N>/merge`、`git/refs/heads/<b>` の DELETE）へ
  切り替える。JSON は `-f` でなくファイル経由（日本語・改行が壊れる）。`gh api rate_limit` が満タン表示でも起きる（他セッションの並行消費や
  secondary limit）。短間隔ポーリング（30 秒未満）と PR ごとの個別 watch は枠を食うので避ける（failure-catalog.md の rate-limit 項）。
- `gh pr merge` が途中で拒否されたら、リトライ前に `git ls-remote origin <mainBranch>` の SHA が進んだかで成否を確かめる（盲目リトライ禁止）。

### 5. マージ（`merge.mode: S0` = GitHub auto-merge）

PR を作ったら auto-merge を有効にする（`open-pr.py` が low/med で自動で打つ。手で打つなら `gh pr merge <N> --auto --squash --delete-branch`）。

- **複雑度 low/med**: worker が PR 作成の直後に有効化する。
- **複雑度 high**: worker は `PR:` コメントで止まる。議長が diff を読み（モデルレビューを挟むかは議長判断）、問題なければ議長が上のコマンドを打つ。
- GitHub は required checks が緑になった時点でマージする。赤なら同じブランチに修正を push する（auto-merge は有効のまま）。
- マージ後は議長が常時稼働サーバーを作り直し（bdboard: `always-on-server.sh deploy`）、それから §6 の close。
- **main の push CI が赤になったら**: 小さければ fix-forward、そうでなければ `git revert --no-edit <squash SHA>` の PR を auto-merge で入れる。
- 知って捨てたもの: branch protection の strict が off なので、古い main の上でそれぞれ緑だった 2 本が組み合わさって壊れうる（main の push CI が拾う）。
- ゲート判定コマンドをパイプに通して `&&` で繋がない／コマンド列を `;` で連結しない（途中の失敗を素通りして `bd close` まで走る。
  failure-catalog.md の merge-chain-semicolon・verify-exit-masked）。close は `close-ticket.py` が MERGED を検査してから動く。

**旧手順（merge-slot の層1〜3、`merge.mode` が `S1`/`S2`）は廃止。** 新しいマージでは従わない。`npm run merge-pr` のコードが
残る間の設計と終了コードは docs/GIT-WORKFLOW.md、全文は git 履歴（パック 0.x の本ファイル §5）。コードの削除は後続チケットで行う。

### 6. close と掃除

マージ成功後（auto-merge が着地させてから。§5）に議長が `python3 scripts/close-ticket.py --spec <json>`（メインチェックアウトで）。
MERGED・main 到達・worktree 未使用を検査してから `PR:` 証拠コメント → `bd close` → worktree 削除・`branch -D`・`git remote prune origin`。
検証/レビュー行を足すなら先に [close-template.md](close-template.md) の書式で `bd comment` する。

**常時稼働サーバーの再起動は掃除に含めない**（契約に `alwaysOnServer` がある注入先では議長だけが `restartScript` で行う）。
サブエージェントは最終報告で再起動が必要な旨を伝えて終える。

`gh pr merge --delete-branch` の後処理は失敗しやすいが、マージ本体は成功していることが多い（エラーがブランチ `bd/<id>` を指す =
worktree に掴まれて消せない、`main` を指す = remote ブランチの削除まで実行されず残る）。慌てて再マージせず `git ls-remote origin <mainBranch>` で
SHA が進んだかを確認し、`close-ticket.py` で掃除する。remote に `bd/<id>` が残ったら `git push origin --delete bd/<id>`
（GraphQL 不通なら `gh api repos/<owner>/<repo>/git/refs/heads/bd/<id> --method DELETE`）。

## セッション開始時の残骸掃除（SKILL.md 規律1 手順4）

`git worktree list` を一覧し、対応ブランチが**既に main へ取り込まれているものだけ** `git worktree remove` する。
**判断がつかないものは触らない。** 放置すると規律2 の空き確認が「着手中」と誤読し続け、逆に生きている worktree を消すと
実行中の作業を壊す（failure-catalog.md の live-worktree-removal / empty-worktree-misjudge）。remove の前に
`lsof -a -d cwd +D <worktree>` で他セッションがその中に居ないかを確認する。

## 例外・補足

- チケットに紐づかない探索作業は worktree/PR フローに載せず、プロジェクト規約の探索ブランチ（例: `spike/`）で行い PR にしない。
- main 直コミットの可否は契約の `prFlow` が第一の根拠。CI 復旧などの個別例外は CLAUDE.md に従う。この skill から新しい例外を作らない。
