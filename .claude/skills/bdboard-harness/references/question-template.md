# 確認待ちゲートのテンプレ

質問は「後から、この文面だけで判断できる」粒度で書く。ユーザーは数時間〜数日後に文脈
ゼロで読む。チャット履歴やセッション内の暗黙知に依存した質問は回答不能になり、確認待ち
レーンに滞留する。

## 正本は gate 本体 — 作業チケット側には1行のポインタだけ

**質問の正本は gate の `title`/`description`。** 作業チケット側の `bd comment` に全文を
書かない。二重管理は同期漏れの温床になる（bdboard-p5l.26）。

過去の悪い実例（PicRill の `bd gate list`）:

```
○ PicRill-3ao - human
```

`bd gate create --type=human --blocks <id>` に `--title`/`--reason` を渡さず、質問本文は
ブロックされた作業チケット側の `bd comment` にだけ書いていた。gate カードを開いても
`Ad-hoc gate blocking <id>` としか出ず、ユーザーは中身が分からない。

良い実例（同じ PicRill、`bd show PicRill-3ao` / `PicRill-iua` / `PicRill-hc2`。テンプレの
出典であり、そのまま転記するものではない）: gate の `description` に「決めてほしいこと・
選択肢と帰結・推奨・回答後の再開手順」まで載っている。`bd gate list` を見ただけでは分から
なくても、`bd show <gate-id>` 1回で完結する。

## 手順（SKILL.md 規律3 の実体）

`--reason` はそのまま渡すと `bd` 側が "Ad-hoc gate blocking <id>\n\nReason: <reason>" という
定型文を前置してしまう（bd 1.2.1 で実測）。良い実例のような素のテンプレ本文にするには、
**作成時は `--title` だけ渡し、本体は直後の `bd update --description` で上書きする**。

```bash
GATE_ID=$(bd gate create --type=human --blocks <id> \
  --title "Gate: <一行: 何を決めてほしいか>" --json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"] if isinstance(d, dict) else d[0]["id"])')

bd update "$GATE_ID" --description "$(cat <<'EOF'
<下のテンプレで書いた質問本文>
EOF
)"

bd comment <id> "質問は gate $GATE_ID を参照（bd show $GATE_ID）"
bd label add <id> human
# → 回答を待たずに次の ready へ進む
```

回答が来たら: gate が resolve されているのを確認 → `bd show <gate-id>` で回答コメントを
読む → `bd label remove <id> human` → gate 本文の「回答後の再開手順」に書いた地点から
作業を再開する（作業チケットは close しない — close はマージ成功後だけ、SKILL.md 規律4）。

## 質問が変わったとき — 訂正コメントを積まない、gate 本体を全文書き換える

実例: PicRill-mac は 21:21 の手順を 21:27 のコメントで全面訂正しており、両方読まないと
正しい手順に辿り着けなかった（作業チケットのコメント欄に時系列で訂正を積んだのが原因）。

gate は bead の一種なので、通常の `bd update` で本体を書き換えられる。**追記ではなく
全文置換**にする（差分コメントを積むと、複数の時点をまたいで読まないと最新の依頼が
分からなくなる）:

```bash
bd update <gate-id> --title "Gate: <更新後の一行>" --description "$(cat <<'EOF'
<更新後の本文全体。差分ではなく全文で書き直す>
EOF
)"
```

書き換えた事実は `bd comment <gate-id> "本文を更新"` の1行だけ残してよい。ただし判断材料
の本体は必ず `description` 側に一本化し、「最新が常に1つ」を保つ。

## 視覚的な確認を求めるとき — スクショ/プレビューへの導線を必ず添える（bdboard-qw26）

実機・見た目の確認を human gate に載せるときは、ユーザーが**画面を見るだけ**で回答できる
状態にする。

- gate の `description` に、スクリーンショット（PR やコメントに添付できる形）か、
  プレビュー URL（空きポートでのローカルホスティング、または mobile-preview-tunnel 等の
  一時公開 URL）への導線を必ず含める。
- 確認できる環境が無い場合は「実機で確認してください」とだけ書いてユーザーに丸投げしない。
  **環境を用意するところまで自分の作業に含める**（2026-09-19、PicRill-7vh.17 で確認環境が
  無いままゲートに載り、ユーザーから「まず環境自体を用意しておいてほしい」と差し戻された
  実例がある）。
- bdboard 側のチケット本文・コメントでの画像表示そのものは別チケット bdboard-qw26 で扱う
  （bdboard-qw26 はこの規律だけでは close しない）。このテンプレが担うのは「導線を必ず
  添える」規律の側だけ。

## なぜ `bd gate` なのか — `bd dep add` で代用できない理由

**`bd dep add` で代用しないこと。** 「回答が来るまで親チケットにぶら下げておけばいい」と
`bd dep add <id> <親id>` を張ろうとすると、その2者間に既に別タイプの辺（典型的には、親の
作業中に発見して起票したときの `discovered-from`）があると
`dependency ... already exists with type "discovered-from" (requested "blocks")` で**失敗する**
（bd 1.2.1 で実測、bdboard-axl）。bd は同じ向きの2者間に複数タイプの辺を持てず、通すには
`bd dep remove` が要る = 発見元の来歴を消すことになる。一方 `bd gate` は **`Gate: human`
という新しいノードを作ってそこへ `blocks` 辺を張る**ので、辺の相手が親チケットではなく別の
ノードになり、既存の来歴と衝突しない。これが手順1が `bd dep` ではなく `bd gate` である理由。
（gate が依存グラフの外にあるわけではない点に注意 — gate ノードは `bd dep tree <id>` に
`[blocks]` の辺として現れる。）

