// bdboard-ulxa.1: エージェントに次の行動を指示する定型文。文言の正本は
// harness/packs/bdboard-harness/references/worktree-pr-flow.md §5「S1」と docs/GIT-WORKFLOW.md。
import { shellQuote } from './exec.mjs';

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
  const short = sha.slice(0, 12);
  return [
    `${short} はクラス L (着地予定ツリーの軽量チェックだけで着地) で、その着地後検証が failure です — S3 のすり抜け (軽量チェックが見ない test 等で壊れた) の疑い。`,
    `  1. まずログで既知のフレーク (bdboard-241s 等) や負荷由来 (並列 verify の時間切れ等) でないことを確かめる。そうなら壊れていないので BDBOARD_MERGER=chair npm run merge-pr -- verify ${sha} で検証し直す (クラス L の記録は残してあるので、success が light-landed の最後の行になり、すり抜けに数えない)。success でも、この SHA の main-broken 枠 (finish が failure のときに取ったもの・gate --repair が引き継いだもの・手で取ったもの) が残りうるので、bd merge-slot check で "… / main-broken ${short}" を確かめ、gate --repair 済みの修復 PR が無ければ bd merge-slot release --holder '<holder>'`,
    '  2. そうでなければすり抜け 1 件で S2 に戻す: 下の修復 PR (fix-forward / revert) に .claude/bdboard-harness.json の merge.mode を "S2" にする 1 行を含め、議長に報告する',
    `  3. 同じ着地コミットの failure を別の merger も報告することがある (gh pr merge から LEASE 以上あとに finish を始めた compact・遅延 / pending を書く前の npm ci が LEASE より長い / pending の更新 heartbeat の投稿が LEASE より長く失敗 / 自己修復が報告したあとで遅れて finish が走った)。起票と修復 PR の前に bd search "main 破損: ${short}" --status open、bd merge-slot check (枠の holder が "… / main-broken ${short}")、gh pr list --state open で既に誰かが対応していないか確かめ、していれば重ねて作らない`,
  ];
}

/**
 * bdboard-ulxa.7: finish が failure で残したクラス L の記録 (landedResult: 'failure') を持つ PR に、prepare / gate / finish
 * をやり直そうとしたときの案内。マージ済みで着地後検証が終わっている PR なので、枠を取り直す手順には進ませない
 * (finish をやり直すと、直した後の main に main-broken の枠をもう一度取ってしまう)。
 */
export function keptLightFailureSteps(pr, state) {
  const landed = String(state.newMain ?? '');
  return [
    `PR #${pr} はクラス L でマージ済みで、その着地後検証 (${landed.slice(0, 12)}) は failure で終わっています。prepare / gate / finish はやり直せません。`,
    `  - フレーク・負荷由来なら: BDBOARD_MERGER=chair npm run merge-pr -- verify ${landed} (success でこの記録を消します)`,
    '  - すり抜けなら: 「When main is broken」の手順 (docs/GIT-WORKFLOW.md) の修復 PR で直し、merge.mode を "S2" に戻す',
  ];
}

/** bdboard-ulxa.7: 手動の再検証が success でも、finish が取った main-broken の枠は自動では返らない。 */
export function mainBrokenSlotHeldSteps(sha, holder) {
  return [
    `${sha.slice(0, 12)} の main-broken 枠 (${holder}) が残っています。この SHA の枠は、finish が failure のときに取ったもの・gate --repair が引き継いだもの・手で取ったもののどれでもありえ、この再検証が success でも自動では返されません。`,
    `この main を直す修復 PR を gate --repair 済みでなければ (その枠は修復の finish が返します): bd merge-slot release --holder ${shellQuote(holder)}`,
  ];
}

/** bdboard-89jv: 手動の再検証が success でも、bd merge-slot check 自体が失敗したときは枠の有無が言えない。手で確かめる 1 行。 */
export function mainBrokenSlotUnknownSteps(sha, error) {
  const short = sha.slice(0, 12);
  return [
    `${short} の main-broken 枠が残っていないか確かめられませんでした (bd merge-slot check に失敗: ${error})。手で bd merge-slot check を実行し、"… / main-broken ${short}" が残っていれば、gate --repair 済みの修復 PR が無いときだけ返してください。`,
  ];
}

