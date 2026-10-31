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

```bash
python3 scripts/ask-human-gate.py --spec <spec.json> [--review-after <先に見てほしいid>] [--dry-run]
```

`bd gate create`・`bd update --description`・`bd comment`・`bd label add human` を 1 本で
行い、最終行に gate id を出す。spec のキー・必須・上限は `--help`（正本は
`scripts/ask-human-gate.schema.json`）。本文の見出し（決めてほしいこと / 背景 / 選択肢 /
推奨 / 視覚的な確認 / 回答後の再開手順）はスクリプトが組み立てる。違反（選択肢が 2 件未満・
帰結なし・推奨も理由もない・worktree が実在しない等）は `ERROR: spec.<path>: <理由>` を
全件出して終了し、bd は 1 つも呼ばない。`--dry-run` で本文だけ確認できる。

理由 1 行: `--reason` を渡すと bd が定型文を前置するので、本体は create 後の
`--description` で上書きする（スクリプトが担う）。確認の順番は `--review-after`
（`bdboard.review_after`）で付け、`bd dep add` は使わない（回答後にブロックレーンへ落ちる。
bdboard-iuiu）。途中で失敗したら gate は作成済みなので `gate create` を再実行せず、
失敗した `bd` だけ手で打ち直す。

回答が来たら: 回答は gate と作業チケットのどちらに付くか固定されない（bdboard-vy0h）。
`bd show` を**両方**見て回答コメントを探し、gate がまだ open なら `bd gate resolve <gate-id>`
→ `bd label remove <id> human` → 再開手順から再開する（作業チケットは close しない）。

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

## description は「今の依頼」だけ・経緯は notes へ（bdboard-xfi7、2026-10-22 ユーザー決定）

gate だけでなく、確認待ちに載せる作業チケットの `description` も同じ扱いにする。
**description = 今みてほしいこと（今の依頼・今の状態）だけ。** 前回の質問・回答・訂正を
description の上や下に積み足さない — 積み上がると、ユーザーはどこが今の依頼か探す羽目になる。

経緯は bd の `notes` に日付付きで追記する。**書き換える前に、旧 description の要点を
notes へ移してから** description を全文置換する（順番を逆にすると経緯が消える）:

```bash
bd update <id> --append-notes "$(date +%F): <旧 description の要点。誰が何を決めた/何が変わったか を1〜3行>"
bd update <id> --description "$(cat <<'EOF'
<今の依頼だけを全文で書き直した本文>
EOF
)"
```

- `--append-notes` は既存の notes に改行区切りで足す。`--notes` は**全置換**なので使わない。
- notes の各記録は行頭を `YYYY-MM-DD` で始める。bdboard の詳細パネルはこの日付から
  「これまでの経緯」の件数と最終日を数え、notes を閉じた状態で description の下に出す。
- 回答そのものはコメントに残ってよい（回答フォームはコメントとして記録する）。notes には
  「その回答で何が決まったか」の要点だけを書く。

## 確認チケット・gate の description は先頭に「## 今回見てほしいもの」を置く（bdboard-efw5）

確認待ちに載せる**確認チケットと gate の `description` は、先頭に `## 今回見てほしいもの` を
置く。** 次の3点を書く: (1) 見る対象の場所（パス・URL・添付）、(2) 見るポイント、(3) 判断して
ほしいこと。参考資料・疑い一覧・背景はこの節の**下**に置く。

理由: 見てほしい通しの動画が「参考」扱いで長い一覧の下に埋もれ、ユーザーから「確認して
ほしいことが一番上にない」と指摘された（news-caster-blender-nuy、2026-10-31）。

**gate と確認だけのチケットの使い分け**: 確認だけのチケット（見て OK/NG を返すだけ）は
`human` ラベルを直付けでよい。gate は、別の作業を止める判断待ちのときに使う。

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
- bdboard 側のチケット本文・コメントでの画像表示は bdboard-qw26 で実装済み（下記
  「スクリーンショットの添付手順」節）。このテンプレが担うのは「導線を必ず添える」規律の
  側だけ。

### 動画の確認（bdboard-efw5）

動画で確認を求めるときは、次の順に並べる。

- **通しの動画を先**、**直した箇所の確認動画を次**に置く。どちらも「今回見てほしいもの」節に書く。
- どちらも**再生できるパスか導線**（ローカルパス・プレビュー URL・添付）を添える。ファイル名
  だけでは再生できない。
- 修正確認で再度出すときは、前回の内容を description の下に残さない。経緯は `notes` へ移し
  （前節「description は「今の依頼」だけ」の手順）、description は今回の動画だけにする。
