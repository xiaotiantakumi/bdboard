---
name: bdboard-harness
description: .beads/ を持つプロジェクトでチケット作業・自律作業・並列セッション作業を始めるときに必ず適用する作業規律。セッション開始、worktree-first 排他と claim、確認待ちのノンブロッキング化(human gate)、close はマージ成功後だけ、ハーネス失敗の学習ループ、複雑度別のモデル振り分けの6規律を定める。操作はスクリプト経由。
---

# bdboard-harness — bd 運用プロジェクトの自律作業規律

## 前提

- 対象は `.beads/` を持つプロジェクト。**複数セッションが同時に走る**前提（単独でも同じ規律を守る）。
- **プロジェクト固有の値はここに書かない。** 検証コマンド・ブランチ命名・マージ方式・サーバー/ポートは
  注入先の CLAUDE.md / AGENTS.md（と検証コントラクト）に従う。
- **操作はスクリプト経由。** 本文は「なぜ」と「どれを呼ぶか」だけ。各規律の `詳細:` は `references/` 配下（着手前に開く）。
  議長だけが呼ぶのは start-ticket / close-ticket、worker も呼ぶのは open-pr / ask-human-gate / post-review-ticket。

## 規律1: セッション開始 — prime → stale lease 確認 → ready

なぜ: 死んだセッションの残骸（stale lease・worktree）を見ないまま着手すると、放置チケットを
避け続けるか、生きている作業を横取りする事故になる。

手順:

1. `bd prime` — 台帳のコンテキストとプロジェクトメモリを読み込む（メモリ全文の読み方は詳細）。
2. `bd list --status in_progress` で lease 切れを把握する（lease の残りは `bd show <id>`）。
   **`bd ready` の一覧だけで着手を決めない**。長命 worktree ではハーネスの凍結を自分で測る。
3. **`bd reclaim` は原則打たない** — 正はスーパーバイザーの定期実行（例外3条件は詳細）。
4. マージ済み worktree の残骸**だけ**掃除する（判断がつかないものは触らない）。
5. `bd ready --exclude-label gt:slot` で候補を取る（**除外必須**。理由は詳細）。

詳細: `session-start.md` / `lease-params.md` / `worktree-pr-flow.md` / `failure-catalog.md`

## 規律2: 排他と claim — 排他の正本は worktree、claim は台帳記録

なぜ: 並列セッションは同じ assignee なので `bd update --claim` は両方成功しうる。
`git worktree add -b` は先着1名しか成功しない。**排他は git が裁く**。

手順（この順序を厳守）:

1〜3. **`python3 scripts/start-ticket.py --spec <json>`**（**議長がメインチェックアウトで**。worker は
   isolation で worktree をもらうので呼ばない。キーは `--help`）が空き確認 → `git worktree add -b`
   （成否が排他。失敗なら次の候補へ）→ 成功後だけ claim。
4. 実装前に既存実装を1回探す（`git grep -n` と `bd search --status in_progress` を各1回）。
5. **heartbeat は scripts/bd-heartbeat.sh で**保持中の全チケットへ。失敗＝所有権喪失、直ちに停止。
6. **負けたら**相手を戻さない・kill しない（成果は patch へ退避）。空の worktree を「放棄」と断定しない。

詳細: `worktree-pr-flow.md` / `lease-params.md`

## 規律3: 確認待ち — 質問は gate 本体に書き、回答を待たずに次へ進む

なぜ: 質問して待つとセッションが止まる。title を省くと全 gate が同じ見た目で読めない（bdboard-p5l.26）。

手順:

1. `python3 scripts/ask-human-gate.py --spec <json>`（**worker も使う**）で gate 作成〜コメント〜
   human ラベルまで一括（キーと制約は `--help`、`--dry-run` で本文確認。最終行が gate id）。
   見て OK/NG を返すだけの確認は `scripts/post-review-ticket.py`（同じく worker も使う）。
