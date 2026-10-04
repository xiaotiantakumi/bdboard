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
    '  4. 修復 PR は prepare → BDBOARD_MERGER=chair npm run merge-pr -- gate --repair → gh pr merge → BDBOARD_MERGER=chair npm run merge-pr -- finish で入れる (main-broken の枠を引き継ぎ、finish の success で返す)',
    '  自分で直せないときは議長に報告し、human ラベル + human gate に載せる。',
  ];
}

/**
 * bdboard-ulxa.3: クラス L (着地予定ツリーの軽量チェックだけで着地) の着地後検証が failure = S3 のすり抜けの疑い
 * (設計 bdboard-ulxa §5 / §6 裁定 7)。main 破損の手順 (brokenMainSteps) に足して出す。
 */
export function lightSlipSteps(sha) {
  return [
    `${sha.slice(0, 12)} はクラス L (着地予定ツリーの軽量チェックだけで着地) で、その着地後検証が failure です — S3 のすり抜け (軽量チェックが見ない test 等で壊れた) の疑い。`,
    `  1. まずログで既知のフレーク (bdboard-241s 等) や負荷由来 (並列 verify の時間切れ等) でないことを確かめる。そうなら壊れていないので npm run merge-pr -- verify ${sha} で検証し直す (すり抜けに数えない)`,
    '  2. そうでなければすり抜け 1 件で S2 に戻す: 下の修復 PR (fix-forward / revert) に .claude/bdboard-harness.json の merge.mode を "S2" にする 1 行を含め、議長に報告する',
  ];
}

export function rebaseSteps(mainRef, reason = 'S1 では main が動いたら rebase') {
  return [
    `main が PR のベース以降に進んでいます (クラス R: ${reason})。枠の外で取り込んでから並び直してください:`,
    `  git fetch origin && git rebase ${mainRef} && git push --force-with-lease`,
    `  (force push が権限判定で拒否されたら git merge ${mainRef} → 通常の git push)`,
    '  → 必須チェック (verify / e2e / commit-parse) の green を待つ → npm run merge-pr -- prepare <PR 番号>',
  ];
}

export function mergeInstructions(pr) {
  return [
    '上の 1 行 (stdout) をそのまま 1 回だけ実行してください。枠は保持したままです。',
    `実行後は結果にかかわらず: BDBOARD_MERGER=chair npm run merge-pr -- finish ${pr} (着地後検証まで数分かかる。前景で待つ)`,
    '  - gh pr merge が権限判定で拒否された → 再試行・別経路はしない。finish で枠を返し、human gate へ',
    `  - 409 / "Head branch was modified" → finish で枠を返し、prepare からやり直す`,
    '  - 405 "not mergeable" → finish で枠を返し、rebase してから prepare',
    "  - 'main' is already used by worktree の exit 1 は既知 (マージ本体は成功)。そのまま finish へ",
  ];
}

/** external-ref (gh-<N>) を持つチケットの PR に、issue を閉じる/参照する語が無いときの案内
 * (bdboard-4y8q.8)。 */
export function externalRefSteps(id, externalRef, issueNumber, pr) {
  return [
    `チケット ${id} の external-ref (${externalRef}) に対応する #${issueNumber} への言及が PR #${pr} の本文にありません。`,
    `この PR で GitHub issue #${issueNumber} を閉じるなら本文に "Closes #${issueNumber}" (Fixes / Resolves も可) を、`,
    `同じ issue の他のチケットに任せる (最後にマージする PR ではない) なら "Refs #${issueNumber}" を追加してください。`,
    '(1つの issue に複数チケットがあるときは、最後にマージする PR だけ Closes/Fixes/Resolves、それ以外は Refs。docs/GIT-WORKFLOW.md「PR 本文で external-ref の issue を閉じる」節)',
  ];
}
