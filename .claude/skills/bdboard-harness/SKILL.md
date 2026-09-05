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

1. `bd prime` — 台帳のコンテキストとプロジェクトメモリを読み込む。
   - **メモリ本文（全文）が読めるのは `bd prime` の出力・`bd recall <key>`・`bd memories --json`
     の3つ**。`bd memories <kw>` は1行に切り詰めたプレビューしか出さず、`--full` フラグも
     `bd remember --list` も存在しない。`bd memories --json` は配列ではなく**オブジェクト**
     （key → 本文全文の文字列。`.[0]` 添字は落ち、`schema_version` の数値エントリが混ざる）(bd v1.2.1 実測)。
2. `bd list --status in_progress` で lease 切れを把握する（lease の残りは `bd show <id>`）。
   - **活動履歴を時系列で読むときは `--json` 必須** — `bd list` のテキスト出力は `--sort` を
     指定してもページ内を priority で並べ直すので、行の並びから時系列は読めない (bd v1.2.1 実測)。
   - **`bd ready` には「生きている作業」が混ざりうる**（自動 reclaim の誤発火。`bd show` には
     出ないので台帳を眺めても気付けない。`bd history <id> --events` の `lease_reclaimed` が唯一の
     痕跡）。`bd ready` の一覧だけで着手を決めず、手順どおり規律2 の worktree/ブランチ不存在確認
     まで通す。詳細と実測は failure-catalog.md `reclaimed-live-ticket`。
   - **自分が長命の worktree に居るなら、そのハーネスは作成時点で凍っている**（注入コピーは
     チェックアウト単位）。`git rev-list --count HEAD..origin/main -- .claude harness` が
     0 でなければ rebase する（3 以上で、かつ `bd/<id>` worktree なら Hygiene が
     `stale_harness_worktree` で出す。**`feature/*` 等の非チケット worktree は出ない**
     ので自分で測ること）。詳細は failure-catalog.md `stale-harness-worktree`。
3. **`bd reclaim` は原則打たない** — 正はスーパーバイザーの定期実行（例外3条件は詳細）。
4. マージ済み worktree の残骸**だけ**掃除する（判断がつかないものは触らない）。
5. `bd ready --exclude-label gt:slot` で候補を取る（**除外必須** — slot bead の claim は他
   セッションのマージを止める）。

詳細: `lease-params.md` / `worktree-pr-flow.md` / `failure-catalog.md`

## 規律2: 排他と claim — 排他の正本は worktree、claim は台帳記録

なぜ: 並列セッションは全て同じ assignee で動くため `bd update --claim` は先行 claim を検出
できず両方成功しうる。`git worktree add -b` は先着1名しか成功しない。**排他は git が裁く**。

手順（この順序を厳守）:

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

詳細: `worktree-pr-flow.md` / `lease-params.md`

## 規律3: 確認待ち — 質問はチケットに載せ、回答を待たずに次へ進む

なぜ: 質問をチャットで投げて待つと、回答が来るまでセッション全体が止まる（実際に起きた
事故）。台帳に載せればユーザーは自分のペースで回答でき、他のチケットを進められる。

手順:

1. `bd comment <id> "<質問>"` — 選択肢と帰結・推奨・回答後の再開手順まで書く。
2. `bd label add <id> human` で確認待ちレーンへ（`bd update --label` は存在しない）。
3. `bd gate create --type=human --blocks <id> --reason="<一行>"` で `bd ready` から外す
   （**`bd dep add` で代用しない**）。
4. **回答を待たず次のチケットへ。** worktree は残し、規律2 手順5の一括 heartbeat の対象に
   含め続ける。
5. 回答が来たら `bd label remove <id> human` して再開（作業チケットは close しない）。
6. **例外**: 破壊的・不可逆・外向きの操作（デプロイ・削除・push/送信・課金）はその場で確認する。

詳細: `question-template.md`

## 規律4: セッションクローズ — close はマージ成功後だけ

なぜ: PR を開いた時点で close すると `bd ready` と進捗表示が「landed していない作業を完了」
と偽り、並列セッションの判断を狂わせる。close =「main に入った」の不変条件を守る。

手順:

1. 検証 → PR → CI → マージ、まで完走する。検証コマンドは **`.claude/bdboard-harness.json`
   の `verify` → CLAUDE.md / AGENTS.md → 無ければ検証せず進めない**の順で決める。
2. **マージ成功後、`bd close` の前に証拠コメント**（`close-template.md` の書式。**`PR:` 行必須**）。
3. **その上で `bd close <id>`。マージ前に close しない**（未到達なら in_progress のまま現状
   をコメントに残す）。
4. worktree を掃除する（remove → ブランチ削除 → `git remote prune origin`）。
5. 残作業・気づきはチケット化する（`--deps discovered-from:<元>` で来歴を辺に残す）。
6. `bd dolt push` はセッション末に1回。外向き操作なので、許可が無ければ実行前に確認する。

詳細: `worktree-pr-flow.md` / `close-template.md` / `verification.md`

