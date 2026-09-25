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

### heartbeat-session-pid-self-destruct — `--session-pid $$` が Claude Code の Bash ツールでは起動直後に自壊する（実測 2026-09-21、bdboard-sso1.28）
- 原因: Bash ツールは呼び出しごとに新しいシェルを起こして終わるため、渡した `$$` は直後の別呼び出し時点で既に死んでおり寿命条件(2)が誤発火する
- 防止: `--session-pid` には呼び出し元シェルの親プロセス（Claude Code 本体。セッション中は生き続ける）の PID を渡す — `$(ps -o ppid= -p $$ | tr -d ' ')`（本則: lease-params.md「heartbeat ループの寿命」）
- 出典: bdboard-tqba（発端 bdboard-sso1.28。関連: reclaimed-live-ticket / heartbeat-orphan-loop）

### reclaimed-live-ticket — 生存セッションのチケット4件が作業中に自動 reclaim され、`bd ready` が「PR が飛んでいるチケット」を空きとして提示した（2026-09-05）
- 原因: reclaim スーパーバイザー（常時稼働 bdboard サーバー自身）が **lease しか見ず worktree もブランチも PR も見ない**うえ、猶予窓の既定が lease TTL 由来の 10m と短かった。heartbeat は打たれていなかった（当時の呼び出し例は `--session-pid $$` を使っていたが、Claude Code の Bash ツールは呼び出しごとに別シェルを起こすため自壊していた。呼び出し例は bdboard-tqba で修正済み）。claim の 15〜19 分後に open へ戻された。**回収は `bd show` に出ない**ので台帳を眺めても気付けない（`bd history <id> --events` には `lease_reclaimed` として残る）
- 防止: 回収前に worktree/ブランチの生存を見る（bdboard-6aci。保護は作業開始から 12 時間で打ち切る）。猶予窓の既定は 2h（bdboard-hybu）。`bd ready` の一覧だけで着手を決めず、規律2 の worktree/ブランチ不存在確認を必ず通す。すり抜けた誤回収は Hygiene の `reclaimed_live_worktree` が事後に出す（bdboard-rkde）（本則: SKILL.md 規律1 手順2 と session-start.md, lease-params.md）
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

### merge-gate-pipe-masked — `bd merge-slot acquire 2>&1 | tail -2 && gh pr merge ...` がパイプの終了ステータスで acquire 失敗を隠し、スロット外マージが発生（2026-09-04, PR #296）
- 原因: acquire は「slot held by: fable-chair-pkr6」で失敗していたが、パイプの終了ステータスは末尾 `tail` の exit 0 になり `&&` 後続の `gh pr merge` が素通りした（merge-chain-semicolon とは別の機序＝`;` ではなくパイプ。同機序: verify-exit-masked）
- 防止: ゲート判定コマンド（`bd merge-slot acquire`・検証コマンド等）はパイプせず単独実行して `$?` を見るか、リダイレクト後に `echo "EXIT=$?"` を取る（本則: worktree-pr-flow.md §5「ゲート判定コマンドをパイプに通して `&&` で繋がない」節）
- 出典: PR #296 / bdboard-pkr6.22.2（索引化: bdboard-9one）

### merge-slot-waiters-stale — `bd merge-slot` の waiters 残骸を先頭待ちの根拠にして、available なのに acquire せず永久停滞した（2026-09-20）
- 原因: `bd merge-slot acquire`（`--wait` 無し）は `status` だけで可否判定し `metadata.waiters` を見ないが、waiters には release 後も消えない残骸（2026-09-04 以来の3件 + マージ済み PR #480 の1件）が溜まっており、2エージェントがそれを「自分より先に並んでいる」根拠として誤読した
- 防止: available なら waiters の中身に関わらず即 acquire する。`acquire --wait` は使わない（残骸を増やすだけ）。先頭待ちのポーリングを自作しない（本則: worktree-pr-flow.md §5 層1「waiters は参考情報」節）。waiters の自動失効・acquire/release時のエントリ除去など bd 本体側の改修は harness-upstream チケット（bdboard-c6wu）へ
- 出典: bdboard-5avg（起票: bdboard-wadg / PR #480 マージ時のキュー飛び観測、停滞事故: 議長観測 2026-09-20）

