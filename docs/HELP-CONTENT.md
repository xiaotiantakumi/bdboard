# ヘルプドキュメントの追従 (`docs/help-content.json`)

AGENTS.md「Conventions & Patterns」から分離した詳細。読むタイミング: **ユーザーから見える
機能・操作・画面/ビュー名を追加・変更・削除する PR を開く前**（内部リファクタだけの PR では不要）。

**機能追加/変更の PR は `docs/help-content.json` の更新確認を完了条件に含める**
(bdboard-3tw.138.4)。ヘルプ系の表示はすべて `docs/help-content.json` を単一原本とする:
Web ヘルプ画面 (`web/src/helpContent.ts` → `web/src/components/HelpPanel.tsx`)、チャットの
system prompt (`src/infrastructure/chat/help-content.ts` →
`src/infrastructure/chat/bd-system-prompt.ts`)、ボード上部の Tips
(`web/src/tipsContent.ts` → `web/src/components/TipsBanner.tsx`) はいずれもここから派生する
(bdboard-3tw.138.1〜138.3)。

運用ルール:

- ユーザーから見える機能・操作・画面/ビュー名を追加・変更・削除する PR では、
  PR を開く前に `docs/help-content.json` の該当セクション
  (title/description/steps) が変更後の実態と一致しているか確認し、ズレて
  いれば**同じ PR 内で**原本を更新する。後追いの別チケットに回さない —
  分離した瞬間に陳腐化が始まるのがこのルールの動機 (bdboard-3tw.138.4)。
- 確認の結果「更新不要」も正当な結論 (内部リファクタ、ヘルプに記載の
  ない細部の変更等)。その場合は何も書き換えずに進めてよいが、確認自体は
  省略しない。
- ヘルプ文言の修正は必ず原本 `docs/help-content.json` だけを編集する。
  派生ファイル側に文言をハードコードして原本と二重管理にしない。
- schema の破れ (空文字・id 重複・steps 欠落等) は
  `parseBdboardHelpSections` がサーバー起動時とテストで検証し、派生
  ファイルの型は `npm run verify` が守る。機械的に守れないのは
  「内容の陳腐化」だけで、それがこの運用ルールの対象。
