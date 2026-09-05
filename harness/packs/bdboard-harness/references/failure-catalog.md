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
- 防止: 全 in-flight チケットへ同周期で一括 heartbeat（本則: SKILL.md 規律2 手順5）
- 出典: bdboard-3tw.99 / bdboard-l1t.4（鏡像: heartbeat-orphan-loop）

### heartbeat-orphan-loop — デタッチした heartbeat ループが close 後・セッション終了後も残り in_progress の lease を延命し続けた（2026-09-04、同日5本）
- 原因: lease-params.md が heartbeat の頻度・対象範囲は規定していたが**寿命を規定していなかった**ため、静的 ID リスト＋時間上限だけの生ループが書かれた
- 防止: 生ループを書かず `scripts/bd-heartbeat.sh` を使う（寿命は ID リスト・セッション・`--max-hours` の3重に束縛）。本則: `lease-params.md`「heartbeat ループの寿命」。フック deny は現時点では作らない（スクリプト＋規律で足りる）。同じ失敗が再発して D 化したら pre-bash-guard 規則の追加を起票する
- 出典: bdboard-0kql（実測 bdboard-cdqb）（鏡像: heartbeat-partial）

### reclaimed-live-ticket — 生存セッションのチケット4件が作業中に自動 reclaim され、`bd ready` が「PR が飛んでいるチケット」を空きとして提示した（2026-09-05）
- 原因: reclaim スーパーバイザー（常時稼働 bdboard サーバー自身）が **lease しか見ず worktree もブランチも PR も見ない**うえ、猶予窓の既定が lease TTL 由来の 10m と短かった。heartbeat は打たれていなかった（`scripts/bd-heartbeat.sh` は `--session-pid $$` を使うが、Claude Code の Bash ツールは呼び出しごとに別シェルを起こすため自壊する）。claim の 15〜19 分後に open へ戻された。**回収は `bd show` に出ない**ので台帳を眺めても気付けない（`bd history <id> --events` には `lease_reclaimed` として残る）
- 防止: 回収前に worktree/ブランチの生存を見る（bdboard-6aci。保護は作業開始から 12 時間で打ち切る）。猶予窓の既定は 2h（bdboard-hybu）。`bd ready` の一覧だけで着手を決めず、規律2 の worktree/ブランチ不存在確認を必ず通す。すり抜けた誤回収は Hygiene の `reclaimed_live_worktree` が事後に出す（bdboard-rkde）（本則: SKILL.md 規律1 手順2, lease-params.md）
- 出典: bdboard-okdh / 53my / s0o7 / s1vj（対策 bdboard-hybu / rkde / 6aci）（鏡像: heartbeat-orphan-loop）

### duplicate-helper-parallel — 並列実装で同目的のヘルパーが別々に生まれ、後から統合チケットが10件超発生（2026-08）
- 原因: 着手前に既存実装を探す手順が規律に無く、`npm run drift` 相当の衝突検知は PR 直前にしか働かない（ルール不在 = brushup-protocol.md §2 の分類 A）
- 防止: claim 直後・実装前に `git grep` と `bd search --status in_progress` を各1回、見つかれば再利用（本則: SKILL.md 規律2 手順4）。レビュー依頼の観点にも「同 PR 内・直近 main の重複実装」を入れる（verification.md）
- 出典: bdboard-dh7c / 3zpw / x4ky / yd3g / a1g5 / nrw0 / os16 / h3wg / 3tw.79 / sm7r / b4o、docs/HARNESS-EVALUATION.md §3.2(b)

## マージ・PR

### merge-slot-misclaim — merge-slot bead を「最優先の着手可能チケット」として claim し、他セッションのマージを停止（実測）
- 原因: slot bead は「空き = open・priority 0」で状態表現するため素の `bd ready` の先頭に載る
- 防止: `bd ready --exclude-label gt:slot` を常用（本則: SKILL.md 規律1 手順5）
- 出典: bdboard-9k3

### merge-chain-semicolon — マージ手順の1行連結で acquire 失敗後も `;` 区切りの後半（bd close 含む）が無条件実行された（2026-08-16）
- 原因: `bd merge-slot acquire` の誤構文（slot 名を引数に渡すと unknown command）＋ `;` はエラーで止まらない
- 防止: マージ手順は1行連結にせず1コマンドずつ（または `set -euo pipefail` スクリプトで）実行し、close はマージ成功後にのみ到達させる（本則: worktree-pr-flow.md §5）
- 出典: bd memory `bdboard-merge-slot-syntax`