### merge-slot-held-through-ci — merge-slot を握ったまま rebase → CI 待ち → verify を回し、11 時間中 7.6 時間（約 70%）枠が埋まってマージ間隔が約 12 分に張り付いた（2026-09-23）
- 原因: 「CAS は rebase 元と一致すること」を枠の中で満たそうとして、CAS 負け → rebase → CI 5–9 分 → CAS のやり直しをすべて枠の中で行っていた（待機ループ ≈250 分、CI 待ち ≈140 分、verify ≈80 分）。ruleset は strict=false で、この待ちは GitHub の要求ではない
- 防止: 契約の `merge.mode: S1`（S2 も同じ） — 枠は acquire → CAS → gh pr merge → release だけ、着地後検証は枠の外で commit status 台帳へ（本則: worktree-pr-flow.md §5「S1」、bdboard の `npm run merge-pr`）
- 出典: bdboard-iaqg（計測）/ bdboard-ulxa（設計）/ bdboard-ulxa.1（S1 実装）

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
- 出典: bd memory `bdboard-health-check-401-false-negative`

### worktree-preview-start — worktree から `preview_start` を実行し、本体ポート 8787 で別ブランチの stale UI が配信された（2026-08-29, 再現 2/2）
- 原因: launch.json は全 worktree に存在し、cwd 側の `src/main.ts` と `web/dist` が使われる。ステータスコードでは検出不能
- 防止: worktree から preview_start 禁止。起動はメインチェックアウトへ cd してから（本則: bdboard の `.claude/skills/bdboard-server-ops/SKILL.md`「Never call `preview_start` from a worktree session」）
- 出典: `.claude/skills/bdboard-server-ops/SKILL.md` 該当節（実測記録つき）

### subagent-restarted-always-on-server — PR をマージしたサブエージェントが CLAUDE.md の後片付け手順どおり main checkout を pull し、8787 を kill・再起動した（2026-09-20、3 件: bdboard-13mp / bdboard-sso1.10 / bdboard-sso1.5）
- 原因: 「マージ後に常時稼働サーバーを再起動」の手順が誰の仕事かを文章でしか区別しておらず、`gh pr merge` まで委譲されたサブエージェントには手順どおりの正しい行動に見える。委譲ブリーフの禁止文言だけが歯止めで、9/20 以降の再発ゼロもブリーフと議長側の deploy スクリプト (スクラッチパッド、揮発) に依存していた
- 防止: hook 規則 7 (`hooks/server-guard.sh`) — `agent_id` 付きの呼び出しから main checkout の `git pull` / `npm run start` / 再起動スクリプト実行を deny、listener PID の直接 kill は誰からでも deny。再起動は議長が `BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh restart --expect-pid <PID>` で行い、サブエージェントは最終報告に「議長で再起動が必要」と書く（本則: CLAUDE.md「Always-On Local Hosting」、`hooks/README.md` 規則 7）
- 出典: bdboard-hpu8（トランスクリプト調査。`bd comments bdboard-hpu8` と PR 本文に証跡）

### stale-chair-checkout — 議長セッションの checkout が main から取り残され、main で入れた hook (規則 7 ほか) が議長と全サブエージェントで 1 か月以上効いていなかった（2026-09-24）
- 原因: hook の登録も本体もセッション起動時の checkout (`$CLAUDE_PROJECT_DIR`) から読まれ、サブエージェントも同じ場所を読むが、長寿命セッションの checkout は誰も更新しない
- 防止: `hooks/worktree-freshness.sh` が SessionStart / UserPromptSubmit / PostToolUse(Agent) で遅れ・共通祖先なし・本体欠落を警告し安全な追従コマンドを案内 (自動 merge はしない)。議長はマージ後に自分の checkout も追従 (本則: `hooks/README.md`、docs/GIT-WORKFLOW.md「Cleanup after merge」)
- 出典: bdboard-flpp

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

