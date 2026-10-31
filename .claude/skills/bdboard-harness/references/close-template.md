# close 直前コメントのテンプレ

close（= マージ成功）の直前に、そのチケットで**何をどう確かめたか**を台帳へ残す。

なぜ: コメントが自由文だと「何を・どのコマンドで・どの exit で検証したか」「PR / CI の URL」「レビューで何を直したか」が残らず、
引き継ぐ次のセッションは再検証するか信じるかの二択になる（実測: close 理由の中央値 17 字、PR URL の無い close が常態）。
定型があれば機械（Stop hook の痕跡判定、Hygiene の「close 済みだが PR/検証記録なし」）も証拠の有無を判定できる。

## 規律4 の手順（全文）

手順番号は SKILL.md 本文と同じ。

1. 検証 → PR → CI → マージ、まで完走する。検証コマンドは契約 `.claude/bdboard-harness.json` → CLAUDE.md / AGENTS.md の順で決め、無ければ進めない。
2〜4. **マージ成功後に議長が `python3 scripts/close-ticket.py --spec <json>`**（メインチェックアウトで。キーと手順は `--help`、確認は `--dry-run`）。
   MERGED・main 到達・worktree 未使用を検査し、`PR: <url> merged (<短縮 SHA>)` の証拠コメント → `bd close` → 掃除をする。
   **未マージは拒否される。マージ前に close しない**（未到達なら in_progress のまま現状をコメントに残す）。
5. 残作業・気づきはチケット化する（`--deps discovered-from:<元>`。先に brushup-protocol.md §8 の停止規則を見る）。
6. `bd dolt push` はセッション末に1回。外向き操作なので許可が無ければ実行前に確認する。

## テンプレ（スクリプトの前に `bd comment <id> "<本文>"` で残す。`PR:` 行はスクリプトが付ける）

```
検証: <コマンド> exit=<n> (<ISO 日時>, <実行した worktree/ブランチ>)
PR: <url>  CI: <run url または「未使用」>
レビュー: <モデル> 指摘 <n> 件 / 採用 <m> 件（不採用の理由は 1 行ずつ）
未了: <残作業チケット ID か「なし」>
```

## 書き方の規律

- **`PR:` 行は必ず含める**（機械の検索キー。`close-ticket.py` が付ける）。PR を使わないフロー（`prFlow` が `direct` / `none`）は `PR: なし (prFlow=<値>)`。
- **`検証: … exit=` に書いてよいのは、自分がこのセッションで実行した検証だけ。** 委譲先の「全部通りました」を転記しない
  （[verification.md](verification.md)）。実行した worktree / ブランチまで書く。exit は検証コマンド自身のもの（ラッパーやバックグラウンドの
  終了コードは失敗を 0 に化けさせる。failure-catalog.md の verify-exit-masked）。
- **レビュー行は「指摘 n 件 / 採用 m 件」まで。** 全件採用でも `n 件 / n 件`。不採用は理由を 1 行ずつ。回していないなら `レビュー: なし`。
- **未了はチケット ID で書く。** 自由文にしない。派生チケットは `--deps discovered-from:<このチケット>` で来歴を辺に残す。
- 4 行に収まらない詳細は定型の**後ろ**に段落として足してよい。定型の 4 行は削らない。
