# failure-catalog — 既知ハーネス失敗の照合台帳

このプロジェクトで実際に起きたハーネス失敗の全量索引。目的は**二度目を防ぐこと**:

- **事故多発領域に入る前に該当カテゴリを一瞥する**（並列一括着手 → 「排他・worktree」、
  マージ → 「マージ・PR」、worktree 掃除・サーバー操作 → 該当節、パック/skill の編集 →
  「多層ハーネス・配布」、の要領）。
- 失敗が起きたら、まずここと照合する。既知の再発なら「ルールがあるのに防げなかった」
  = brushup-protocol.md §2 の分類 D（またはルールの置き場所の問題）として扱う。

エントリの書式（1件5行以内。長い分析は本則側へ）:

```
### <slug> — <一行症状>（<日付>）
- 原因: <根本原因を一行で>
- 防止: <再発防止ルールを一行で>（本則: <所在>）
- 出典: <bd チケットID / bd memory キー / 記録場所>
```

日付が特定できない事故は（<日付>）を省略してよい（出典から辿れることを優先する）。

## 排他・worktree

### worktree-double-claim — 同一チケットを2セッションが二重着手し、同じファイル群を書き合った（2026-08-16）
- 原因: claim（bd）は同一 assignee 間で排他にならず、worktree 作成前の open 状態が bd ready に見え続けた
- 防止: 排他の正本は `git worktree add` の成否。着手前に worktree とブランチ両方の不存在を確認（本則: SKILL.md 規律2）
- 出典: bdboard-3tw.104.4 / bd memory `bdboard-concurrent-session-claim-race`, `bdboard-worktree-not-abandoned`

### nested-worktree — 並列一括着手で worktree が別 worktree の内側にネストして作られた（2026-08-17）
- 原因: 2本目の `git worktree add` を、cwd が1本目の worktree 内のまま相対パスで実行した
- 防止: 一括作成では毎回 `git -C <メインチェックアウト>` 形式で実行（本則: worktree-pr-flow.md §1）。発見時は**内側から先に** remove（外側から消すと内側の作業ごと破壊）
- 出典: bdboard-3tw.102.4 in .110 / bd memory `bdboard-2026-08-17-nested-worktree-102.4-in-110`

### live-worktree-removal — 実行中プロセスの残る worktree を削除し、シェルが CPU 1コアを102分専有（2026-08-15）
- 原因: 掃除前に worktree を cwd に持つ生存プロセスを確認しなかった
- 防止: remove 前に `lsof -a -d cwd +D <path>`。何か居たら触らない（本則: CLAUDE.md「Cleanup after merge」）
- 出典: bdboard-3tw.61 / グローバル lessons-learned.md（aimix孤児プロセスの節）

### empty-worktree-misjudge — 空 worktree を「放棄」と断定して着手し、起動直前の別セッションと衝突（2026-08-16）
- 原因: git status 空・lsof 空・open のままの3条件でも「作成直後・起動前」の瞬間と区別できない
- 防止: lease 失効＋猶予経過＋updated_at の鮮度まで揃え、触る直前に lsof を取り直す（本則: SKILL.md 規律2 手順6, lease-params.md）
- 出典: bd memory `bdboard-worktree-not-abandoned`

### heartbeat-partial — アクティブな1枚だけ heartbeat し、保持中の他チケットが reclaim された（8並列運用中に実測）
- 原因: gate 待ち・委譲待ちで並行保持しているチケットを延命対象から外した
- 防止: 全 in-flight チケットへ同周期で一括 heartbeat（本則: SKILL.md 規律2 手順4）
- 出典: bdboard-3tw.99 / bdboard-l1t.4

## マージ・PR

### merge-slot-misclaim — merge-slot bead を「最優先の着手可能チケット」として claim し、他セッションのマージを停止（実測）
- 原因: slot bead は「空き = open・priority 0」で状態表現するため素の `bd ready` の先頭に載る
- 防止: `bd ready --exclude-label gt:slot` を常用（本則: SKILL.md 規律1 手順4）
- 出典: bdboard-9k3