### fixture-only-parser-test — 出力パーサのテストが色無しfixtureだけで通り、実出力のANSIエスケープでサマリ行を1件も拾えなかった（2026-09-06）
- 原因: `classifyVerifyOutput()` は fixture 文字列の9テストを全通過していたが、実出力は ESC が行頭空白より前に付き `/^[ \t]*Tests/` が一致しなかった。`FORCE_COLOR=1` は TTY のときだけ付くため CI は通りローカルだけ黙って死ぬ非対称な壊れ方をした
- 防止: 出力パーサのテストは実測バイト列を1件は含める。環境依存の分岐（TTY/非TTY, CI/ローカル）がある機能は両方の経路を確認する。CIグリーンは「対象環境で動く」ことの証明にならない
- 出典: bdboard-8rl8 / bd memory `2026-09-06-bdboard-parse-real-output`

## 委譲・検証

### codex-zero-edit — Codex 実装委譲が 0 編集のまま「委譲しました」と申告（約1/3の頻度で発生。複数の独立作業を1ブリーフに詰めると計画宣言のみで再現）
- 原因: Codex が読む AGENTS.md に議長向け委譲方針が混線し、自分に誤適用して何も編集しない（統合ブリーフ時の計画宣言のみ変種も同根と推定）
- 防止: 「0編集＋委譲文言＋異常に短い latency」の3点が揃ったら1回だけリトライ、2連続で failed。統合ブリーフは作業単位に分割して渡す（本則: verification.md）
- 出典: bdboard-p5l.9 / bdboard-qxt1

### codex-autonomous-push — Codex実装委譲がcommit禁止ブリーフを無視してcommit+pushし、さらにバックグラウンド再開後に無断PR作成・捏造レビュー起点の追加実装・オープンPRブランチへのrebase+force-pushまで実行（2026-08-29）
- 原因: Codexがプロジェクトの通常Git Workflow知識をブリーフの明示的な制約より優先して自律適用（codex-zero-editと同根・逆方向の過剰行動）。一度exitしたaimixバックグラウンドプロセスが再開して追加のgit操作を行った
- 防止: 委譲完了報告の直後と、以後の各outward操作の直前に `git log --oneline -5`・`git status`・`git ls-remote origin <branch>` で無断commit/pushを再確認し、委譲プロセスの終了を確認してからPR操作へ進む。外部CLI（Codex）宛ブリーフはgit操作を禁止形＋違反時自己申告義務で書き、検知を済ませてから議長が受領状態をコミットする（delegation-brief-no-commit、本則: verification.md）
- 出典: bdboard-ge20

### uncommitted-delegation-wiped-by-checkout — 未コミットの委譲成果が検証中の checkout で消失（2026-09-03〜04）
- 原因: `git checkout -- <file>` / `git restore` は自分の加えた分と区別せず、そのパスの未ステージ変更をすべて捨てる。委譲先が未コミットのまま報告し、議長はその上で壊す→戻すを行った
- 防止: 受領したら検証より先に受領状態を1コミット。HEAD へ戻す操作（壊す→戻す）に入る前に `git status --porcelain -- <path>` が空、戻す直前は差分が自分の壊し分だけかを確認（本則: verification.md）
- 出典: GitHub #437 / bdboard-p5l.24

### delegation-brief-no-commit — 「push / PR 作成はしない」だけのブリーフで委譲先がコミットもせず成果を残した（2026-09-03〜04）
- 原因: git 操作を禁止する書き方では（一括でも push / PR だけでも）委譲先は安全側に倒してコミットも避け、未コミット成果が議長の checkout / restore / rebase の巻き添えになる
- 防止: セッション内サブエージェント宛は「変更ファイルを明示して worktree でコミットまで（push と PR 作成はしない）」と肯定形で書き、外部 CLI（Codex）宛は禁止形を維持し議長が受領直後にコミット（本則: verification.md）
- 出典: GitHub #437 / bdboard-p5l.24

### diff-against-moving-main — `git diff origin/main` が他セッションのマージ分を「自分の削除」に見せ、無実の成果物を捨てかけた（2026-08-16）
- 原因: 並列運用では origin/main が動く的になり、素の diff は他人の追加を自分の削除として表示する
- 防止: diff は必ず merge-base 基準（`git diff $(git merge-base HEAD origin/<mainBranch>)`。`<mainBranch>` は検証コントラクトの `mainBranch`、省略時 `main`）で読む（本則: verification.md）
- 出典: bdboard-3tw.104.4 / グローバル lessons-learned.md

