# セッション開始の詳細（規律1の詳細）

SKILL.md 規律1（セッション開始）の手順1・2・5 の詳細。本文には骨格だけを残し、ここに全文を置く
（brushup-protocol.md §7 の予算）。着手前に読む。

## 手順1: `bd prime` — メモリ本文の読み方

- **メモリ本文（全文）が読めるのは `bd prime` の出力・`bd recall <key>`・`bd memories --json`
  の3つ**。`bd memories <kw>` は1行に切り詰めたプレビューしか出さず、`--full` フラグも
  `bd remember --list` も存在しない。`bd memories --json` は配列ではなく**オブジェクト**
  （key → 本文全文の文字列。`.[0]` 添字は落ち、`schema_version` の数値エントリが混ざる）(bd v1.2.1 実測)。

## 手順2: in_progress と lease の把握

- **活動履歴を時系列で読むときは `--json` 必須** — `bd list` のテキスト出力は `--sort` を
  指定してもページ内を priority で並べ直すので、行の並びから時系列は読めない (bd v1.2.1 実測)。
- **`bd ready` には「生きている作業」が混ざりうる**（自動 reclaim の誤発火。`bd show` には
  出ないので台帳を眺めても気付けない。`bd history <id> --events` の `lease_reclaimed` が唯一の
  痕跡）。`bd ready` の一覧だけで着手を決めず、手順どおり規律2 の worktree/ブランチ不存在確認
  まで通す。詳細と実測は failure-catalog.md `reclaimed-live-ticket`。
- **自分が長命の worktree に居るなら、そのハーネスは作成時点で凍っている**（注入コピーは
  チェックアウト単位）。`git fetch origin` のあと
  `git rev-list --count HEAD..origin/<mainBranch> -- .claude harness`（`<mainBranch>` は
  検証コントラクト `.claude/bdboard-harness.json` の `mainBranch`、省略時 `main`）が 0 でなければ
  `origin/<mainBranch>` に rebase する（3 以上で、かつ `bd/<id>` worktree なら Hygiene が
  `stale_harness_worktree` で出す。**`feature/*` 等の非チケット worktree は出ない**
  ので自分で測ること）。詳細は failure-catalog.md `stale-harness-worktree`。

## 手順5: 候補の取得

5. `bd ready --exclude-label gt:slot` で候補を取る（**除外必須** — slot bead の claim は他
   セッションのマージを止める）。