### merge-chain-semicolon — マージ手順の1行連結で acquire 失敗後も `;` 区切りの後半（bd close 含む）が無条件実行された（2026-08-16）
- 原因: `bd merge-slot acquire` の誤構文（slot 名を引数に渡すと unknown command）＋ `;` はエラーで止まらない
- 防止: マージ手順は1行連結にせず1コマンドずつ（または `set -euo pipefail` スクリプトで）実行し、close はマージ成功後にのみ到達させる（本則: worktree-pr-flow.md §5）
- 出典: bd memory `bdboard-merge-slot-syntax`

### ci-webhook-drop — GitHub 障害中の force-push で CI が起動せず、pending と誤認して待ち続けた（2026-08-17）
- 原因: 障害中は webhook の synchronize イベントが無言でドロップされ、check-suite 自体が生成されない
- 防止: check-runs/check-suites の REST 照会で「未起動」を判別し、空コミットで再トリガー（本則: worktree-pr-flow.md §4）
- 出典: グローバル lessons-learned.md（webhook dispatch の節）

### graphql-quota-exhaustion — 3並列レーンの CI 監視ポーリングで GraphQL 枠が枯渇し `gh pr create` が失敗（2026-08-18）
- 原因: gh の PR 系コマンドはアカウント単位の GraphQL 枠を消費し、短間隔 watch が枠を食い潰した
- 防止: ポーリングは30秒以上間隔・複数 PR は1本の監視ループへ集約・枯渇時は REST で状態確認（本則: worktree-pr-flow.md §4）
- 出典: bdboard-p5l.10

## サーバー・ポート

### pkill-collateral — worktree のテストプロセスを狙った `pkill -f 'tsx.*src/main.ts'` が常時稼働サーバーも巻き添えにした（2026-08-15）
- 原因: パターンマッチ kill はメインチェックアウトと worktree のプロセスを区別できない
- 防止: pkill/killall 等のパターンマッチ kill 禁止。PID を特定して kill。委譲ブリーフにも毎回明記（本則: CLAUDE.md「Always-On Local Hosting」）
- 出典: bd memory `bdboard-2026-08-15-src-main-ts-sigterm`

### health-check-false-negative — `curl -f` が 401 で失敗し「サーバー停止」と誤認、二重起動を試みた（2026-08-16）
- 原因: -f はステータス区別を隠す。401 でもリスナーは生きている（現行仕様ではローカル直アクセスは 200 が正常 — 401/503 なら停止ではなく Host/proxy の分類を調査。本則参照）
- 防止: `-w '%{http_code}'` でコード判定＋`lsof` でリスナー確認。000/exit 7 だけが停止（本則: CLAUDE.md「Always-On Local Hosting」）
- 出典: bd memory `bdboard-health-check-401`, `bdboard-health-check-401-false-negative`

### worktree-preview-start — worktree から `preview_start` を実行し、本体ポート 8787 で別ブランチの stale UI が配信された（2026-08-29, 再現 2/2）
- 原因: launch.json は全 worktree に存在し、cwd 側の `src/main.ts` と `web/dist` が使われる。ステータスコードでは検出不能
- 防止: worktree から preview_start 禁止。起動はメインチェックアウトへ cd してから（本則: CLAUDE.md「Never call preview_start from a worktree session」）
- 出典: CLAUDE.md 該当節（実測記録つき）

## 検証・ビルド

### verify-storm — 6並列の `npm run verify` が自己増幅し load average 190–258 が数時間継続（2026-08-18）
- 原因: 実行ごとの worker 上限では投入数の増加を止められない
- 防止: verify は機械式スロット（最大2並列）内蔵の `npm run verify` のみ使用。`verify:steps` 直叩き禁止（本則: CLAUDE.md「Verify slots」）
- 出典: bdboard-d48（前提: bdboard-255, bdboard-kia）