### ci-webhook-drop — GitHub 障害中の force-push で CI が起動せず、pending と誤認して待ち続けた（2026-08-17）
- 原因: 障害中は webhook の synchronize イベントが無言でドロップされ、check-suite 自体が生成されない
- 防止: check-runs/check-suites の REST 照会で「未起動」を判別し、空コミットで再トリガー（本則: worktree-pr-flow.md §4）
- 出典: グローバル lessons-learned.md（webhook dispatch の節）

### graphql-quota-exhaustion — `gh pr create` 等の GraphQL 系コマンドが枠を理由に拒否される（2026-08-18, 再発 2026-08-29, 別原因の同症状 2026-09-05）
- 原因1（一次枠の枯渇）: gh の PR 系コマンドはアカウント単位（リポジトリ単位でない）の GraphQL 枠 5000/h を消費し、短間隔 watch でも多数セッションの通常呼び出しの合算でも食い潰せる。rate_limit スナップショットは他セッションの同時消費を追い切れず「満タン表示直後に枯渇」が起きる
- 原因2（secondary rate limit と考えられる。2026-09-05 実測）: `gh api rate_limit` が core / graphql とも **5000/5000 remaining** を返すのに `GraphQL: API rate limit already exceeded for user ID …` で拒否される。**一次枠の残量を見ても診断にならず、`graphql.reset` まで待っても解けない**（GitHub が secondary と名乗るわけではないので断定はしない）。原因1と2は症状で区別できないが、**対処は同じ＝即 REST へ切り替える**ので確定させる必要は無い
- 防止: ポーリングは30秒以上間隔・複数 PR は1本の監視ループへ集約。**拒否されたら reset を待たずに REST へ切り替える**（create / merge / check-runs / ref DELETE の4経路とも REST で完走できる。本則: worktree-pr-flow.md §4）。reset まで待って1回だけ再試行するのは原因1のときだけ有効で、原因2では無駄に最大1時間を失う
- 出典: bdboard-p5l.10 / bdboard-2w3 / bdboard-il3i（原因2の実測: PR #387 作成時）

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
- 防止: worktree から preview_start 禁止。起動はメインチェックアウトへ cd してから（本則: bdboard の `.claude/skills/bdboard-server-ops/SKILL.md`「Never call `preview_start` from a worktree session」）
- 出典: `.claude/skills/bdboard-server-ops/SKILL.md` 該当節（実測記録つき）

## 検証・ビルド

### verify-storm — 6並列の `npm run verify` が自己増幅し load average 190–258 が数時間継続（2026-08-18）
- 原因: 実行ごとの worker 上限では投入数の増加を止められない
- 防止: verify は機械式スロット（最大2並列）内蔵の `npm run verify` のみ使用。`verify:steps` 直叩き禁止（本則: CLAUDE.md「Verify slots」）
- 出典: bdboard-d48（前提: bdboard-255, bdboard-kia）

### verify-exit-masked — バックグラウンド verify の後続コマンドが exit code を潰し、失敗を「緑」と誤報告した（2026-08-29）
- 原因: `npm run verify > log; echo EXIT=$?; tail log` の形で走らせ、タスク全体の終了コードが最後の `tail` の 0 になった。通知の exit 0 だけ見てログを読まなかった
- 防止: 検証の判定はラッパーの終了コードでなく、検証コマンド自身の exit（ログ内 EXIT= 行）とログの失敗有無で行う（本則: verification.md）
- 出典: 本 skill 導入セッション（2026-08-29, PR #134 の CI で発覚）

### double-background-verify — `run_in_background:true` 内に `&` を書き、harness の completed 通知が echo だけの完了を指した（2026-08-30）
- 原因: `nohup npm run verify > log 2>&1 &\necho pid $!` を run_in_background:true で実行し、シェルの `&` が harness の追跡単位を『verify』ではなく直後の echo にすり替えた
- 防止: run_in_background:true のコマンド文字列にバックグラウンド化の末尾 `&`（`2>&1`/`&&` は可）を書かない。長時間コマンドはそのまま渡すか `while kill -0 <pid> 2>/dev/null; do sleep 5; done` で待つ（本則: verification.md）
- 出典: bdboard-j0us（同一セッション内で2回再発、pgrep で detached プロセス生存を確認して発覚）