なお gate は「別チケットの完了待ち」を表現する道具ではない。`bd gate create --type` は
human / timer / gh:run / gh:pr のみで、bead の close を待つ gate は作れない（bd 1.2.1）。
human gate は親が close しても自動解除されず `bd gate resolve` が要るので、ここで使うのは
**ユーザーの回答待ち**に限る。

## bd 1.2.1 のフラグの落とし穴

- `bd label add <id> human`（手順3）を `bd update <id> --label human` と書くと
  `unknown flag: --label` で落ちる。`bd update` 側のラベル操作は `--add-label` /
  `--remove-label`。
- `bd gate create --reason "<本文>"` は素の本文にならない（前節の定型文の前置）。gate の
  `description` を素のテンプレ本文にしたいときは `--reason` を使わず `bd update --description`
  で上書きする。

## ノンブロッキングの規律（SKILL.md 規律3 手順4・6・7 の実体。質問専用チケットの本則もここ）

- **回答をチャットで待たない。** そのまま `bd ready` の次のチケットへ進む。ブロックした
  チケットの worktree は残してよい（撤退不要。gate 解除後に再開する）。
- ただしブロック中もそのチケットは in_progress のまま自分の保持下にある —
  規律2 手順5の**一括 heartbeat の対象に含め続ける**（外すと reclaim に回収される）。
- 回答が来たら（gate resolve + コメント）、`bd label remove <id> human` してから作業を
  再開する。作業チケット直付けの質問では、回答が来ても作業チケットを close しない
  （close はマージ成功後だけ — SKILL.md 規律4）。
- **例外 — その場で確認するもの**: 破壊的・不可逆・外向きの操作（本番デプロイ、データ削除、
  push/publish/送信、課金）は、レーンに載せて先へ進む方式にしない。実行前にその場で
  ユーザーに確認する。確認待ちの間、**その操作に依存しない別チケット**を進めるのは構わない。

## テンプレ（gate の `description` にそのまま書く本文）

```markdown
## 決めてほしいこと
<1〜2文。疑問文で明確に。「どうしましょう」ではなく選択式に落とす>

## 背景
<2〜4行。なぜこの判断が必要になったか。関連ファイル・チケットがあればIDで参照>

## 選択肢
- **A: <案>** — 帰結: <採ったらどうなるか。コスト/リスク>
- **B: <案>** — 帰結: <同上>
- (C: <案> — 帰結: <同上>)

## 推奨
<AかBか + 理由1行。推奨が無いなら「判断材料が拮抗しており推奨なし」と明記>

## 視覚的な確認が要る場合
<スクショの添付先、またはプレビューURL。無ければどう用意したかをここに書く。
 視覚確認が不要ならこの節ごと省いてよい>

## 回答後の再開手順
<回答を受けたセッションが何をすればよいか。worktree のパス、着手済みの変更の場所、
 選択肢ごとに分岐するなら「Aなら〜、Bなら〜」まで書く>
```

## 書き方の規律

- **`--title`/`description` を省かない。** 省くと全ゲートが `Gate: human` /
  `Ad-hoc gate blocking <id>` という区別のつかない見た目になる（bdboard-p5l.26 の実例）。
- **選択肢は帰結つきで**。「AとBどちらにしますか」だけでは判断材料にならない。各選択肢を
  選んだ場合に何が起き、何を失うかを1行ずつ付ける。
- **推奨を出す**。エージェントが一番文脈を持っている時点で書いているのだから、判断の
  下書きまで済ませる。ユーザーの仕事は承認/差し替えだけにする。
- **自由記入で答えられる質問にしない**（できる限り）。回答が構造化されるほど、再開する
  セッション（自分とは限らない）が迷わない。
- **再開手順を省かない**。回答時点で元のセッションは死んでいる前提。worktree の場所と
  途中状態を書いていないと、回答が来ても再開コストが跳ね上がる。
- **視覚的な確認にはスクショ/プレビュー導線を添える**（前節）。無ければ用意するところまで
  作業に含める。
- 特定チケットに紐づかない横断的な確認は、このテンプレで**質問専用チケット**を切って
  human ラベルを付ける。質問専用チケットへの回答は `bd comment <id> "<回答>"` で本文を
  書き、続けて `bd close <id>` でチケットごと閉じる。**`bd human respond` は使わない** —
  upstream の respond/dismiss はストア初期化を経ずに実行される "storage is nil" regression を
  抱えており確定的に失敗するため、comment+close の2コマンドへ置換済み（bdboard の
  「回答を送信」も同じ置換で動く）。作業チケット直付けの質問では、回答が来ても作業チケットを
  close しないこと（close はマージ成功後だけ — SKILL.md 規律4）。
