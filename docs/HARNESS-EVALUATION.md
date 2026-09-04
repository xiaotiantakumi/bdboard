# bdboard ハーネス評価 (2026-09-04)

bdboard を「Claude Code でチケット駆動の自律開発を回すためのハーネス」として評価する。
観点は 3 つ: (1) フィードバックループが Claude Code 公式ガイダンスの水準にあるか、
特に **bdboard 以外のプロジェクトへ注入したとき**にも成立するか、(2) チケットを
コンテキストの正本にする設計が、セッションをまたいだ状態保持とチケット間の整合性を
実際に担保しているか、(3) 利用者の開発効率に効いているか、何を優先して直すべきか。

評価の根拠は、リポジトリ内の規約文書 (CLAUDE.md / `harness/packs/bdboard-harness/`)、
サーバー実装 (`src/`) のコード監査、bd 台帳 494 件の統計、他プロジェクトへの注入実態、
および Claude Code 公式ドキュメント (best-practices / hooks-guide / memory / skills) の
照合による。数値はすべて 2026-09-04 時点の実測。

---

## 0. 結論の要約

**総評: 「事故から学んで規律に還流する回路」と「PR 前の機械検証」は公式ガイダンスの
水準を超えている。一方で、その規律のほぼ全部が"文章"で担保されており、公式が
「例外なく毎回起きるべきことは hook にせよ」と言う部分が空白のままになっている。
他プロジェクトへ注入した瞬間、この空白が「検証ループ自体が存在しない」という形で
露出する。** 優先順位は下表のとおり。

| # | 改善テーマ | 何が問題か (一行) | 効果 | 工数 |
|---|---|---|---|---|
| 1 | **機械ガード (hooks) をパックに同梱** | 再発防止ルールが全部プロース。D 分類 (ルールはあるのに守られない) の失敗が同一セッション内で 2 回再発した実例あり | 高 | 中 |
| 2 | **注入先の「検証コントラクト」を必須化** | パックは検証コマンドを持たない設計。注入先 CLAUDE.md に検証コマンドが無いとフィードバックループが成立しないが、Hygiene はそれを検出しない | 高 | 小〜中 |
| 3 | **セッション開始時コンテキストの減量** | AGENTS.md 636 行 (37KB) + `bd prime` 32KB ≒ 毎セッション 17〜20k トークン。公式目安は 200 行 | 中〜高 | 中 |
| 4 | **クローズ時の証拠テンプレートとハーネス KPI** | close 時に「何をどう検証したか」の構造が無い。ハーネス自体の健全性 (回答待ち滞留・reclaim 回数・重複実装率) を測る画面が無い | 中 | 中 |
| 5 | **チケット間の整合性を"着手前"に見せる** | 並列セッションが同じヘルパーを別々に実装 → 重複解消チケット 10 件超。整合性チェックが PR 時 (`npm run drift`) にしか無い | 中 | 中 |
| 6 | **ボード起点の実行 (bdboard-54be) を上記 1・2 込みで設計** | 現状ループの起点は Claude Code 側 (/loop + orchestration §9)。ボードから起動するなら preflight と hook 注入が前提になる | 中 | 大 (計画済) |

---

## 0.1 追記 (2026-09-04、起票時)

- 本レポートの改善提案 P1〜P6 は epic **bdboard-pkr6** の子チケット 13 枚として起票済み
  (pkr6.1 hooks / pkr6.2 hook 注入 / pkr6.3 検証コントラクト / pkr6.4 パック文書 /
  pkr6.5 AGENTS.md 減量 / pkr6.6 bd memories 棚卸し / pkr6.7 SKILL.md 骨格化 /
  pkr6.8 Hygiene closed_without_evidence / pkr6.9 ハーネス KPI / pkr6.10 in-flight
  ファイル重複 / pkr6.11 run preflight / pkr6.12 許可経路テスト / pkr6.13 post-run verify
  の判断待ち)。各チケットの本文が実装仕様の正本で、本レポートは根拠と優先順位の記録。