/**
 * bdboard-89jv: finish の着地後検証が failure でも、origin/main (tip) が着地コミットより先へ進んでいるときの案内。
 * 古い SHA の main-broken の枠は取らない (枠の名前は修復 PR の PRED_BASE = 先頭で決まり、古い SHA の枠は引き継げない)。
 * ledger は先頭の台帳の state ('success' | 'failure' | 'error' | 'pending' | 'none' | 'unknown')。文面を選ぶためだけに使う。
 */
export function mainMovedOnSteps(landed, tip, ledger, repo, context) {
  const short = landed.slice(0, 12);
  const tipShort = tip.slice(0, 12);
  const head = [
    `着地コミット ${short} の着地後検証 (${context}) は failure でしたが、origin/main は既に ${tipShort} まで進んでいます。`,
    `${short} の main-broken の枠は取りません (枠の名前は修復 PR の PRED_BASE = 先頭の SHA で決まるので、古い SHA の枠は gate --repair が引き継げず、誰も返さないまま全 gate を止めます。bdboard-89jv)。`,
  ];
  if (ledger === 'success') {
    return [...head, `先頭 ${tipShort} の着地後検証は success です — main は壊れていません。修復 PR は要りません。`];
  }
  if (ledger === 'failure' || ledger === 'error') {
    return [
      ...head,
      `先頭 ${tipShort} の着地後検証も failure です — main は壊れています。先頭に対して次の手順を取ってください。`,
      `  先に、起票と修復 PR の前に既に誰かが対応していないか確かめる: bd search "main 破損: ${tipShort}" --status open、bd merge-slot check (枠の holder が "… / main-broken ${tipShort}")、gh pr list --state open。していれば重ねて作らない`,
      ...brokenMainSteps(tip, repo, context),
    ];
  }
  if (ledger === 'pending') {
    return [
      ...head,
      `先頭 ${tipShort} の着地後検証は pending です — その finish (または自己修復) がいま検証しているので、手で verify を重ねないでください (verify スロットを余計に 1 つ使います)。`,
      '  - 次の gate の層 3 が先頭の台帳を読んで待ち、LEASE を過ぎても記録が無ければ自己修復します。',
      '  - 修復 PR を開くのは、先頭の台帳が failure になったときだけ。',
    ];
  }
  return [
    ...head,
    `先頭 ${tipShort} の着地後検証はまだ success と確かめられていません (台帳: ${ledger})。`,
    `  - 確かめる: BDBOARD_MERGER=chair npm run merge-pr -- verify ${tip}`,
    '  - 修復 PR を開くのは、先頭が failure のときだけ (手順は verify の出力に出ます)。success なら何もしなくてよい。',
  ];
}

/**
 * bdboard-89jv: 着地後検証が failure で、origin/main の先頭 T が着地コミット L ではないのに、T が L の子孫か調べられなかった
 * (fetch が失敗して T のオブジェクトが手元に無い等) ときの案内。枠は L の名前で取ったまま (安全側) だが、T が本当に子孫なら
 * 修復 PR の gate --repair はその枠を引き継げない (枠の名前は PRED_BASE = T で決まる) ので、返す手順を添える。
 */
export function unverifiedTipSteps(landed, tip, holder) {
  const short = landed.slice(0, 12);
  const tipShort = tip.slice(0, 12);
  return [
    `注意: origin/main の先頭は ${tipShort} で、着地コミット ${short} の子孫かどうかを調べられませんでした (git fetch に失敗して ${tipShort} のオブジェクトが手元に無い等)。枠 (${holder}) は取ったままにしています。`,
    `  fetch が通るようになって git merge-base --is-ancestor ${landed} ${tip} が 0 で終われば main は先へ進んでいます: この枠は誰も引き継げないので bd merge-slot release --holder ${shellQuote(holder)} で返し、先頭 ${tipShort} の台帳 (gh api repos/<owner>/<repo>/commits/${tip}/status) を確かめてください。`,
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