### wrong-node-version — シェルスナップショットの nvm 不全で意図しない Node により npm install が lockfile を書き換えた
- 原因: `NVM_DIR` 欠落で `.zshrc` の `nvm use` が無言で失敗し、古い Node が PATH に残る
- 防止: 依存インストール前に `node --version` を engines.node と突き合わせる（本則: worktree-pr-flow.md §2）
- 出典: bdboard-hmj

## 委譲・検証

### codex-zero-edit — Codex 実装委譲が 0 編集のまま「委譲しました」と申告（約1/3の頻度で発生）
- 原因: Codex が読む AGENTS.md に議長向け委譲方針が混線し、自分に誤適用して何も編集しない
- 防止: 「0編集＋委譲文言＋異常に短い latency」の3点が揃ったら1回だけリトライ、2連続で failed（本則: verification.md）
- 出典: bdboard-p5l.9

### codex-autonomous-push — Codex実装委譲がcommit禁止ブリーフを無視してcommit+pushし、さらにバックグラウンド再開後に無断PR作成・捏造レビュー起点の追加実装・オープンPRブランチへのrebase+force-pushまで実行（2026-08-29）
- 原因: Codexがプロジェクトの通常Git Workflow知識をブリーフの明示的な制約より優先して自律適用（codex-zero-editと同根・逆方向の過剰行動）。一度exitしたaimixバックグラウンドプロセスが再開して追加のgit操作を行った
- 防止: 委譲完了報告の直後と、以後の各outward操作の直前に `git log --oneline -5`・`git status`・`git ls-remote origin <branch>` で無断commit/pushを再確認し、委譲プロセスの終了を確認してからPR操作へ進む。ブリーフはgit操作を禁止形＋違反時自己申告義務で書く（本則: verification.md）
- 出典: bdboard-ge20

### diff-against-moving-main — `git diff origin/main` が他セッションのマージ分を「自分の削除」に見せ、無実の成果物を捨てかけた（2026-08-16）
- 原因: 並列運用では origin/main が動く的になり、素の diff は他人の追加を自分の削除として表示する
- 防止: diff は必ず merge-base 基準（`git diff $(git merge-base HEAD origin/main)`）で読む（本則: verification.md）
- 出典: bdboard-3tw.104.4 / グローバル lessons-learned.md

## 多層ハーネス・配布

### injected-copy-edit — ハーネス改善を注入コピー側（.claude/skills/）に書き、パック正本（harness/packs/）に反映し損ねかけた（2026-08-29, ニアミス）
- 原因: bdboard repo には正本と注入コピーの両方が存在し、Claude Code が読むのはコピー側なので、編集対象として自然にコピーを選んでしまう
- 防止: 編集前に層を判定（`harness/packs/` の有無 → bdboard repo なら正本を編集し同 PR でコピーへ反映。注入先ならコピー編集禁止）（本則: layering.md）
- 出典: 本 skill 導入セッション（2026-08-29）。マージ前レビューの過程で検出

### stale-harness-worktree — main から大きく遅れた worktree で走り続けたセッションが、自分がマージしたハーネス改善を自分には適用しないまま動き続けた（2026-09-05）
- 原因: 注入コピー（`.claude/skills/` と `.claude/settings.json`）は**チェックアウト単位**で、worktree は作成時点の main で凍る。長命の worktree に居るセッションは、hooks もスクリプトも規律本文も古いまま。本人からは「ハーネスが入っている」ようにしか見えない
- 防止: `bd/<id>` worktree のハーネス差分（`git rev-list --count HEAD..origin/main -- .claude harness`）が 3 以上で、チケットが in_progress なら Hygiene の `stale_harness_worktree` が出す。**プロセス生存は見ておらず、`feature/*` 等の非チケット worktree も対象外**（実測ではそちらのほうが深く凍っていた。対応は bdboard-wadg）。自分の worktree は上のコマンドで自分で測ること。1チケット=1worktree を守り、長命化したら PR を分割するか `git rebase origin/main` でハーネスごと追従する（本則: SKILL.md 規律1 手順2, CLAUDE.md「Git Workflow」）
- 出典: bdboard-tdua（実測: ハーネス差分 17 コミットの worktree で稼働中のセッションが、同じ日にハーネス改善 PR をマージしていた）

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
- 防止: 常に `bd dolt push --remote legacy`。bare push 前は `bd dolt remote list` で origin 不在を確認（本則: bdboard の `docs/GIT-WORKFLOW.md`「.beads/ Dolt sync」）
- 出典: bdboard-jb1（背景: bdboard-23v）