- 評価と起票の間に bdboard-54be.1〜.4/.6 が main に着地し、§1 の「Runner は未配線」と
  §5 P6 / §6 の「未配線をテストで固定」は**古くなった**。現状は: `POST /api/runs` が
  worktree を切って Claude CLI を `-p` で起動し、権限は allowlist 主体
  (`DEFAULT_ALLOWED_TOOLS`、bdboard-jgx5)、worktree 内 `.claude/**` への書き込みは
  名指しで deny (bdboard-f4kn)、run 内での npm install / verify は**意図的に不許可**
  (package.json を書き換えられる以上 allowlist の内側から任意コード実行になるため)。
  したがって P6 は「配線するなら」ではなく「配線済みの経路に preflight (注入・hook・
  コントラクト) を足し、検証は run の外で回す導線を作る」に読み替える (pkr6.11〜.13)。

---

## 1. 現状のハーネス構成 (事実の整理)

### 1.1 層構造

| 層 | 実体 | 状態 |
|---|---|---|
| プロジェクト規約 | `CLAUDE.md` → `AGENTS.md` (636 行 / 36.9KB) | ビルド/検証チェーン、常時稼働サーバー、worktree+PR フロー、Dolt 同期、bd init 再実行時の注意、ヘルプ追従ルール |
| 共通パック (正本) | `harness/packs/bdboard-harness/` v0.4.0 (SKILL.md 18.8KB + references 9 本 ≒ 82KB) | 規律 1〜5 (セッション開始 / worktree-first 排他 / 確認待ちのノンブロッキング化 / クローズ / 失敗学習ループ) |
| 注入コピー | `.claude/skills/bdboard-harness/` | bdboard 自身、genbook (0.4.0)、OdaBlogCF (0.1.1 のまま) の 3 プロジェクトに注入済み。`.beads/` を持つ 12 プロジェクト中 9 は未注入 |
| プロジェクト層 | `.claude/skills/project-harness/` | genbook のみ新設済み (119 行、ミューテーション検証時の `git checkout --` 事故の教訓) |
| hooks | `.claude/settings.json` | **SessionStart の `bd prime --hook-json` のみ**。PreToolUse / PostToolUse / Stop は無し。claim 強制 PreToolUse (bdboard-p5l.5) は deferred |
| グローバル層 | `~/.claude/skills/orchestration` §9 継続ループ、`bd remember` 21 件 | ループ運用の指示はここ (プロジェクト非依存) |
| サーバー側の機構 | reclaim スケジューラ (5 分周期 / 10m 窓)、human decision API (gate を `bd close` で解決)、セッション⇔チケット紐付け (transcript 走査)、stalled 判定 (24h)、Hygiene パネル (drift はバージョン文字列比較のみ)、モデル別統計 (`bdboard.model.*`)、チャット (bd 書き込み 19 ツール) | Runner (dispatch) は**テストで未配線を強制**、Next Up は表示専用 |

### 1.2 台帳の実測 (494 件)

| 指標 | 値 | 読み |
|---|---|---|
| status | closed 472 / open 15 / in_progress 4 / deferred 3 | 消化率は極めて高い |
| type | task 212 / bug 137 / feature 112 / chore 23 / epic 9 | bug 比率 28%。自律ループの産物 (後述) |
| 依存辺 | parent-child 235 / blocks 83 / discovered-from 18 / related 5 | 階層は濃いが、**発見元 (discovered-from) が 18 件と薄い** |
| description | 中央値 679 字、空 12 件、受け入れ/検証キーワード有 183 件 (37%) | 本文は厚い。ただし完了条件の書式は不統一 |
| comment_count | 中央値 1、0 件が 115、3 件以上 43 | close 済 472 件中 370 件にコメントあり |
| close_reason | 470 件に有、PR/merge 言及 182 件 | 「PR: url」規約は概ね守られる |
| `bdboard.model.*` | implement 169 / review 95 / check 25 / test 7 | 工程別モデル記録は定着 |
| リードタイム (非 epic 468 件) | 中央値 1.2h / p75 3.9h / p90 9.3h | チケット粒度が小さく回転が速い |
| 日次 close ピーク | 114 件 (08-15)、113 件 (08-29) | 自律ループ稼働日にバースト |
| failure-catalog | 24 エントリ (7 カテゴリ) | 2 週間で v0.1.1 → v0.4.0、harness ラベル 5 件 |

---

## 2. 観点 1: フィードバックループは公式ガイダンスの水準か

公式 (code.claude.com/docs/en/best-practices) の要点は 4 つ:
「**Claude が自分で回せる check を与えよ** (tests / build / screenshot)」「**主張ではなく証拠を
見せよ**」「**例外なく毎回起きるべきことは hook で強制せよ** (CLAUDE.md は助言)」
「**検証は別コンテキスト (subagent) に反証させよ**」。

