---
name: bdboard-harness
description: .beads/ を持つプロジェクトでチケット作業・自律作業・並列セッション作業を始めるときに必ず適用する作業規律。セッション開始(bd prime→stale lease確認→bd ready)、worktree-first排他とclaim規律、確認待ちのノンブロッキング化(bd human+human gate)、セッションクローズの4規律を定める。
---

# bdboard-harness — bd 運用プロジェクトの自律作業規律

## 前提

- 対象は `.beads/` を持つ（= bd で作業台帳を管理している）プロジェクト。ユーザーが同じ
  プロジェクトで**複数のエージェントセッションを同時に**走らせている前提で書かれている。
  単独セッションでも同じ規律を守る（いつ並列になるか自分からは分からない）。
- **プロジェクト固有の値はこの文書に書かない。** 検証コマンド（ビルド・テスト・lint）、
  ブランチ命名、マージ方式、サーバー/ポートの取り扱いは、注入先プロジェクトの
  CLAUDE.md / AGENTS.md に従う。この skill はそれらの「回し方の規律」だけを定める。
- 本文は要点のみ。手順の詳細は references/ にあり、本文から参照する。この skill 単体で
  成立するように書かれている（グローバル skill の有無に依存しない）。

## 規律1: セッション開始 — prime → stale lease 確認 → ready

なぜ: 死んだセッションの取り残し（stale lease・worktree 残骸）を見ないまま着手すると、
「in_progress だが誰も作業していない」チケットを永久に避け続けるか、逆に生きている作業を
横取りするかのどちらかの事故になる。

手順:

1. `bd prime` — 台帳のコンテキストとプロジェクトメモリを読み込む。
2. stale lease の確認。`bd list --status in_progress` で in_progress を眺め、lease が
   切れて久しいものが無いか見る（`bd show <id>` に lease の残りが表示される）。
   - **回収（`bd reclaim`）の正はスーパーバイザーの定期実行**（bdboard 併用プロジェクト
     では bdboard サーバーが担う）。自分で `bd reclaim` を打つのは、(a) スーパーバイザーが
     動いていない、かつ (b) lease 失効から猶予窓（≈ TTL×2）を十分過ぎている、かつ
     (c) worktree 側の証拠（後述の放棄裏取り）も揃った場合だけ。**欲しいチケットを空ける
     目的で reclaim しない。**
   - 詳細と既定パラメータ: [references/lease-params.md](references/lease-params.md)
3. マージ済み worktree の残骸があれば掃除する（`git worktree list` を一覧し、対応ブランチが
   既に main へ取り込まれているものだけ remove。判断がつかないものは触らない）。
4. `bd ready --exclude-label gt:slot` — 着手可能なチケットを取得する。選び方は規律2へ。
   - `--exclude-label gt:slot` は必須。`bd merge-slot` の slot bead は「空き = status=open・
     priority=0」で状態を表すため、素の `bd ready` では**先頭に**載る。これを「最優先の
     着手可能チケット」として claim すると、slot を保持したことになり**他セッションの
     マージを止める**副作用が出る（実測: bdboard-9k3）。

## 規律2: 排他と claim — 排他の正本は worktree、claim は台帳記録

なぜ: 並列セッションは全て**同じユーザー（同じ assignee）**で動くため、`bd update --claim`
のアトミック性（CAS）は先行 claim を検出できず、**両方成功しうる**（さらに `--claim` は
`--if-status` / `--if-assignee` と併用不可で、ガード付きの1コマンドは書けない）。一方
`git worktree add -b <branch>` は、既存ブランチ/worktree があれば git が拒否するので、
先着1名だけが成功する。よって**排他はチケット台帳ではなく git が裁く**。

手順（この順序を厳守）:

1. **着手前の空き確認（両方見る）**: 候補チケットについて
   `ls <worktree置き場>/<id>` と `git rev-parse --verify <ブランチ名>` の両方が
   「存在しない」ことを確認する（ブランチだけ先に存在するケースがあり、片方だけでは
   取りこぼす）。worktree の置き場・ブランチ命名はプロジェクト規約に従う
   （既定の推奨: `.claude/worktrees/<id>/` と `bd/<id>`）。
2. **worktree 作成 = 排他獲得**: `git worktree add <path> -b <branch>` を実行する。
   **成功したら勝ち。失敗（既存）なら負け** — そのチケットは別セッションが着手中とみなし、
   次の候補へ回る。
3. **成功して初めて claim**: `bd update <id> --claim`。claim は「誰が何をやっているか」の
   台帳記録であって排他ではない。worktree より先に claim を打たない（claim だけ通って
   worktree で負けると、台帳だけ汚れる）。
4. **作業中は heartbeat を打ち続ける**: `bd heartbeat <id>` を lease TTL より十分速い間隔で
   （目安 TTL/3 以下、かつどれだけ TTL が長くても 5 分以下。長いビルド/テストの前後にも1回）。
   heartbeat が**失敗したら自分はもう所有者ではない** — 直ちに手を止めて `bd show <id>` で
   状況を確認する（[references/lease-params.md](references/lease-params.md)）。
   - **複数チケットを並行して in_progress で保持しているとき**（gate 待ちに載せて次へ進んだ、
     委譲を投げて別チケットへ移った等）は、「いま触っているチケットだけ」ではなく
     **全 in-flight チケットへ同じ周期で一括して打つ**:

     ```bash
     for id in <id1> <id2> <id3>; do bd heartbeat "$id"; done
     ```

     アクティブな1枚だけ延命する癖は、残りの保持チケットの lease を静かに失効させ、
     reclaim の誤発火（生きている並行作業の回収）を招く（実測: 8並列運用で発生 —
     bdboard-3tw.99 / bdboard-l1t.4）。詳細:
     [references/lease-params.md](references/lease-params.md)
