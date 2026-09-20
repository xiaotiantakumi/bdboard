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

**create → update の間で中断したら**: `bd gate list <id>` で当該チケットをブロックしている
gate を出し、`bd show <gate-id>` の description が `Ad-hoc gate blocking <id>` のままの
ものを見つける（**プレーンな `bd gate list`（引数なし）は全 gate を `title`/`description` 抜きで
一覧するだけで、この特定には使えない**）。`GATE_ID=<その id>` を入れ直して（シェル変数は
中断で失われている）、上の `bd update "$GATE_ID" --description` から手順をやり直す
（`bd gate create` は再実行しない — gate が二重になる）。実害は小さい（gate は残るだけで
壊れない）。

回答が来たら: bdboard の確認待ちレーンは gate と作業チケットの両方をカードとして出すため、
**回答がどちらに付くかは固定されない**（作業チケット側で回答されると gate は自動では
resolve されない — bdboard-vy0h）。`bd show <gate-id>` と `bd show <id>` の**両方**を見て
回答コメントを探す → gate がまだ open なら `bd gate resolve <gate-id>` する → `bd label
remove <id> human` → gate 本文の「回答後の再開手順」に書いた地点から作業を再開する
（作業チケットは close しない — close はマージ成功後だけ、SKILL.md 規律4）。

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

- gate の `description` に、スクリーンショット（下記の添付 API で貼った画像）か、
  プレビュー URL（空きポートでのローカルホスティング、または mobile-preview-tunnel 等の
  一時公開 URL）への導線を必ず含める。
- 確認できる環境が無い場合は「実機で確認してください」とだけ書いてユーザーに丸投げしない。
  **環境を用意するところまで自分の作業に含める**（2026-09-19、PicRill-7vh.17 で確認環境が
  無いままゲートに載り、ユーザーから「まず環境自体を用意しておいてほしい」と差し戻された
  実例がある）。
- bdboard 側のチケット本文・コメントでの画像表示そのものは別チケット bdboard-qw26 で扱う
  （bdboard-qw26 はこの規律だけでは close しない）。このテンプレが担うのは「導線を必ず
  添える」規律の側だけ。

### スクリーンショットの添付手順（bdboard-qw26 の添付画像 API）

bdboard の常駐サーバー（既定 `http://localhost:8787`。`BDBOARD_PORT` を変えている構成では
そのポート）は、任意のチケット（gate を含む）へ画像を添付する API を持つ。POST 後は
チケット詳細の「添付画像」セクションに自動で出る（追加の API 呼び出し不要）。

**body は一旦ファイルに書いてから `--data-binary @file` で送る。** コマンド置換で直接
`-d` に埋め込む形 (`-d "{...$(base64 -i screenshot.png)...}"`) は、Retina のスクショ等で
base64 が大きくなると macOS の `ARG_MAX`（シェル引数長上限）に当たりうる。ファイル経由
ならその制約を受けない。

```bash
BDBOARD_BASE_URL="http://localhost:8787"   # BDBOARD_PORT を変えている場合はポートも合わせる
TICKET_ID="<画像を見せたいチケット/gate の id>"   # 選び方は次節「gate のときはどちらに貼るか」

python3 -c "
import json, base64, sys
data = open('screenshot.png', 'rb').read()
json.dump({'mimeType': 'image/png', 'data': base64.b64encode(data).decode('ascii')}, sys.stdout)
" > /tmp/attachment-body.json

curl -sS -X POST -H 'Content-Type: application/json' \
  --data-binary @/tmp/attachment-body.json \
  "$BDBOARD_BASE_URL/api/tickets/$TICKET_ID/attachments"
```

- `mimeType` は `image/png` / `image/jpeg` / `image/webp` / `image/gif` のみ。判定は
  拡張子ではなくマジックバイトで行われるので、間違った `mimeType` を申告しても 400 になる。
- サイズ上限は 1 枚 10MB（デコード後）、1 チケットあたり 20 枚まで。超えると 400 / 409。
- **base64 に改行を含めないこと。** サーバーのデコーダは RFC 4648 の正規形しか受け付けず、
  1 文字でも改行が混じると 400 で弾かれる（実機確認済み: 改行入り base64 を送ると
  `"invalid or unsupported image data"`）。
  - macOS の `base64 -i screenshot.png` は既定で改行を入れない（`-b`/`--break` の既定値が
    `0` = unbroken stream。実機確認済み）。
  - GNU coreutils の `base64`（Linux）は既定で 76 桁ごとに改行を入れる。`-w0`
    （`--wrap=0`）を付けて無効化する必要がある。このフラグは GNU 専用で macOS には無い。
  - OS を問わず動かしたいなら、上の python3 例のように `base64.b64encode(...).decode()`
    を直接使うのが確実（改行が入り得ない）。
- **localhost からの直アクセスなら追加のトークンは不要。** write-guard
  (`src/interface/http/write-guard.ts` + `local-request.ts`) は、ループバック接続
  (127.0.0.1/::1) かつ `Host` ヘッダが期待どおり（`localhost`/`127.0.0.1`/`[::1]` +
  実際に listen しているポート）であれば、Basic Auth 等を要求せず書き込みを許可する
  （DNS rebinding 対策として `Host` の一致だけは見る）。トンネル経由（cloudflared の
  転送ヘッダが付く場合）は別ルートで強パスワード+セッション Cookie が要る。
- **チケット ID はどのプロジェクトのものでもよく、プロジェクトを指定する必要はない。**
  サーバーはスキャン済みの全プロジェクトを横断してチケット ID を探す
  (`findProjectRootPathForTicket`)。bdboard 以外のプロジェクト（PicRill 等）で作業して
  いるエージェントも、そのプロジェクト自身のチケット ID をそのまま `TICKET_ID` に渡せば
  よい（8787 とは別ポートで一時起動したサーバーに対し、他プロジェクトの実チケット ID へ
  GET して 404 にならないことを確認済み — bdboard-c6al 検証）。

### gate のときはどちらに貼るか — gate 本体と作業チケットの両方に POST する

`bd gate create` で human gate を作ると、確認待ちレーンには **gate 自身のカードと、
それがブロックしている作業チケットのカードが別々に**並ぶ（どちらも独立に「確認待ち」
バッジが付く）。ユーザーがどちらのカードを開いて詳細パネルを見るかは固定されない —
本ファイル「手順（SKILL.md 規律3 の実体）」節にある「回答がどちらに付くかは固定されない」
（gate 解決時の既知の非対称性）と同じ理由による。そのため、視覚確認の画像は
**gate の id と、ブロックしている作業チケットの id の両方へ POST する**（同じ画像を
2回 upload してよい。添付枚数の上限 20/チケットには十分余裕がある）。gate を使わず
質問専用チケット/作業チケット直付けで確認を求める場合は、その1チケットの id にだけ
POST すればよい。

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
<スクショを添付した場合はその旨（手順は本ファイル「スクリーンショットの添付手順」節。
 gate なら gate 本体と作業チケットの両方に POST 済みと明記）、プレビューURLがあれば
 それも書く。無ければどう用意したかをここに書く。視覚確認が不要ならこの節ごと省いてよい>

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