### 2.1 bdboard 自身の中では満たしている

- `npm run verify` = tsc×3 + web tsc×2 + vite build + vitest (server/web) + dependency-cruiser。
  CI も同じチェーン + `.beads/` 混入ガード + Playwright e2e。テストは 279 ファイル。
- `verification.md` の「自己申告を信じない・自分で回す・merge-base 基準で diff を読む・
  rebase 後に再検証」は「証拠を見せよ」「別コンテキストで反証」に対応する。レビューは Opus
  サブエージェント (95 件に記録) で、実装者と分離されている。
- `scripts/verify.mjs` の 2 並列スロット、`npm run drift`、マージ排他 3 層 (merge-slot →
  直前 CAS → main 上で再 verify) は、公式には無い「並列セッション特有」の追加層で、
  いずれも実際の事故 (bdboard-d48 / 3tw.152 / 9k3) から導かれている。

### 2.2 他プロジェクトへ注入した瞬間に崩れる — 検証コントラクトの不在

パックは設計上「**検証コマンドは注入先 CLAUDE.md が正**」とし、自身は一切持たない
(SKILL.md 前提節)。これは正しい分離だが、**注入先に検証コマンドが無いケースを誰も
検出しない**。

- 実測: genbook の CLAUDE.md には `termcheck → cover → verify → citecheck → imgcheck → build`
  の明示パイプラインがあり成立する。OdaBlogCF の CLAUDE.md には verify/test/build 相当の
  記述が grep で見つからず、パックの規律 4「検証 → PR → CI」の "検証" が空になる。
- 注入 API (`fs-harness-injector.ts`) と Hygiene の drift 判定 (`get-project-harness-status.ts`)
  は「パックのバージョン一致」しか見ない。**ループが成立する前提条件 (検証コマンド・
  PR フローの有無・hooks) をチェックする preflight が無い**。
- 公式の言う「Claude が回せる check」は、bdboard 経由で他プロジェクトに入ったエージェントには
  **与えられていない**ことになる。ここが「別プロジェクトで使うときの最大の穴」。

### 2.3 機械的強制がほぼ無い — 規律が全部プロース

`.claude/settings.json` の hook は SessionStart の `bd prime` だけ。パックも md しか配らない。
公式は「pkill 禁止」「特定ディレクトリへの書き込み禁止」「commit 前の必須手順」の類を
明確に **PreToolUse hook の領域**としている。failure-catalog を分類 D (ルールはあったのに
守られなかった) で読み直すと、hook で防げたものが目立つ:

| 事故 | 何が起きたか | hook で防げたか |
|---|---|---|
| pkill-collateral | `pkill -f 'tsx.*src/main.ts'` が常時稼働サーバーを巻き込む。後日 sonnet-5 実装ラッパーが**指示書で明示禁止されていたのに再度 pkill 使用** (p5l コメント) | PreToolUse(Bash): `pkill\|killall` を deny |
| bare-dolt-push | `bd dolt push` を `--remote legacy` 無しで実行すると私的履歴が公開 remote へ | PreToolUse(Bash): `bd dolt (push\|pull)` に `--remote legacy` が無ければ deny |
| verify-storm / verify:steps 直叩き | スロットを迂回 | PreToolUse(Bash): `verify:steps` deny |
| injected-copy-edit | 注入コピー側を編集して正本に反映し損ねかけた | PreToolUse(Edit/Write): 注入先で `.claude/skills/bdboard-harness/**` を deny、bdboard 内では警告 |
| double-background-verify | **同一セッション内で 2 回再発** (bdboard-j0us) | PreToolUse(Bash): `run_in_background` かつ末尾 `&` を deny |
| `.beads/` を PR で触る | CI ガードで止まるが PR を開くまで気付かない | PreToolUse(Edit/Write): PR ブランチ上で `.beads/**` を deny |
| close before merge | 規律 4 の不変条件 | Stop hook: in_progress チケットの worktree に未コミット差分 / PR 未記録があれば停止をブロック |

ユーザーは **KakeiSnap / PicRill で既に Stop hook (`check_todo.sh`: 未完了チェックボックスが
あれば exit 2 で差し戻す) を運用している**。つまり「Stop hook でゲートする」パターンは
手元に実績があるのに、bdboard のパックはそれを吸収していない。p5l.5 が deferred のまま
なのは「規律だけで衝突が防げるかドッグフーディングで観察してから」というユーザー判断
(2026-08-16) によるが、その後 pkill 再発・double-background 再発という観察結果が出ている。