5. **負けたときの振る舞い**: 相手の in_progress を open に戻さない（先行セッションが実作業中
   である以上 in_progress は事実として正しい）。相手のプロセスも kill しない。誤って作業して
   しまっていたら成果を patch に退避して撤退する。
6. **worktree の存在だけで「放棄」と断定しない**: 空の worktree は「作成直後・エージェント
   起動直前」でもありうる。放棄の裏取りは lease 失効＋猶予経過に加えて、`git status` が
   空・`lsof` でプロセス無し・チケット `updated_at` が古い、を揃えてから
   （詳細: [references/lease-params.md](references/lease-params.md)）。

worktree 作成から PR・マージまでの全体フロー:
[references/worktree-pr-flow.md](references/worktree-pr-flow.md)

## 規律3: 確認待ち — 質問はチケットに載せ、回答を待たずに次へ進む

なぜ: ユーザーへの質問をチャットで投げて回答を待つと、回答が来るまでセッション全体が
止まる（実際に起きた事故）。質問を台帳に載せれば、ユーザーは自分のペースで回答でき、
エージェントは他のチケットを進められる。

手順:

1. ユーザー判断が必要になったら、**自分のチケットに質問コメントを書く**:
   `bd comment <id> "<質問本文>"`。本文は後から単体で判断できる粒度で書く
   （何を決めてほしいか・選択肢と帰結・推奨。テンプレ:
   [references/question-template.md](references/question-template.md)）。
2. `bd label add <id> human` — 確認待ちレーン（bdboard の awaiting_human）に載せる。
3. `bd gate create --type=human --blocks <id> --reason="<一行要約>"` — human gate で
   チケットを blocked 化し、`bd ready` から外す（回答が来るまで誰も誤って着手しない）。
4. **回答をチャットで待たない。** そのまま `bd ready` の次のチケットへ進む。
   ブロックしたチケットの worktree は残してよい（撤退不要。gate 解除後に再開する）。
   ただしブロック中もそのチケットは in_progress のまま自分の保持下にある —
   規律2 手順4の**一括 heartbeat の対象に含め続ける**（外すと reclaim に回収される）。
5. 回答が来たら（gate resolve + コメント）、`bd label remove <id> human` してから作業を
   再開する。
6. **特定チケットに紐づかない横断的な確認だけ**、質問専用チケットを別に切って human ラベルを
   付ける（この場合の回答は `bd comment <id> "<回答>"` → `bd close <id>` でチケットごと
   閉じる。**`bd human respond` は使わない** — upstream の "storage is nil" regression を
   確定的に踏むため、comment+close へ置換済み。詳細:
   [references/question-template.md](references/question-template.md)）。
7. **例外 — その場で確認するもの**: 破壊的・不可逆・外向きの操作（本番デプロイ、データ削除、
   push/publish/送信、課金）は、レーンに載せて先へ進む方式にしない。実行前にその場で
   ユーザーに確認する。確認待ちの間、**その操作に依存しない別チケット**を進めるのは構わない。

## 規律4: セッションクローズ — close はマージ成功後だけ

なぜ: PR を開いた時点で close すると、`bd ready` や進捗表示が「landed していない作業を
完了」と偽り、並列セッションと後続作業の判断を狂わせる。close = 「main に入った」の
不変条件を守る。

手順:

1. 検証（プロジェクト規約の検証コマンド）→ PR → CI → マージ、まで完走する
   （マージ排他3層を含む詳細: [references/worktree-pr-flow.md](references/worktree-pr-flow.md)。
   委譲成果の検証規律: [references/verification.md](references/verification.md)）。
2. **マージが成功してから** `bd close <id>`。マージ前に close しない。マージまで到達せずに
   セッションを終えるなら、チケットは in_progress のまま現状をコメントに残す
   （lease が切れれば reclaim が拾う — それが正常系）。
3. `bd comment <id> "PR: <url> / <一行サマリ>"` — 後続セッションが経緯を辿れるようにする。
4. worktree を掃除する: `git worktree remove <path>` → ブランチ削除 → `git remote prune origin`
   （マージした本人の責務。放置すると規律2の空き確認を全セッションで狂わせる）。
5. 残作業・気づきはチケット化してから終える（頭の中に残して終えない）。
6. `bd dolt push` は**チケットごとではなくセッション末に1回**。外向きのネットワーク操作
   なので、プロジェクトの git/sync ポリシーが自律実行を明示的に許可していない限り、実行前に
   ユーザーへ確認する。

## references

| ファイル | 内容 |
|---|---|
| [references/worktree-pr-flow.md](references/worktree-pr-flow.md) | per-ticket worktree+branch+PR フローの全手順とマージ排他3層 |
| [references/lease-params.md](references/lease-params.md) | lease/heartbeat/reclaim の既定パラメータと失敗時の意味 |
| [references/question-template.md](references/question-template.md) | 確認待ちコメントの書き方テンプレ |
| [references/verification.md](references/verification.md) | 委譲結果の独立検証と rebase 規律、委譲失敗の既知パターン（0 編集「委譲しました」誤申告の検知とリトライ） |
| [references/frontend-gotchas.md](references/frontend-gotchas.md) | bd/git 運用規律ではなく web/ 実装（React+Vite）自体で踏んだ非自明な罠。`<details>` の子要素に無条件 `display` を当てると閉じていても常時レンダリングされクリックを奪う問題、dev限定の現象かを本番ビルド(`vite build && vite preview`)で切り分ける手順 |