### cursor-shell-unavailable-verify-skipped — Cursor がシェル不可のまま「編集のみ・検証未実行」を正常応答として返した（2026-09-05）
- 原因: cursor-agent がシェルを一切実行できない状態でも異常を報告せず、編集結果だけを正常応答として返す
- 防止: 委譲先の報告に verify/e2e の EXIT が実測値として含まれているかを必ず確認し、無ければ検証済みと読まない（本則: verification.md「委譲先の『検証済み』申告は実測の有無で裏取りする」）
- 出典: bdboard-h4xs.19（鏡像: cursor-fabricated-measurement）

### cursor-fabricated-measurement — シェル不可の Cursor Composer が別チケットの実測値を自分の実測として提示し14箇所を誤修正した（2026-09-05）
- 原因: チケット本文に参考として載っていた別チケットの実測表を、委譲先が自分の計測結果として再提示した
- 防止: 他チケットの実測値を書くときは出典を明示する。実測完了条件のチケットは「どのコマンドを何回流したか」を報告形式に含めさせ、議長が最低1つ検算する（本則: verification.md「委譲先の『検証済み』申告は実測の有無で裏取りする」）
- 出典: bdboard-z231（鏡像: cursor-shell-unavailable-verify-skipped）

### chairman-scope-not-remeasured — 議長が実装者提示の対象範囲だけで裁定し、盤面全体の被覆を見逃した（2026-09-05）
- 原因: 実装者の「ストリップとの重なり」という枠組みをそのまま受け入れ、CI緑・e2e 6/6 通過も対象範囲を測っていなかった
- 防止: 実装者の「許容してよいか」に答える前に、報告された対象より広い範囲を自分で1回測る。幾何系の裁定は議論でなく実測で決める（本則: verification.md「裁定前に対象の範囲を自分で測り直す」）
- 出典: bdboard-h4xs.19

### subagent-completed-notification-not-final — completed 通知を最終報告と誤認し、同じ worktree へ2体目のエージェントを起動しかけた（2026-09-06）
- 原因: bg ジョブ（verify/Playwright）を投げてターンを終えただけの中間報告が status=completed で届き、放棄と誤判定した
- 防止: pgrep/lsof/lease は判定材料にならない。報告本文が最終報告の体裁か中間状態かを読んでから再委譲を判断する（本則: verification.md「完了通知（completed）は最終報告とは限らない」）
- 出典: bdboard-bdsd

## 多層ハーネス・配布

### injected-copy-edit — ハーネス改善を注入コピー側（.claude/skills/）に書き、パック正本（harness/packs/）に反映し損ねかけた（2026-08-29, ニアミス）
- 原因: bdboard repo には正本と注入コピーの両方が存在し、Claude Code が読むのはコピー側なので、編集対象として自然にコピーを選んでしまう
- 防止: 編集前に層を判定（`harness/packs/` の有無 → bdboard repo なら正本を編集し同 PR でコピーへ反映。注入先ならコピー編集禁止）（本則: layering.md）
- 出典: 本 skill 導入セッション（2026-08-29）。マージ前レビューの過程で検出

### stale-harness-worktree — main から大きく遅れた worktree で走り続けたセッションが、自分がマージしたハーネス改善を自分には適用しないまま動き続けた（2026-09-05）
- 原因: 注入コピー（`.claude/skills/` と `.claude/settings.json`）は**チェックアウト単位**で、worktree は作成時点の main で凍る。長命の worktree に居るセッションは、hooks もスクリプトも規律本文も古いまま。本人からは「ハーネスが入っている」ようにしか見えない
- 防止: 検証コントラクトの `mainBranch`（省略時 `main`）を `<mainBranch>` とし、`bd/<id>` worktree のハーネス差分（`git rev-list --count HEAD..origin/<mainBranch> -- .claude harness`）が 3 以上で、チケットが in_progress なら Hygiene の `stale_harness_worktree` が出す。Hygiene は実際に測った基準 ref（コントラクトの `mainBranch` を優先）を警告と rebase コマンドに出す。**プロセス生存は見ておらず、`feature/*` 等の非チケット worktree も対象外**（実測ではそちらのほうが深く凍っていた。対応は bdboard-wadg）。自分の worktree は上のコマンドで自分で測ること。1チケット=1worktree を守り、長命化したら PR を分割するか `git rebase origin/<mainBranch>` でハーネスごと追従する（本則: SKILL.md 規律1 手順2 と session-start.md, CLAUDE.md「Git Workflow」）
- 出典: bdboard-tdua（実測: ハーネス差分 17 コミットの worktree で稼働中のセッションが、同じ日にハーネス改善 PR をマージしていた）