### 2.4 学習ループ (規律 5) は公式に無い強み

brushup-protocol (失敗判定 → 4 分類 → 配置先決定 → 追加抑制 3 問 → Fable レビュー →
同一 PR で catalog 更新 → アンチエントロピー) は、公式が `/doctor` や `/insights` で
示唆する「ハーネスを測って直す」を、イベント駆動で先取りしている。layering.md の
3 層判定と `harness-upstream` 還流経路も、注入先からの学びを正本に戻す道として機能している
(ge20 / 2w3 の 2 件が実際にこの経路で還流した)。ただし **§7 アンチエントロピーが
「肥大化しないこと」を定めながら、SKILL.md 本文が 18.8KB まで育っている**点は
自らの規律に反しつつある (観点 3 で扱う)。

---

## 3. 観点 2: チケット = コンテキストの正本、は成立しているか

### 3.1 成立している部分

- **状態の外在化**: 台帳の本文が厚く (中央値 679 字)、`bd show` を「唯一の正本」として
  委譲先に渡す規約 (cursor-implementer の手順 2) が守られている。セッション終了時に
  「in_progress のままコメントで現状を残す」規律も、reclaim が拾う前提込みで整合している。
- **セッション⇔チケットの自動紐付け**: transcript を増分走査してチケット ID を既知集合と
  突合 (`extract-bead-ids.ts`)、liveness (5 分 / 30 分 / 24h) と stalled (in_progress かつ
  活動セッション無しかつ 24h 更新無し) を導出する。これは公式の「セッションをブランチの
  ように扱え」を、**どのセッションがどのチケットを触ったかを事後に復元できる**形で
  補強している。他のダッシュボードには無い機能。
- **確認待ちのノンブロッキング化**: human ラベル + gate + UI の選択肢回答 (`decision_options`)
  → 回答で gate を `bd close` するまでが一本につながっている。25 件が実際にこのレーンを通った。
- **モデル別の工程記録** (`bdboard.model.*`) により「どの工程を誰がやったか」が後から分かる。

### 3.2 成立していない/弱い部分

**(a) 引き継ぎの構造が無い。** コメントは自由文で、「何を・どのコマンドで・どの exit で
検証したか」「PR / CI run の URL」「レビューで何を直したか」の定型が無い。close_reason は
中央値 17 字。公式の「証拠を見せよ」はチャット内では守られていても、**台帳には
証拠が残らない**ため、次のセッションが引き継ぐときに再検証するか信じるかの二択になる。

**(b) チケット間の整合性は PR 時にしか見えない。** `npm run drift` は「main と自分の
ブランチが両方触ったファイル」を PR 直前に出す仕組みで、**着手前の重複・干渉は
何も警告しない**。結果として並列セッションが同じヘルパーを別々に書き、後から重複解消
チケットが立つパターンが常態化している:

| 重複解消チケット (抜粋) | 重複していたもの |
|---|---|
| bdboard-dh7c | `truncate` が 3 ファイルに |
| bdboard-3zpw | クエリ clamp ヘルパーが 9 箇所 |
| bdboard-x4ky | BdError→502 catch が 13 箇所 |
| bdboard-yd3g | JSON body パース→400 が 18 箇所 |
| bdboard-a1g5 | Tarjan SCC が board.ts と hygiene.ts に |
| bdboard-nrw0 / os16 / h3wg / 3tw.79 / sm7r / b4o | 同型 |

これは「チケット同士の関連で整合性を取る」設計が、**依存関係 (blocks/parent-child) の
整合は取れても、実装レベルの整合は取れていない**ことの直接の証拠。bug 137 件 (28%) の
一部も、並列実装の意味的衝突 (verification.md が「rebase がクリーンでも意味的衝突は残る」と
警告している事象) 由来と見るのが自然。

**(c) 発見の来歴が薄い。** `discovered-from` 18 件 / 494。規律 4-5 「残作業・気づきは
チケット化してから終える」は守られているが、**どの作業中に見つかったか**を辺で残す
習慣が無いため、後から「なぜこのチケットが存在するか」を辿るには本文を読むしかない。
bd-ticket-writer への委譲時に `--deps discovered-from:<親>` を既定にすれば解決する。

