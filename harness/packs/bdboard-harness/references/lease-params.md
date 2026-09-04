# lease / heartbeat / reclaim — 既定パラメータと使い方

## モデル（何のための機構か）

claim（`bd update <id> --claim`）は TTL 付きの lease を伴う。作業者は TTL より速く
`bd heartbeat` を打って lease を延命し、死んだ作業者は heartbeat が止まるので lease が
失効し、`bd reclaim` が猶予窓の経過後にチケットを open へ戻す。

**この機構は「放棄検知」専用であって、排他（レース防止）ではない。** 排他の正本は
worktree 作成の成否（SKILL.md 規律2）。lease が守るのは「セッションが死んでも
チケットが in_progress のまま永久に塩漬けにならない」ことだけ。

lease はノードローカルな ephemeral テーブルに載る（Dolt コミットも履歴も発生しない）。
つまり heartbeat は何回打っても台帳を汚さず、lease が強制できるのは**それを発行した
マシン上だけ**。全セッションが同一マシンで走る構成ではそのまま成立する。マシンをまたぐ
場合、他マシンから見える情報は status/assignee（コミットされる側）だけと考える。

## 既定パラメータ（目安。運用で調整し、変えたらここを更新する）

| パラメータ | 既定の目安 | 根拠 |
|---|---|---|
| lease TTL | bd の設定値（`claim.lease_ttl`。未設定なら bd 既定） | 実効値は `bd show <id>` の `Lease: expires in ...` で確認できる |
| heartbeat 間隔 | **TTL / 3 以下（かつ 5 分以下）** | TTL ぎりぎりだと GC・長いツール実行・一時停止で偽の失効を起こす。heartbeat はコミットを生まないので速くて損はない。5 分は TTL を長く設定した構成でも守る絶対上限 |
| reclaim 猶予窓（`--older-than`） | **≈ TTL × 2** | 失効直後の回収は「一時停止しただけの生きた作業者」から仕事を奪う。失効から TTL×2 待てば偽陽性はほぼ消える |
| reclaim 実行間隔（スーパーバイザー） | ≈ TTL | 回収漏れの最大遅延を TTL+猶予窓 程度に抑える |

heartbeat の実務: 定周期に加えて、**長時間かかる操作（フルビルド・テストスイート・
大きな委譲）の直前に1回打つ**。操作中は打てないので、直前の延命で TTL を食い潰さないようにする。

## 複数チケットを並行保持しているときの一括 heartbeat

並行セッション運用では、1セッションが複数チケットを同時に in_progress で保持する状態が
普通に発生する — 質問レーンで gate 待ちに載せて次のチケットへ進んだ、実装委譲を投げて
待つ間に別チケットへ移った、等。このとき「いま手を動かしているチケットだけ heartbeat する」
運用は**必ず抜ける**: 触っていない保持チケットの lease が静かに失効し、スーパーバイザーの
reclaim が生きている並行作業を回収する誤発火につながる（実測: 8並列ドッグフーディング中に
heartbeat 途絶で reclaim が誤発火 — bdboard-3tw.99 / bdboard-l1t.4）。

規律:

- **保持している全 in-flight チケットへ、同じ周期でまとめて打つ**。周期は TTL/3 以下、
  かつどれだけ TTL が長くても **5 分以下**。heartbeat はコミットを生まないため、全チケットへ
  打っても台帳コストはゼロ — 倒してよいのは**頻度と対象範囲**であって**寿命ではない**。
  寿命は下の「heartbeat ループの寿命」が本則。
- **gate 待ち・委譲待ちのチケットも in-flight に数える**（in_progress で保持している限り対象。
  対象から外してよいのは close したか、負けて撤退したチケットだけ）。
- 一括の実務はループ1本でよい。定周期に加えて、長時間かかる操作の直前にも全チケット分を打つ:

  ```bash
  # 例: 3チケットを並行保持中 — 5分ごと（かつ TTL/3 以下）に全部へまとめて延命
  for id in proj-101 proj-104 proj-107; do bd heartbeat "$id"; done
  ```

  保持リストはセッション側で管理する（claim したら足し、close/撤退したら外す）。
  リストの検算には `bd list --status in_progress` を使えるが、並列セッションは同一
  assignee で動くため、そこに載る全部が自分の保持分とは限らない点に注意。
- 1枚でも失敗したら、そのチケットについて「失敗の意味」（下）に従い直ちに手を止めて
  状況を確認する。残りのチケットの heartbeat は続けてよい。

## heartbeat ループの寿命

生ループを手書きしない。**同梱スクリプト `scripts/bd-heartbeat.sh` を使う**こと。
呼び出し形（実行ビットは注入時に hooks にしか付かないので `bash` 経由）:

```bash
bash .claude/skills/bdboard-harness/scripts/bd-heartbeat.sh start \
  --session-pid $$ --interval 90 --repo . <id>...
bash .claude/skills/bdboard-harness/scripts/bd-heartbeat.sh stop   --session-pid $$
bash .claude/skills/bdboard-harness/scripts/bd-heartbeat.sh status --session-pid $$
```

`start` は**自分でデタッチする**ので、呼び出し側に `&` や `(nohup … &)` を書かせない
（hooks の「二重バックグラウンド化」deny と衝突させないための設計）。
claim / close のたびに `start` を**再実行するだけ**で ID リストが更新される
（同一 session-pid の旧ループは PID 指定で停止されて置き換わる。reclaim → open → 再 claim の
往復もこれで吸収される）。

寿命は3重に束縛される（どれか1つでも成立したらループは自分で終了する）:

1. **対象 ID がすべて脱落したら終了。**
2. **起動元セッションが消えたら終了**（`kill -0` に加え、起動時に控えた
   `ps -o lstart=` と毎周比較して **PID 再利用を弾く**）。
3. **`--max-hours`（既定 12）の上限で終了**。第三のベルト。

ID の脱落条件（打ちすぎ／打ち足りないの両方を避ける倒し方）:

- heartbeat の**終了コードそのものを所有権の問い合わせとして使う**。bd の仕様は
  「所有者のみ heartbeat でき、lease が reclaim 済みかチケットが closed なら失敗」。
  よって**正常系では bd の追加呼び出しはゼロ**。`bd show` の定期ポーリングはしない。
- heartbeat が失敗した ID についてのみ `bd show <id> --json` を1回。
  `status != in_progress` なら**確定で脱落**。
- `bd show` **自体**が失敗（Dolt ロック等の一時障害）したら**脱落させない＝打ち続ける**
  （**fail-open**）。一時障害で生きたチケットを外すと `heartbeat-partial` を再現するため。
  ただし**同一 ID で連続3回**失敗したら脱落させる（3 × 90s > TTL 5分 なので、その時点で
  lease はどのみち死んでいる）。
- セッション生存の判定が**不能**なときは**止める方向に倒す（fail-close）**。
  孤児が残る害のほうが早く止まる害より大きい — セッションが生きているなら `start` を
  再実行すれば済む。

ID 脱落・セッション束縛は**打ち足りない**方向の失敗（`heartbeat-partial`）と鏡像の関係にある
（鏡像: `heartbeat-orphan-loop`）。failure-catalog の `heartbeat-partial` /
`heartbeat-orphan-loop` の両方を参照。

## bd heartbeat の使い方と失敗の意味

```bash
bd heartbeat <id>    # 所有している in_progress チケットの lease を延命
```

- 成功 = 自分がまだ所有者で、lease が TTL ぶん先へ延びた。
- **失敗 = 自分はもう所有者ではない**（reclaim 済み・close 済み・所有が移った）。
  これは「もう書き込むな」という信号なので、**直ちに手を止める**。続けて:
  1. `bd show <id>` で現状を見る。
  2. チケットが open に戻っていて（reclaim された）、かつ自分の worktree/ブランチが
     無事なら、実排他はまだ自分が持っている。`bd update <id> --claim` し直して再開してよい
     （worktree が残っている限り他セッションは排他獲得に失敗するため、安全に取り直せる）。
  3. 別セッションが in_progress で持っているなら撤退する（SKILL.md 規律2の負け側手順:
     相手を戻さない・kill しない・自分の成果は patch に退避）。

## bd reclaim の使い方と実行主体

```bash
bd reclaim --older-than <猶予窓>   # 失効から猶予窓を過ぎた lease のチケットを open へ戻す
```

- **正はスーパーバイザーの定期実行**（bdboard 併用プロジェクトでは bdboard サーバーが
  タイマーで回す）。エージェントセッションが日常的に打つコマンドではない。
- 手動実行してよいのは次が**全部**揃ったときだけ:
  1. スーパーバイザーが動いていない。
  2. 対象の lease が失効から猶予窓（≈ TTL×2）を十分過ぎている。
  3. worktree 側の放棄裏取りが取れた — `git status` が空・`lsof` で worktree を掴む
     プロセスが無い・チケットの `updated_at` が古い。**空の worktree それ自体は放棄の
     証拠にならない**（作成直後・起動直前でもありうる）。lsof は着手直前にもう一度取り直す
     （1回だけでは「起動前」を素通りする）。
- **欲しいチケットを空ける目的で reclaim しない。** reclaim は死者の回収であって
  横取りの道具ではない。
- reclaim がチケットを open に戻しても worktree/ブランチの残骸は消えない。回収したら
  残骸も掃除する（さもないと規律2の空き確認が「着手中」と誤読し続ける）。掃除の前に
  未コミットの成果が残っていないか確認し、あれば patch に退避してチケットにコメントする。