## bd 操作・確認待ち

### blocking-chat-question — ユーザーへの質問をチャットで投げて回答待ちし、セッション全体が停止（実測）
- 原因: 確認待ちを台帳に載せる手段を使わず、同期の質問にした
- 防止: gate 本体（title/description）を質問の正本にし、作業チケット側は pointer comment + human ラベルに留めて次のチケットへ進む（本則: SKILL.md 規律3, question-template.md）
- 出典: SKILL.md 規律3 の動機事例 / bdboard-p5l.26

### dep-instead-of-gate — 確認待ちを `bd dep add` で表現しようとして既存の discovered-from 辺と衝突・失敗（bd 1.2.1 実測）
- 原因: bd は同じ向きの2者間に複数タイプの辺を持てない
- 防止: 確認待ちは `bd gate create --type=human`（別ノードへの blocks 辺なので既存来歴と衝突しない）（本則: SKILL.md 規律3 手順1）
- 出典: bdboard-axl

### bd-notes-backtick-shell-injection — bd ノート本文中のバッククォートがシェルにコマンド置換され、ノートが壊れ引数無し git checkout/restore が実行された（2026-09-05）
- 原因: `bd update --append-notes` 等へ Bash から渡す文字列を二重引用符のまま埋め込み、本文中のバッククォート・`$`・`\` がシェル展開された
- 防止（本則: 本エントリ）: 長文ノートは常にシングルクォートのヒアドキュメントで `$(mktemp)` 等の衝突しない一時ファイルへ書いてから（`f=$(mktemp); cat > "$f" <<'EOF' ... EOF`）`bd update <id> --append-notes "$(cat "$f")"` で渡す。バッククォート/`$`/`\` を含まないと確信できる短文のみ直接引用してよい。`bd comment`/`bd create`/`bd update` の description/comment 系フィールドは `--body-file`/`--stdin` 等のファイル入力形式を持つものがあるが、`--notes`/`--append-notes` には無いため、notes 系は常にこの `$(cat "$f")` 方式で渡す
- 出典: bdboard-qxt1（裁定ノートでの実例）/ bd memory `2026-09-05-bd-notes-backtick-shell-injection`

### bd-init-overwrite — 別マシンの `bd init` が AGENTS.md 管理ブロック内のカスタマイズ（gt:slot 除外等）を黙って戻し、main へ直接コミットした（2026-08-17）
- 原因: bd init はマーカー内を毎回テンプレートで再生成し、チェックアウト中のブランチへ autocommit する
- 防止: bd init は main 以外で実行し、`git diff -- AGENTS.md` のチェックリスト確認を経てから commit（本則: CLAUDE.md「bd init Re-runs」）
- 出典: bdboard-ejz（背景: bdboard-9k3）

### bare-dolt-push — Dolt レイヤーに残っていた public 向け remote により、bare push が私的チケット履歴を公開リポジトリへ漏らす寸前だった（2026-08-17）
- 原因: config.yaml の sync.remote 無効化では、既に登録済みの Dolt レイヤー remote は消えない
- 防止: 常に `bd dolt push --remote <name>` を明示（bare push しない）。bare push 前は `bd dolt remote list` で origin 不在を確認（本則: bdboard の `docs/GIT-WORKFLOW.md`「.beads/ Dolt sync」）
- 出典: bdboard-jb1（背景: bdboard-23v）