**(d) epic の進捗は直下の子のみ** (DECISIONS-LOG)。3 階層 (3tw.104.4 等) を使っている
以上、深い枝の進捗が epic に上がらない。設計判断としては明示されているが、Next Up の
並び順が「優先度のみ」で epic のまとまりを考慮しない点と合わせて、**ユーザーが
「今どの塊が進んでいるか」を掴む手段が弱い**。

**(e) reclaim の既定値が規律と独立。** `lease-params.md` は「reclaim 猶予 ≈ TTL×2、
実行間隔 ≈ TTL」を推奨するが、サーバーの既定は固定 (5 分周期 / `--older-than 10m`)。
8 並列運用で生きている作業を回収した実測 (3tw.99 / l1t.4) は、この不一致の症状でもある。
一括 heartbeat 規律で運用回避しているが、規律 (人) 側に負担を寄せた形。

---

## 4. 観点 3: 開発効率に効いているか、コストは何か

### 4.1 効いている証拠

- 2 週間強で 472 件 close、リードタイム中央値 1.2h。ピーク日 113〜114 件は人力では不可能で、
  自律ループ + 並列 worktree + マージ排他が実際に回っている。
- 事故は起きているが**同種の事故の再発が減る方向**にカタログが育っている (排他系 5 件は
  8/15〜8/17 に集中し、以後は委譲・検証系へ移っている = 規律が効いた領域が移動している)。
- 確認待ちレーンにより、ユーザー不在でもループが止まらない。

### 4.2 コスト: コンテキスト負荷

| セッション開始時に必ず読まれるもの | サイズ |
|---|---|
| AGENTS.md (CLAUDE.md) | 636 行 / 36.9KB |
| `bd prime --hook-json` (21 件のメモリ全文 + ワークフロー) | 32.3KB |
| 合計 | ≒ 69KB ≒ **17〜20k トークン / セッション** |
| 発動時に追加: SKILL.md | 18.8KB (+ references 82KB は必要時) |

公式は「CLAUDE.md は 200 行以下。長いほど遵守率が落ちる。一つの指示が繰り返し無視される
ならファイルが長すぎる」と明言している。failure-catalog の D 分類 (規律はあるのに
守られない) が繰り返し出ること、brushup-protocol 自身が「ルールを増やすほど守られなくなる」
と書いていることと整合する。具体的に重い節:

- 「Always-On Local Hosting」(約 130 行): 常時稼働サーバーの起動・診断・worktree からの
  preview_start 禁止・トンネル・kill 禁止。**主に bdboard 自身の運用で、注入先には無関係**。
- 「bd init Re-runs」(約 60 行): 再実行時の差分レビュー手順。発生頻度は低い。
- 「.beads/ Dolt sync」「Verify slots」: 重要だが毎セッション読む必要は無い。
- `bd prime` の 21 メモリ: brushup-protocol §6 は「skill へ還流したらメモリはスタブ化 or
  forget」と定めるが、catalog の出典として引かれているキー (health-check-401 等) が
  全文のまま残り、毎セッション再注入されている。

### 4.3 コスト: 手動オペレーション

- **パックの更新は手動クリック**。OdaBlogCF は 0.1.1 のまま 2 週間放置されている。
  12 の bd プロジェクト中 9 は未注入で、KakeiSnap (233 件) は独自の Stop hook 運用。
  「利用プロジェクトへのインジェクト機構」(p5l) は機構としては完成しているが、
  **配布ポリシー (自動 minor 更新・全プロジェクト一括注入) が無い**ため、ハーネスの
  改善が他プロジェクトへ届くまでの遅延が大きい。
- **ループの起点が Claude Code 側**。ユーザーが `/loop` を張ったセッションを立てないと
  ボードは「見るだけ」。54be (Next Up の実行ボタン / ループボタン) が着手済みだが、
  Runner は「未配線をテストで強制」しているため、配線時は安全設計 (何を許可し何を
  hook で止めるか) を先に決める必要がある = 本稿の #1・#2 と同じ議論。

### 4.4 コスト: ハーネス自体を測る手段が無い

ボードにはスループット・CFD・モデル別統計はあるが、**ハーネスの健全性指標が無い**:
確認待ちの滞留時間 (human ラベル付与 → 回答までの中央値)、reclaim 発火回数 (うち誤回収)、
harness ラベルの起票率、重複解消/やり直しチケットの比率、verify 失敗回数。公式が
`/insights` `/doctor` で促す「測って削る」を bdboard 自身の上で行う入口が無い。