### wrong-node-version — シェルスナップショットの nvm 不全で意図しない Node により npm install が lockfile を書き換えた
- 原因: `NVM_DIR` 欠落で `.zshrc` の `nvm use` が無言で失敗し、古い Node が PATH に残る
- 防止: 依存インストール前に `node --version` を engines.node と突き合わせる（本則: worktree-pr-flow.md §2）
- 出典: bdboard-hmj

## 委譲・検証

### codex-zero-edit — Codex 実装委譲が 0 編集のまま「委譲しました」と申告（約1/3の頻度で発生）
- 原因: Codex が読む AGENTS.md に議長向け委譲方針が混線し、自分に誤適用して何も編集しない
- 防止: 「0編集＋委譲文言＋異常に短い latency」の3点が揃ったら1回だけリトライ、2連続で failed（本則: verification.md）
- 出典: bdboard-p5l.9

### diff-against-moving-main — `git diff origin/main` が他セッションのマージ分を「自分の削除」に見せ、無実の成果物を捨てかけた（2026-08-16）
- 原因: 並列運用では origin/main が動く的になり、素の diff は他人の追加を自分の削除として表示する
- 防止: diff は必ず merge-base 基準（`git diff $(git merge-base HEAD origin/main)`）で読む（本則: verification.md）
- 出典: bdboard-3tw.104.4 / グローバル lessons-learned.md

## 多層ハーネス・配布

### injected-copy-edit — ハーネス改善を注入コピー側（.claude/skills/）に書き、パック正本（harness/packs/）に反映し損ねかけた（2026-08-29, ニアミス）
- 原因: bdboard repo には正本と注入コピーの両方が存在し、Claude Code が読むのはコピー側なので、編集対象として自然にコピーを選んでしまう
- 防止: 編集前に層を判定（`harness/packs/` の有無 → bdboard repo なら正本を編集し同 PR でコピーへ反映。注入先ならコピー編集禁止）（本則: layering.md）
- 出典: 本 skill 導入セッション（2026-08-29）。マージ前レビューの過程で検出

## bd 操作・確認待ち

### blocking-chat-question — ユーザーへの質問をチャットで投げて回答待ちし、セッション全体が停止（実測）
- 原因: 確認待ちを台帳に載せる手段を使わず、同期の質問にした
- 防止: bd comment + human ラベル + human gate に載せて次のチケットへ進む（本則: SKILL.md 規律3）
- 出典: SKILL.md 規律3 の動機事例

### dep-instead-of-gate — 確認待ちを `bd dep add` で表現しようとして既存の discovered-from 辺と衝突・失敗（bd 1.2.1 実測）
- 原因: bd は同じ向きの2者間に複数タイプの辺を持てない
- 防止: 確認待ちは `bd gate create --type=human`（別ノードへの blocks 辺なので既存来歴と衝突しない）（本則: SKILL.md 規律3 手順3）
- 出典: bdboard-axl

### bd-init-overwrite — 別マシンの `bd init` が AGENTS.md 管理ブロック内のカスタマイズ（gt:slot 除外等）を黙って戻し、main へ直接コミットした（2026-08-17）
- 原因: bd init はマーカー内を毎回テンプレートで再生成し、チェックアウト中のブランチへ autocommit する
- 防止: bd init は main 以外で実行し、`git diff -- AGENTS.md` のチェックリスト確認を経てから commit（本則: CLAUDE.md「bd init Re-runs」）
- 出典: bdboard-ejz（背景: bdboard-9k3）

### bare-dolt-push — Dolt レイヤーに残っていた public 向け remote により、bare push が私的チケット履歴を公開リポジトリへ漏らす寸前だった（2026-08-17）
- 原因: config.yaml の sync.remote 無効化では、既に登録済みの Dolt レイヤー remote は消えない
- 防止: 常に `bd dolt push --remote legacy`。bare push 前は `bd dolt remote list` で origin 不在を確認（本則: CLAUDE.md「.beads/ Dolt sync」）
- 出典: bdboard-jb1（背景: bdboard-23v）