2. **回答を待たず次へ。** worktree は残し heartbeat の対象に含め続ける。
3. 変わったら旧本文の要点を `--append-notes` に移して gate 本文を全文置換。
4. 回答が来たら `bd label remove <id> human` して再開（close しない）。
5. **例外**: 破壊的・不可逆・外向きの操作はその場で確認する。

詳細: `question-template.md`

## 規律4: セッションクローズ — close はマージ成功後だけ

なぜ: PR を開いた時点で close すると `bd ready` が「landed していない作業を完了」と偽る。
close =「main に入った」の不変条件を守る。

手順:

1. 軽い検証 → PR → auto-merge → マージ、まで完走する。PR は **`scripts/open-pr.py --spec <json>`**
   （**worker も使う**。契約 `.claude/bdboard-harness.json` の `verifyQuick`/`commitCheck` で検証 → push →
   `Closes:` 付き PR → `PR:` コメント → low/med は auto-merge）。フル検証（契約の `verify`）は CI に任せる。
2〜4. **マージ成功後に議長が `python3 scripts/close-ticket.py --spec <json>`**（メインチェックアウトで。
   キーは `--help`、`--dry-run` で確認）が MERGED と main 到達と worktree 未使用を検査 →
   `PR:` 証拠コメント → `bd close` → worktree/ブランチ掃除。**未マージは拒否される。マージ前に close しない**。
5. 残作業・気づきはチケット化する（`--deps discovered-from:<元>`）。
6. `bd dolt push` はセッション末に1回（外向き操作。許可が無ければ確認）。

詳細: `close-template.md` / `worktree-pr-flow.md` / `verification.md`

## 規律5: ハーネス失敗の学習ループ — 同じ失敗を二度踏まない

なぜ: 復旧だけで終えると教訓が散逸し、同じ失敗が再生産される。

手順:

1. **検知**: 成果の消失／規律どおりでの事故／手順の不遵守／既知パターンの再発 =「ハーネス失敗」。
2. **即時の最小記録**: 復旧前に証拠を残す（残す中身と置き場所は詳細）。
3. **直せないなら起票して現作業へ戻る**（`harness` ラベル。起票の形と priority は詳細）。
4. **編集する層を先に決める**: 注入コピー `.claude/skills/bdboard-harness/` は**編集禁止**。
5. **検討は Fable の最大熟考で固める**。規律を変える PR の独立レビューは任意（議長判断）。
6. **確定した教訓は catalog にエントリを持つ**（本則が他所ならポインタ付きで）。
7. **後続が同じ仕組みで2本目なら止め、root: チケットへ**（§8）。

詳細: `brushup-protocol.md` / `layering.md` / `failure-catalog.md`

## 規律6: モデル振り分け — 複雑度と可用性を分ける

なぜ: 契約の `models` に従って工程ごとの候補を選ぶ。rate limit などの可用性の失敗だけで
複雑度を上げると、品質と関係なく高いセルへ移り続けるので、2 種のフローを分離する。

手順:

1. 着手時に複雑度を推定して記録する（**declared は自動上書き禁止、降格は人間のみ**）。
2. `scripts/route.sh <stage> <complexity>` の出力順で候補を試す（aimix は
   `scripts/aimix-run.sh` 経由。素の `aimix run` は deny）。
3. **可用性の失敗**は同じセルの次候補へ、**品質の失敗**は 3 トリガーだけで 1 段上のセルへ。

詳細: `model-routing.md`

## 機械ガード（hooks）— 文章で防げない操作は hook / deny が止める

- `hooks/` の2本 (stop-ticket-gate.sh / worktree-freshness.sh) は状態だけを見る。コマンド/
  パスを読む禁止判定は `permissions.deny` へ移した（詳細: `hooks/README.md`）。
- **hook/deny に止められたら回避策を探さない。** 案内に従う。不具合は `harness-upstream` へ。

## references

`references/` 配下: session-start / worktree-pr-flow / lease-params / question-template /
close-template / verification / failure-catalog / brushup-protocol / layering /
model-routing / frontend-gotchas。