---

## 5. 改善提案 (優先順)

### P1. 機械ガード (hooks) をパックに同梱し、注入時に settings.json へマージする

**目的**: D 分類の失敗を「文章で禁止」から「実行できない」へ移す。公式の hooks-guide の
守備範囲そのもの。

- パックに `hooks/` を追加 (シェルスクリプト、bd/git 以外に依存しない):
  - `pre-bash-guard.sh` (PreToolUse: Bash): `pkill|killall` / `bd dolt (push|pull)` に
    `--remote` 無し / `npm run verify:steps` / 素の `git stash` / `run_in_background` 併用時の
    末尾 `&` を deny し、理由と代替コマンドを stderr に返す。
  - `pre-edit-guard.sh` (PreToolUse: Edit|Write|MultiEdit): 注入先では
    `.claude/skills/bdboard-harness/**` を deny (layering の「注入コピー編集禁止」)、
    bd/ ブランチ上では `.beads/**` を deny。
  - `stop-ticket-gate.sh` (Stop): cwd が per-ticket worktree で、対応チケットが
    in_progress かつ (未コミット差分あり or `PR:` コメント無し) なら exit 2 で
    「コメントを残すか PR を開いてから終える」を差し戻す。KakeiSnap の `check_todo.sh` の
    bd 版。`stop_hook_active` で無限ループ防止。
- 注入 API は `.claude/settings.json` の `hooks` へ**マージ** (既存 hook を壊さない、
  `bdboard-harness` マーカー付き) する。p5l.5 が deferred になった論点「自動書き込みか
  手順案内か」はここで決める。推奨は自動マージ + Hygiene で hook 不在を drift 扱い。
- claim 強制 (p5l.5 本来の狙い) は「worktree⇔チケット対応 + lease 鮮度」の判定が要るので
  第 2 弾。まず上の deny リストで即効性のある事故を止める。

### P2. 注入先の「検証コントラクト」を必須化する

**目的**: 他プロジェクトでもフィードバックループが必ず存在する状態にする。

- 注入先に `.claude/bdboard-harness.json` (または pack.json 側の `requires`) を置き、
  `verify` (フル検証コマンド)、`prFlow` (pr / direct / none)、`mainBranch` を宣言させる。
  SKILL.md 規律 4 と worktree-pr-flow は「注入先 CLAUDE.md を読め」ではなく、この
  宣言を読むように書き換える (CLAUDE.md は人向けの説明として残す)。
- 注入時 preflight: 宣言が無い / コマンドが存在しない (`npm run <script>` が package.json に
  無い等) 場合は注入を止めずに Hygiene に「検証ループ未定義」を出す。Stop hook (P1) は
  この `verify` を使って「verify 未実行のまま PR を開こうとしている」も検出できる。
- 対象ごとの型: genbook (`run_all()` パイプライン) のように非 npm でも書けるよう、
  コマンドは文字列 1 本 + 期待 exit 0 だけの契約にする。

### P3. セッション開始時コンテキストの減量 (CLAUDE.md ≦ 200 行、bd prime の整理)

- AGENTS.md を「毎セッション必要」なものだけに絞る: Quick Reference、verify 一行、
  Git Workflow の骨格 (branch/worktree/close タイミング/direct-to-main 禁止)、`.beads/`
  不可触、Dolt push は `--remote legacy` 固定。目標 150〜200 行。
- 残りは発動時ロードへ移す: 「Always-On Local Hosting」→ `.claude/skills/bdboard-server-ops/`
  (サーバー起動・診断・再起動時に読む)、「bd init Re-runs」→ 同 skill か
  `.claude/rules/` の path-scoped rule (`AGENTS.md`, `.beads/**`)、「Verify slots」詳細 →
  `scripts/verify.mjs` のヘッダーコメントに移して CLAUDE.md は 3 行に。
- `bd prime` の 21 メモリを brushup-protocol §6 どおり棚卸し: skill/catalog に還流済みの
  ものは「還流済み (参照: …)」のスタブへ更新。出典参照が要るものだけ残す。
- 変更前後を `/doctor` と同一タスクのトークン消費で比較し、効果を DECISIONS-LOG に残す。
- SKILL.md 本文 (18.8KB) も §7 の「骨格だけ」へ戻す: 規律 3 の gate/dep の長い説明は
  question-template.md へ、規律 2 の heartbeat 詳細は lease-params.md へ。

