# 確認待ちゲートのテンプレ

質問は「後から、この文面だけで判断できる」粒度で書く。ユーザーは数時間〜数日後に文脈ゼロで読む。
チャット履歴やセッション内の暗黙知に依存した質問は回答不能になり、確認待ちレーンに滞留する。

## 操作はスクリプト（SKILL.md 規律3 の実体）

| 目的 | 呼ぶもの | 備考 |
|---|---|---|
| 別の作業を止める判断待ち | `python3 scripts/ask-human-gate.py --spec <json> [--review-after <id>] [--dry-run]` | gate 作成 → description → コメント → human ラベルまで一括。最終行が gate id |
| 見て OK/NG を返すだけの確認（動画・画面など） | `python3 scripts/post-review-ticket.py --spec <json> [--dry-run]` | 本文の組み立て・notes への退避・human ラベル付き作成。`human` 直付けのチケット |

キー・必須・上限は各スクリプトの `--help`（正本は `scripts/ask-human-gate.schema.json` /
`scripts/post-review-ticket.schema.json`）。本文の見出し（決めてほしいこと / 背景 / 選択肢 / 推奨 /
視覚的な確認 / 回答後の再開手順）はスクリプトが組み立て、選択肢が 2 件未満・帰結なし・推奨も理由もない・
worktree が実在しない・動画パスが実在しない等の違反は `ERROR: spec.<path>: <理由>` で全件拒否する。
どちらも worker が使ってよい。途中で失敗したら gate は作成済みなので作り直さず、失敗した `bd` だけ手で打ち直す。

なぜスクリプトか: `--title`/`--reason` を省くと全 gate が `Gate: human` と同じ見た目になり中身が読めない（bdboard-p5l.26）。
`--reason` は bd が定型文を前置するので本体は create 後の `--description` で上書きする。確認の順番は
`--review-after`（`bdboard.review_after`）で付け、`bd dep add` は使わない（回答後にブロックレーンへ落ちる。bdboard-iuiu）。

## 何を確認してもらうか（判断の基準）

- **質問の正本は gate 本体の title/description。** 作業チケットの `bd comment` に全文を書かない（二重管理は同期漏れ）。
- **選択肢は帰結つきで**（選んだら何が起き、何を失うか）。**推奨を出す**（ユーザーの仕事は承認/差し替えだけにする）。
  自由記入で答える質問にしない。**再開手順を省かない**（回答時点で元のセッションは死んでいる前提。worktree の場所と途中状態を書く）。
- **gate と確認だけのチケットの使い分け**: 別の作業を止める判断待ち = gate、見て返すだけ = `human` 直付けのチケット。
  特定チケットに紐づかない横断的な確認は質問専用チケットを切る。
- **description は先頭に `## 今回見てほしいもの`**（見る対象の場所・見るポイント・判断してほしいこと）。参考資料・背景はその下。
  通しの動画が参考扱いで一覧の下に埋もれた事例（news-caster-blender-nuy、2026-10-31、bdboard-efw5）。
- **description = 今の依頼だけ。** 質問が変わったら訂正コメントを積まず、旧本文の要点を
  `bd update <id> --append-notes "$(date +%F): <要点 1〜3 行>"` で notes へ移してから description を全文置換する
  （順序を逆にすると経緯が消える。`--notes` は全置換なので使わない。行頭は `YYYY-MM-DD`。bdboard-xfi7）。
- **視覚的な確認にはスクショ/プレビューへの導線を必ず添える**（bdboard-qw26）。確認できる環境が無いなら「実機で確認してください」と丸投げせず、
  環境を用意するところまでを作業に含める（PicRill-7vh.17 で差し戻された実例）。動画は通しを先、直した箇所を次に置き、
  どちらも再生できるパスか導線を添える（ファイル名だけは不可。bdboard-efw5）。
- **例外 — その場で確認するもの**: 破壊的・不可逆・外向きの操作（本番デプロイ、データ削除、push/publish/送信、課金）は
  レーンに載せて先へ進まない。実行前にその場でユーザーに確認する。待つ間、その操作に依存しない別チケットを進めるのは構わない。

## ノンブロッキングの規律（規律3 手順2・4・5）

- **回答をチャットで待たない。** `bd ready` の次のチケットへ進む。ブロックしたチケットの worktree は残してよい。
- ブロック中も in_progress のまま自分の保持下にある — **一括 heartbeat の対象に含め続ける**（外すと reclaim に回収される）。
- 回答が来たら: 回答は gate と作業チケットのどちらに付くか固定されない（bdboard-vy0h）。`bd show` を**両方**見て回答コメントを探し、
  gate が open なら `bd gate resolve <gate-id>` → `bd label remove <id> human` → 再開手順から再開する。作業チケットは close しない
  （close はマージ成功後だけ。規律4）。
- 質問専用チケットへの回答は `bd comment <id> "<回答>"` → `bd close <id>`。**`bd human respond` は使わない**（upstream の
  "storage is nil" regression で確定的に失敗する）。

## なぜ `bd gate` で `bd dep add` ではないか

`bd dep add <id> <親id>` は、2 者間に既に別タイプの辺（典型は `discovered-from`）があると
`dependency ... already exists with type "discovered-from"` で失敗し、通すには来歴の辺を消すことになる（bd 1.2.1、bdboard-axl）。
`bd gate` は `Gate: human` という別ノードへ `blocks` 辺を張るので既存の来歴と衝突しない。gate は別チケットの close 待ちには使えない
（`--type` は human / timer / gh:run / gh:pr のみ）。ここで使うのはユーザーの回答待ちに限る。

bd 1.2.1 の落とし穴: `bd update` のラベル操作は `--add-label` / `--remove-label`（`--label` は unknown flag）。

## スクリーンショットの添付（bdboard-qw26 の添付画像 API）

bdboard の常駐サーバー（既定 `http://localhost:8787`、`BDBOARD_PORT` で変わる）は任意のチケット（gate を含む）へ画像を添付できる。
POST 後は詳細の「添付画像」に自動で出る。

- body は一旦ファイルに書き `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @"$BODY_FILE" "$BASE/api/tickets/$TICKET_ID/attachments"`
  で送る（`-d` に base64 を埋めると `ARG_MAX` に当たりうる）。body は `{"mimeType":"image/png","data":"<base64>"}`。
  base64 は改行無しで作る（python3 の `base64.b64encode(...).decode()` が確実。macOS の `base64 -i` は既定で無改行、GNU は `-w0`）。改行入りは 400。
- `mimeType` は png / jpeg / webp / gif。判定はマジックバイト。1 枚 10MB（デコード後）・1 チケット 20 枚まで（超過は 400 / 413 / 409）。
- `bd create` / `bd gate create` の直後は一時的に `404 ticket not found` になることがある。数秒待って再試行する。
- localhost からの直アクセスなら追加のトークンは不要（write-guard がループバックを許可）。チケット ID はどのプロジェクトのものでもよい。
- **gate のときは gate 本体と、ブロックしている作業チケットの両方へ POST する**（ユーザーがどちらのカードを開くかは固定されない）。
