# layering — 多層ハーネスの構成と協調規約

この skill は bdboard の**注入パック**として、bd（beads）を使う複数のプロジェクトへ配布
される。パックは **skill 単体で成立する**ように書かれている — 注入先にグローバル skill
（orchestration 等）が入っていることを前提にしない。したがって「教訓をどこに書くか」は単一 repo の話では終わらず、**層をまたぐ
編集先の決定**が必要になる。brushup-protocol.md §3（配置先決定表）の前段として、
まずこのファイルで「どの層を編集するのか」を決める。

## 3つの層

| 層 | 実体 | 管理 | 担う教訓 |
|---|---|---|---|
| **共通パック層** | bdboard repo の `harness/packs/bdboard-harness/`（正本）と、各プロジェクトへの注入コピー `.claude/skills/bdboard-harness/` | bdboard repo で PR + `pack.json` のバージョン管理。注入・更新・ドリフト検出は bdboard の Hygiene パネル | プロジェクト非依存の「回し方」の規律（排他・確認待ち・マージ・学習ループ） |
| **プロジェクト層** | 各プロジェクト自身の `.claude/skills/project-harness/` と CLAUDE.md / AGENTS.md | そのプロジェクトの repo で git 管理（bdboard は触らない） | そのプロジェクト固有の値・環境・失敗事例（検証コマンド、ポート、ツールの癖、固有の failure-catalog） |
| **グローバル層** | ユーザーの `~/.claude/skills/` 等（orchestration の lessons-learned など） | ユーザー個人の資産。**編集は常に要ユーザー確認** | プロジェクトにも bd にも依存しない一般則。転記先であって本則の置き場にしない |

## いまどの立場に居るかの判定（編集先を決める最初の分岐）

上から順に判定し、**最初に一致した分岐を採る**（bdboard repo 自身は分岐2の条件も
満たすが、分岐1が優先）:

1. **repo に `harness/packs/bdboard-harness/` がある** → bdboard repo 本体に居る。
   - 共通パックの編集は**正本（`harness/packs/`）側**に対して行い、同じ PR で
     ドッグフーディング用の注入コピー（`.claude/skills/bdboard-harness/`）と
     `.claude/bdboard-packs.json` にも同じ変更を反映する（両者は git 追跡されている —
     bdboard-p5l.7 の裁定）。**注入コピーだけを編集しない**（次回の再注入で消える上、
     他プロジェクトへ配布されない）。
   - 注入機構は注入先を選ばず `.gitignore` へ管理行を追記するため、**bdboard 自身へ
     再注入した場合はその追記を revert する**（追跡済みファイルは無事だが、放置すると
     以後のパック新規ファイルが `git add` から静かに漏れる）。
2. **`.claude/bdboard-packs.json` にこのパックが載っている** → 注入先プロジェクトに居る。
   - `.claude/skills/bdboard-harness/` は**注入コピーであり編集禁止**。gitignore 済みで
     git 管理されておらず、パック更新の再注入で**無警告に上書きされる** — ここに書いた
     教訓は消える。
   - プロジェクト固有の教訓 → プロジェクト層（下記「project-harness の規約」）へ。
   - 汎用的な教訓 → その場では直せない。**アップストリーム経路**（下記）へ。
3. **どちらでもない**（手動コピー等で skill だけがある）→ その repo のローカル資産と
   みなし、通常の repo 内編集でよい。ただし後から注入管理に載せると上書きされるため、
   独自変更がある旨をファイル冒頭に明記しておく。

## project-harness の規約（プロジェクト層のコンパニオン skill）

注入先プロジェクトで最初の教訓が出たときに、`.claude/skills/project-harness/` を新設する
（skill-creator がグローバルに導入されていればその規約に従う。無くても要点は同じ:
description に発動トリガーを書き、本文は骨格、詳細は references へ）。構成は共通パックと
相似形にする:

```
.claude/skills/project-harness/
  SKILL.md                        # このプロジェクト固有の作業上の注意（値・環境・逸脱）
  references/failure-catalog.md   # プロジェクト固有の失敗台帳（書式は共通パックと同一）
```

- **共通パックの規律を再掲・言い換えしない。** project-harness に書くのは「このプロジェクト
  では何が違うか」だけ。重複させると、パック更新時に古い写しが残って矛盾源になる。
- **共通規律と矛盾する内容を書かない。** どうしても逸脱が必要なら、(a) project-harness に
  「どの規律から・なぜ逸脱するか」を明示して書き、(b) 同時にアップストリームチケット
  （下記）を切る。逸脱の必要が生じたこと自体が「共通規律が間違っているかもしれない」
  シグナルであり、黙って上書きすると層間の信頼が壊れる。
- failure-catalog の書式・5行制限・「本則は一箇所」原則は共通パックのものをそのまま使う
  （brushup-protocol.md §3・§7 はプロジェクト層にもそのまま適用される。読み替え:
  「SKILL.md」→ project-harness の SKILL.md、「CLAUDE.md」→ そのプロジェクトの規約文書）。

## アップストリーム経路 — 汎用的な学びを共通パックへ還流する

注入先プロジェクトで見つけた教訓が「bd 運用プロジェクトなら どこでも起こる」ものなら、
共通パック（bdboard repo）へ還流する。注入先からパック正本は直接編集できないので、
チケットで運ぶ:

1. そのプロジェクトの beads にチケットを切る:
   `bd create --type=task --priority=2 --title="[harness-upstream] <教訓の一行>"`
   （成果消失級の再発リスクなら priority=1 — SKILL.md 規律5 手順3 と同じ基準）、
   `bd label add <新id> harness-upstream`。本文に failure-catalog 書式のエントリ案
   （症状・原因・防止・出典）をそのまま書く。
2. 暫定運用として、確定するまでは自プロジェクトの project-harness にもエントリを置いて
   よい（パック側に取り込まれた版が配布されたら、重複するローカルエントリを消す）。
3. bdboard は全プロジェクトの beads を横断表示するので、`harness-upstream` ラベルの
   チケットは bdboard 側のセッションから見える（ボードのラベル絞り込み、または
   watched project ごとに `bd -C <プロジェクトパス> list --label harness-upstream`）。
   bdboard 側はそれを拾い、brushup-protocol.md の手順（Fable 検討 + 独立レビュー + PR）で
   パック正本に反映する。

## 配布とバージョン — ブラシュアップを「ハーネスのバージョンアップ」として運ぶ

- パック正本の変更は必ず `harness/packs/bdboard-harness/pack.json` の `version` を上げる:
  **patch** = 文言・参照の修正 / **minor** = 規律・手順・reference の追加 /
  **major** = 既存規律の意味が変わる破壊的変更。
- バージョンが上がると、bdboard の Hygiene パネルが各プロジェクトの注入済みバージョン
  とのドリフトを検出し、再注入（更新）を促す。**手で各プロジェクトへコピーしない** —
  配布は注入機構に一本化する（手コピーはドリフト検出から見えなくなる）。
- major 更新の再注入は、各プロジェクト側の project-harness に旧規律前提の記述が
  残っていないかの確認とセットで行う。

## 機械的強制（フック）は最小限

知識・規律は skill（文書）に置くのが正で、フックは「文書では防げない機械的な誤操作」
だけに使う（例: 注入コピー編集のブロックは将来のフック候補 — bdboard-p5l.5 の claim
強制フックと同系）。フックを増やす判断も brushup-protocol.md §4 の3問（再現しうるか・
機械的に防げるか・既存の訂正で足りないか）を通すこと。