### P4. クローズ時の証拠テンプレートと、ハーネス KPI

- close 直前のコメントを定型化 (パックの question-template.md と同じ扱いで
  `close-template.md` を追加): `検証: <cmd> exit=<n> (<日時>)` / `PR: <url>` / `CI: <run url>` /
  `レビュー: <model> 指摘 n 件・採用 m 件` / `未了: …`。cursor-implementer /
  codex-implementer の報告書式にも同じ項目を要求する。
- Hygiene に「close 済みだが PR/検証記録なし」「in_progress だが 24h コメント無し」
  (stalled の補完) を追加。
- ハーネス KPI パネル (統計タブに追加): 確認待ち滞留 (human ラベル付与 → gate close の
  中央値)、reclaim 発火数と直後に同一チケットが再 claim された率 (誤回収の代理指標)、
  `harness` / `harness-upstream` 起票数、`重複|duplicate|再発` を含むチケット比率。
  データはすべて既存の台帳・interactions.jsonl・reclaim ログにあり、新しい永続化は不要。

### P5. チケット間の整合性を着手前・レビュー時に見せる

- パック規律 2 に「着手直後の類似実装検索」を 1 手順追加: 変更予定の領域名で
  `git grep` / 既存ヘルパーを 1 回検索し、結果をチケットにコメント。委譲ブリーフに
  「新規ヘルパーを書く前に既存を探し、見つけたら再利用」を定型で入れる。
- レビュー用プロンプト (Opus) の観点に「同 PR 内・直近 main の重複実装」を明示。
- ボード側: in_progress チケットの worktree で `git diff --name-only merge-base` を
  取り、**同じファイルを触っている in-flight チケット同士**を詳細パネルと Hygiene に
  警告表示する (`npm run drift` の "着手中版")。Next Up にも「着手すると衝突しうる
  チケット」を注記する。
- bd-ticket-writer の既定を `discovered-from` 付きにし、来歴を辺で残す。

### P6. ボード起点の実行 (bdboard-54be) は P1・P2 を前提に配線する

- 実行ボタンが起動する Claude CLI には、P2 の検証コントラクトと P1 の hooks が注入済みで
  あることを preflight にする (無ければボタンを disabled にして理由を表示)。
- `runners-are-disabled.test.ts` を「許可された経路だけ通る」テストに書き換え、
  Runner の許可ツール (`--allowedTools`) と作業ディレクトリ (worktree 限定) を
  テストで固定する。
- ループボタンの失敗時挙動 (54be.2 の論点) は「失敗チケットに `harness` 付きコメントを
  残してスキップ、同一チケットの 2 連続失敗で停止」= verification.md の既存規律と揃える。

---

## 6. 変えなくてよいもの (評価として明記)

- **worktree-first 排他** (claim は台帳記録、排他は git が裁く) — 同一 assignee 前提で
  bd の CAS が効かない事実に基づく正しい設計。fleet.db 等の独自ロックを作らない判断も正しい。
- **マージ排他 3 層と main 上の再 verify** — 並列運用での意味的衝突を捕まえる唯一の網。
- **失敗学習ループ (規律 5) と 3 層の layering** — 公式に無い強み。P3 で本文を減量しても
  回路自体は残す。
- **Runner 未配線をテストで固定する方式** — 54be で配線するときも「テストで許可経路を
  固定する」形を維持する。
- **`docs/help-content.json` 単一原本ルール** — ヘルプ・チャット system prompt・Tips が
  同じ原本から派生する設計は、注入先に配るドキュメントの正本管理にもそのまま使える。

---

## 7. 参照

- Claude Code best practices: https://code.claude.com/docs/en/best-practices.md
  (feedback loop / "show evidence" / CLAUDE.md 200 行 / hooks vs CLAUDE.md)
- Hooks guide: https://code.claude.com/docs/en/hooks-guide.md
- Memory: https://code.claude.com/docs/en/memory.md
- Skills: https://code.claude.com/docs/en/skills.md
- Sub-agents: https://code.claude.com/docs/en/sub-agents.md
- 本リポジトリ: `CLAUDE.md`、`harness/packs/bdboard-harness/`、
  `docs/ARCHITECTURE.md`、`docs/DECISIONS-LOG.md`、bd エピック bdboard-p5l / bdboard-54be
