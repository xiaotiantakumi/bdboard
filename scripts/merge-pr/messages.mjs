// bdboard-ulxa.1: エージェントに次の行動を指示する定型文。文言の正本は
// harness/packs/bdboard-harness/references/worktree-pr-flow.md §5「S1」と docs/GIT-WORKFLOW.md。

/** main が壊れている (着地後検証 failure) ときの手順 (設計 §3.6)。 */
export function brokenMainSteps(sha, repo, context) {
  return [
    `main ${sha.slice(0, 12)} の着地後検証 (${context}) が failure です。この上にマージしません。`,
    '手順 (docs/GIT-WORKFLOW.md「main が壊れたとき」):',
    `  1. 状況: gh api repos/${repo}/commits/${sha}/status で description を確認し、最後の success と最初の failure の sha を特定する`,
    `  2. bd create --type bug -p 0 "main 破損: ${sha.slice(0, 12)} <失敗ステップ>" (失敗ログの先頭を bd comment に)`,
    '  3. 10 分以内に直せるなら fix-forward PR、それ以外は revert PR (git revert --no-edit <壊した squash sha>)',
    '  4. 修復 PR は prepare → gate --repair → gh pr merge → finish で入れる (main-broken の枠を引き継ぎ、finish の success で返す)',
    '  自分で直せないときは議長に報告し、human ラベル + human gate に載せる。',
  ];
}

export function rebaseSteps(mainRef) {
  return [
    `main が PR のベース以降に進んでいます (S1 のクラス R)。枠の外で取り込んでから並び直してください:`,
    `  git fetch origin && git rebase ${mainRef} && git push --force-with-lease`,
    `  (force push が権限判定で拒否されたら git merge ${mainRef} → 通常の git push)`,
    '  → 必須チェック (verify / e2e / commit-parse) の green を待つ → npm run merge-pr -- prepare <PR 番号>',
  ];
}

export function mergeInstructions(pr) {
  return [
    '上の 1 行 (stdout) をそのまま 1 回だけ実行してください。枠は保持したままです。',
    `実行後は結果にかかわらず: npm run merge-pr -- finish ${pr} (着地後検証まで数分かかる。前景で待つ)`,
    '  - gh pr merge が権限判定で拒否された → 再試行・別経路はしない。finish で枠を返し、human gate へ',
    `  - 409 / "Head branch was modified" → finish で枠を返し、prepare からやり直す`,
    "  - 'main' is already used by worktree の exit 1 は既知 (マージ本体は成功)。そのまま finish へ",
  ];
}
