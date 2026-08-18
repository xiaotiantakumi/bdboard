# per-ticket worktree + branch + PR フロー

1チケット = 1 worktree = 1ブランチ = 1 PR。main への直接コミットはしない。
この対応を崩すと、並列セッション間で「どの変更がどの作業か」が追えなくなり、
排他（SKILL.md 規律2）の前提も壊れる。

プロジェクト固有の値（ブランチ命名・worktree 置き場・検証コマンド・マージ方式・
main ブランチ名）は注入先プロジェクトの CLAUDE.md / AGENTS.md が正。以下では既定の推奨として
ブランチ `bd/<id>`、worktree `.claude/worktrees/<id>/`、main ブランチ `main` と書く。

## ライフサイクル

```
空き確認 → worktree作成(=排他獲得) → claim → 実装(+heartbeat) → 検証
→ rebase → 再検証 → PR → CI green → マージ排他3層 → マージ → close → 掃除
```

### 1. 空き確認と worktree 作成（排他獲得）

SKILL.md 規律2 のとおり。worktree とブランチの**両方**の不存在を確認してから:

```bash
git -C <メインチェックアウト> fetch origin
git -C <メインチェックアウト> worktree add .claude/worktrees/<id> -b bd/<id> origin/main
```

- `origin/main` 起点で作る（ローカル main が古くても最新から始められる）。
- 成功 = 排他獲得。失敗（ブランチ/パス既存）= 他セッションが着手中。別チケットへ。
- 成功したら `bd update <id> --claim`。

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
- **worktree からポートを掴む常駐プロセス（dev サーバー等）を起動しない。** ポートは
  メインチェックアウトの常設サーバーのものというプロジェクトが多く、衝突すると本体側を
  巻き込む。テスト・型チェック・lint はポートを掴まないので並列 worktree で問題なく走る。
- 実装中は `bd heartbeat <id>` を打ち続ける（lease-params.md）。
- **`.beads/` 配下を PR ブランチ内で変更しない。** 台帳の同期は Dolt 側
  （`bd dolt push/pull`）が担い、コード PR の diff に混ぜない。

### 3. 検証 → rebase → 再検証

プロジェクト規約の検証コマンド（フルの検証チェーンがあるならそれ）をローカルで緑にして
から PR を開く。その直前に:

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

実例・より詳しい教訓: グローバル orchestration skill の `reference/lessons-learned.md`
「GitHub Actionsのwebhook dispatchが障害中に無言で失われる（bdboard, 2026-08-17）」。

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

**GraphQL 枠が実際に枯渇したら**（`GraphQL: API rate limit already exceeded ...`）:

1. **`git push` は影響を受けていない**。`gh pr create` が枯渇で失敗しても、ブランチは
   既にリモートに存在している — 復旧は `gh pr create` のリトライだけでよく、worktree や
   ブランチの作り直しは不要。状態確認だけなら、上の 503 障害時の REST コマンド群も
   core 枠なのでそのまま使える。
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
4. `gh pr merge` の途中で枯渇した場合は、リトライの前に**マージが実際どこまで進んだかを
   REST で確認する**（GitHub 側は成功していて、CLI のレスポンス取得だけが失敗した
   可能性がある。盲目リトライは二重マージ・状態不整合のもと）:

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
捕まらない。3層で守る。層2は単独で機械的に効き、層1と層3は協調規律:

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
# → main 上でプロジェクト規約の検証コマンドを実行し、緑を確認
```

独立に緑だった2本の意味的衝突は**ここでしか**捕まらない。squash マージなら壊れていても
revert 1発で戻せる。緑を確認するまで次の PR をマージしない。

### 6. close と掃除

マージ成功後（層3の検証まで済んでから）:

```bash
bd close <id>
git worktree remove .claude/worktrees/<id>
git branch -d bd/<id>          # squash マージ後は -D が必要なことがある
git remote prune origin
```

掃除はマージした本人の責務。残骸は全セッションの空き確認（規律2）を狂わせる。

## 例外・補足

- マージは常に**一度に1本**。複数 PR が溜まっていても、1本ごとに層2→マージ→層3を回す。
- チケットに紐づかない探索作業は worktree/PR フローに載せず、プロジェクト規約の
  探索ブランチ（例: `spike/`）で行い、PR にしない。
- CI 復旧などプロジェクトが明示的に許す main 直コミット例外があるかは CLAUDE.md に従う。
  この skill から新しい例外を作らない。