- 本文の組み立て・notes への退避・human ラベル付き作成は `scripts/post-review-ticket.py` に
  任せられる（`--spec <json>` に動画のパス・見るポイント・判断してほしいことを渡す。
  `--dry-run` で本文だけ確認。キーと制約は同じ `scripts/post-review-ticket.schema.json` が正本で、
  `--help` にも出る。動画パスの実在・points/decision の必須・行数上限などに違反した spec は、
  理由を 1 件ずつ出して非 0 終了する）。

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

BODY_FILE="$(mktemp)"   # 固定パスにしない(並列セッションの取り違え防止)
python3 -c "
import json, base64, sys
data = open('screenshot.png', 'rb').read()
json.dump({'mimeType': 'image/png', 'data': base64.b64encode(data).decode('ascii')}, sys.stdout)
" > "$BODY_FILE"

curl -sS -X POST -H 'Content-Type: application/json' \
  --data-binary @"$BODY_FILE" \
  "$BDBOARD_BASE_URL/api/tickets/$TICKET_ID/attachments"
```

- 成功すると `201` + `{"attachment":{"fileName":...,"url":...}}`。`bd gate create` /
  `bd create` の直後だと、bdboard 側のプロジェクトキャッシュ更新がまだ追いついておらず
  一時的に `404 ticket not found` になることがある。数秒待って再試行し、それでも 404 なら
  そのプロジェクトが bdboard のスキャン対象に入っているか確認する。
- `mimeType` は `image/png` / `image/jpeg` / `image/webp` / `image/gif` のみ。判定は
  拡張子ではなくマジックバイトで行われるので、間違った `mimeType` を申告しても 400 になる。
- サイズ上限は 1 枚 10MB（デコード後）、1 チケットあたり 20 枚まで。デコード後 10MB
  超は 400、JSON body 自体が 14MB を超えるとデコードより先に 413 (`request body too
  large`) になる、枚数超過は 409。
- **base64 に改行を含めないこと。** サーバーのデコーダは RFC 4648 の正規形しか受け付けず、
  1 文字でも改行が混じると 400 で弾かれる（実機確認済み: 改行入り base64 を送ると
  `"invalid or unsupported image data"`）。
  - macOS の `base64 -i screenshot.png` は既定で改行を入れない（`-b`/`--break` の既定値が
    `0` = unbroken stream。実機確認済み）。素の `base64 screenshot.png`（`-i` 無し）は
    macOS では「入力ファイルが無い」エラーになる点に注意 — 必ず `-i` を付けるか標準入力に
    流し込む。
  - GNU coreutils の `base64`（Linux）は既定で 76 桁ごとに改行を入れる点が macOS と違う。
    `-w0`（`--wrap=0`）で無効化できる（macOS の base64 も GNU 互換でこのフラグ自体は
    受け付けるが、そもそも既定が改行無しなので付ける意味が無い — 違うのはフラグの有無では
    なく既定値の方）。
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
**gate の id と、ブロックしている作業チケットの id の両方へ POST する**（同じ
`$BODY_FILE` を使い回して 2 回 upload してよい。添付枚数の上限 20/チケットには十分
余裕がある）:

```bash
for TICKET_ID in "$GATE_ID" "<ブロックされている作業チケットの id>"; do
  curl -sS -X POST -H 'Content-Type: application/json' \
    --data-binary @"$BODY_FILE" \
    "$BDBOARD_BASE_URL/api/tickets/$TICKET_ID/attachments"
done
```

gate を使わず質問専用チケット/作業チケット直付けで確認を求める場合は、その1チケットの
id にだけ POST すればよい。

## なぜ `bd gate` なのか — `bd dep add` で代用できない理由

**`bd dep add` で代用しないこと。** 「回答が来るまで親チケットにぶら下げておけばいい」と
`bd dep add <id> <親id>` を張ろうとすると、その2者間に既に別タイプの辺（典型的には、親の
作業中に発見して起票したときの `discovered-from`）があると
`dependency ... already exists with type "discovered-from" (requested "blocks")` で**失敗する**
（bd 1.2.1 で実測、bdboard-axl）。bd は同じ向きの2者間に複数タイプの辺を持てず、通すには
`bd dep remove` が要る = 発見元の来歴を消すことになる。一方 `bd gate` は **`Gate: human`
という新しいノードを作ってそこへ `blocks` 辺を張る**ので、辺の相手が親チケットではなく別の
ノードになり、既存の来歴と衝突しない。これが手順1（スクリプト）が `bd dep` ではなく `bd gate` である理由。
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

## ノンブロッキングの規律（SKILL.md 規律3 手順2・4・5 の実体。質問専用チケットの本則もここ）

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
