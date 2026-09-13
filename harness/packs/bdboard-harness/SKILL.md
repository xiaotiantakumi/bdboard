---
name: bdboard-harness
description: .beads/ を持つプロジェクトでチケット作業・自律作業・並列セッション作業を始めるときに必ず適用する作業規律。セッション開始(bd prime→stale lease確認→bd ready)、worktree-first 排他と claim、確認待ちのノンブロッキング化(bd human + human gate)、close はマージ成功後だけ、ハーネス失敗の学習ループ(failure-catalog 照合・brushup・層判定と還流)、複雑度別のモデル振り分けの6規律を定める。
---

# bdboard-harness — bd 運用プロジェクトの自律作業規律

## 前提

- 対象は `.beads/` を持つプロジェクト。**複数セッションが同時に走る**前提で書かれている
  （単独でも同じ規律を守る — いつ並列になるか自分からは分からない）。
- **プロジェクト固有の値はここに書かない。** 検証コマンド・ブランチ命名・マージ方式・
  サーバー/ポートは注入先の CLAUDE.md / AGENTS.md（と検証コントラクト）に従う。
- **本文は骨格。各規律の `詳細:` が挙げるファイルはすべて `references/` 配下**。着手前に開く。

## 規律1: セッション開始 — prime → stale lease 確認 → ready

なぜ: 死んだセッションの残骸（stale lease・worktree）を見ないまま着手すると、誰も作業して
いないチケットを永久に避け続けるか、生きている作業を横取りするかの事故になる。

手順:

1. `bd prime` — 台帳のコンテキストとプロジェクトメモリを読み込む（メモリ全文の読み方は詳細）。
2. `bd list --status in_progress` で lease 切れを把握する（lease の残りは `bd show <id>`）。
   **`bd ready` の一覧だけで着手を決めない**。長命 worktree ではハーネスの凍結を自分で測る。
3. **`bd reclaim` は原則打たない** — 正はスーパーバイザーの定期実行（例外3条件は詳細）。
4. マージ済み worktree の残骸**だけ**掃除する（判断がつかないものは触らない）。
5. `bd ready --exclude-label gt:slot` で候補を取る（**除外必須**。理由は詳細）。

詳細: `session-start.md` / `lease-params.md` / `worktree-pr-flow.md` / `failure-catalog.md`

## 規律2: 排他と claim — 排他の正本は worktree、claim は台帳記録

なぜ: 並列セッションは全て同じ assignee で動くため `bd update --claim` は先行 claim を検出
できず両方成功しうる。`git worktree add -b` は先着1名しか成功しない。**排他は git が裁く**。

手順（この順序を厳守）:

1. 空き確認は worktree とブランチの**両方**が「無い」こと。
2. **`git worktree add <path> -b <branch>` の成否が排他** — 失敗（既存）なら次の候補へ。
3. **成功して初めて `bd update <id> --claim`。** claim を worktree より先に打たない。
4. 実装前に既存実装を1回探す（`git grep -n` と `bd search --status in_progress` を各1回）。
5. **heartbeat は scripts/bd-heartbeat.sh で**保持中の全チケットへ。失敗＝所有権喪失、直ちに停止。
6. **負けたら**相手を戻さない・kill しない（空の worktree の扱いは詳細）。

詳細: `worktree-pr-flow.md`（手順の全文）/ `lease-params.md`

## 規律3: 確認待ち — 質問はチケットに載せ、回答を待たずに次へ進む

なぜ: 質問をチャットで投げて待つと、回答が来るまでセッション全体が止まる（実際に起きた
事故）。台帳に載せればユーザーは自分のペースで回答でき、他のチケットを進められる。

手順:

1. `bd comment <id> "<質問>"` — 選択肢と帰結・推奨・回答後の再開手順まで書く。
2. `bd label add <id> human` で確認待ちレーンへ（`bd update --label` は存在しない）。
3. `bd gate create --type=human` で `bd ready` から外す（**`bd dep add` で代用しない**）。
4. **回答を待たず次のチケットへ。** worktree は残し、heartbeat の対象に含め続ける。
5. 回答が来たら `bd label remove <id> human` して再開（作業チケットは close しない）。
6. **例外**: 破壊的・不可逆・外向きの操作はその場で確認する。

詳細: `question-template.md`（手順の全文）

## 規律4: セッションクローズ — close はマージ成功後だけ

なぜ: PR を開いた時点で close すると `bd ready` と進捗表示が「landed していない作業を完了」
と偽り、並列セッションの判断を狂わせる。close =「main に入った」の不変条件を守る。

手順:

1. 検証 → PR → CI → マージ、まで完走する（検証コマンドの決め方は詳細。**無ければ検証せず進めない**）。
2. **マージ成功後、`bd close` の前に証拠コメント**（**`PR:` 行必須**）。
3. **その上で `bd close <id>`。マージ前に close しない**。
4. worktree を掃除する（remove → ブランチ削除 → `git remote prune origin`）。
5. 残作業・気づきはチケット化する（`--deps discovered-from:<元>`）。
6. `bd dolt push` はセッション末に1回（外向き操作。許可が無ければ確認）。

詳細: `close-template.md`（手順の全文）/ `worktree-pr-flow.md` / `verification.md`

## 規律5: ハーネス失敗の学習ループ — 同じ失敗を二度踏まない

なぜ: 規律は過去の事故の集積であり、網羅は常に不完全。新しい失敗をその場の復旧だけで終えると
教訓は散逸し、別セッションが同じ失敗を再生産する。

手順:

1. **検知**: 成果の消失／規律どおりでの事故／手順の不遵守／既知パターンの再発 =「ハーネス失敗」。
2. **即時の最小記録**: 復旧前に証拠を残す（残す中身と置き場所は詳細）。
3. **直せないなら起票して現作業へ戻る**（`harness` ラベル。起票の形と priority は詳細）。
4. **編集する層を先に決める**: 注入コピー `.claude/skills/bdboard-harness/` は**編集禁止**。
5. **検討は Fable の最大熟考で固める**。規律を変える PR はマージ前に Fable の独立レビューへ。
6. **確定した教訓は必ず failure-catalog にエントリを持つ**（本則が他所ならポインタ付きで）。

詳細: `brushup-protocol.md`（手順の全文）/ `layering.md` / `failure-catalog.md`

## 規律6: モデル振り分け — 複雑度と可用性を分ける

なぜ: 契約の `models` に従って工程ごとの候補を選ぶ。rate limit などの可用性の失敗だけで
複雑度を上げると、品質と関係なく高いセルへ移り続けるので、2 種のフローを分離する。

手順:

1. 着手時に複雑度を推定して記録する（**declared は自動上書き禁止、降格は人間のみ**）。
2. `scripts/route.sh <stage> <complexity>` の出力順で候補を試す。
3. **可用性の失敗**は同じセルの次候補へ、**品質の失敗**は 3 トリガーだけで 1 段上のセルへ。

詳細: `model-routing.md`（手順の全文・ルーブリック・記録例）

## 機械ガード（hooks）— 文章で防げない操作は hook が止める

- `hooks/` の3スクリプトは、注入時に注入先の `.claude/settings.json` へ登録される。
- **hook に止められたら回避策を探さない。** stderr の代替手順に従う。hook 自体の不具合は
  `harness-upstream` チケットで起票する。
- 止めるもの（deny 条件の一覧）・fail-open 方針・settings.json 登録契約: `hooks/README.md`。

## references

`references/` の全量: session-start / worktree-pr-flow / lease-params / question-template /
close-template / verification / failure-catalog / brushup-protocol / layering /
model-routing / frontend-gotchas（web 実装の罠）。