## 規律5: ハーネス失敗の学習ループ — 同じ失敗を二度踏まない

なぜ: 規律は過去の事故の集積であり、網羅は常に不完全。新しい失敗をその場の復旧だけで終えると
教訓は散逸し、別セッションが同じ失敗を再生産する。

手順:

1. **検知**: 成果の消失／規律どおりでの事故／手順の不遵守／既知パターンの再発 =「ハーネス失敗」。
2. **即時の最小記録**: 復旧前に証拠（エラー全文・コマンド列・worktree とチケットの状態）を、
   作業中チケットがあれば `bd comment`、無ければ scratchpad のファイルへ残す。
3. **直せないなら起票して現作業へ戻る**（`bd create --type=task --priority=2 --deps
   discovered-from:<元>` ＋ `harness` ラベル。成果消失級の再発リスクなら priority 1）。
4. **編集する層を先に決める**: 注入コピー `.claude/skills/bdboard-harness/` は**編集禁止**。
   固有の教訓は `project-harness`、汎用は `harness-upstream` チケットで正本へ還流する。
5. **検討は Fable の最大熟考で固める**。規律を変える PR はマージ前に Fable の独立レビューへ。
6. **確定した教訓は必ず failure-catalog にエントリを持つ**（本則が他所ならポインタ付きで）。

詳細: `brushup-protocol.md` / `layering.md` / `failure-catalog.md`

## 規律6: モデル振り分け — 複雑度と可用性を分ける

なぜ: 契約の `models` に従って工程ごとの候補を選ぶ。rate limit などの可用性の失敗だけで
複雑度を上げると、品質と関係なく高いセルへ移り続けるので、2 種のフローを分離する。

手順:

1. 議長が着手時に `bd show <id>` と対象の grep を各 1 回行い、次のルーブリックで推定する。
   **high の条件を優先し、迷ったら med**。
   - **low**: 対象ファイルが特定済み（または grep 1 回で確定）、1〜2 ファイル、公開契約
     （型・API・スキーマ・hook・`help-content.json` の構造）を変えない、のすべてを満たす。
   - **high**: 層をまたぐ（domain⇄interface、server⇄web）、セキュリティ境界
     （write-guard・hooks・contract parser・auth）、並列セッション整合（reclaim・merge-slot）、
     不可逆操作、のいずれかに該当する。
   - **med**: それ以外。
2. `bdboard.complexity=low|med|high` と
   `bdboard.complexity.source=declared|estimated|escalated` をメタデータに記録する。
   初回推定は `estimated`。**人間が事前に置いた declared は自動上書き禁止、降格は人間のみ**。
3. 対象プロジェクト/worktree のルートで
   `bash .claude/skills/bdboard-harness/scripts/route.sh <stage> <complexity>` を実行する。
   該当セル、未定義なら同じ工程の `*` の順に解決し、出力順で候補を試す。
   契約/`models`/工程/セルが無く無出力で成功したら、呼び出し側の従来の既定動作へ戻る。
   呼び出し側が決めた `member:model` を委譲先へ渡し、委譲先はモデルを決め打ちしない。
4. **可用性の失敗**（rate limit / bin 不在 / タイムアウト / 0 編集 2 連続）は
   **同じセルの次候補へ**。**複雑度と source は変えない**。候補が尽きたら失敗を報告する。
5. **品質の失敗**は、次の 3 トリガーだけで **low → med → high と 1 段上のセルへ**。
   `bdboard.complexity.source=escalated` を書き、`bd comment` に理由を 1 行残す。
   - (a) 委譲成果の verify が赤で、同じセルでの再委譲 1 回も赤。
   - (b) レビューの major 以上の指摘が 3 件超（4 件以上）。
   - (c) low 推定なのに当該作業の差分が 3 ファイル以上。
   high でなお失敗する場合は理由を報告する。declared の変更が必要なら、人間へ判断を返し、
   自動更新しない。品質が改善しても自動降格しない。

詳細: `model-routing.md`

## 機械ガード（hooks）— 文章で防げない操作は hook が止める

- `hooks/` の3スクリプトは、注入時に注入先の `.claude/settings.json` へ登録される。
- 止めるもの: `pkill`/`killall`、`--remote` 無しの `bd dolt push`/`pull`、`git stash`（`push -m` /
  `apply <sha>` / `list` / `drop` / `show` 以外）、二重バックグラウンド化、注入コピーの編集、
  `bd/` ブランチでの `.beads/**` 編集、コントラクトの `hooks.denyBashPatterns`、痕跡を残さない
  セッション終了。
- **hook に止められたら回避策を探さない。** stderr の代替手順に従う。hook 自体の不具合は
  `harness-upstream` チケットで起票する。
- deny 条件・fail-open 方針・settings.json 登録契約: `hooks/README.md`。

## references

`references/` の全量: worktree-pr-flow / lease-params / question-template / close-template /
verification / failure-catalog / brushup-protocol / layering / model-routing /
frontend-gotchas（web 実装の罠）。
