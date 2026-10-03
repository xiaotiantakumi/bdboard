// bdboard-4y8q.8: PR が、チケットの external-ref (GitHub issue) を実際に閉じる/参照するかの
// 機械チェック。1つの issue に複数チケットがあるとき、最後にマージする PR だけ Closes を書き、
// それ以外は Refs を書く規約 (docs/GIT-WORKFLOW.md「PR 本文で external-ref の issue を閉じる」、
// worktree-pr-flow.md §4 が正本)。どちらを書くかは担当の判断で、ここでは「どちらかがあること」
// だけを機械的に確かめる — 最後の PR かどうかの判定はしない (bd に「最後」を機械的に決める
// 情報が無い)。
import { EXIT, fail } from './context.mjs';
import { externalRefSteps } from './messages.mjs';
import { audit } from './state.mjs';
/**
 * GitHub が実際に issue を閉じる語 (close/closes/closed, fix/fixes/fixed, resolve/resolves/
 * resolved の全活用形。大小文字は無視) + 閉じずに参照だけする refs。活用形を欠くと、GitHub 的には
 * 閉じるはずの "Fixed #432" のような書き方を、このゲートだけが誤ってブロックしてしまう
 * (レビュー指摘、bdboard-4y8q.8)。"refs" は GitHub 側のキーワードではなくこのプロジェクトの
 * 内部規約 (閉じずに参照だけ) なので活用しない。
 */
export const CLOSING_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
  'refs',
];

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * PR 本文からコードブロック (フェンス・インライン) を取り除く。中の文字列は判定に使わない
 * (レビュー観点: 本文のサンプルコード中に "Closes #123" と書いてあっても誤検知しない)。
 */
export function stripCodeSpans(body) {
  return (body ?? '').replace(CODE_FENCE, ' ').replace(INLINE_CODE, ' ');
}

/**
 * external_ref が `gh-<N>` (大小文字無視) のときだけ issue 番号を返す。それ以外 (URL 形式・
 * 無し・不正な形) は null — この関数はこのチェックの対象かどうかの判定にだけ使う。
 */
export function issueNumberFromExternalRef(externalRef) {
  if (typeof externalRef !== 'string') return null;
  const match = /^gh-(\d+)$/i.exec(externalRef.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * PR 本文 (コードブロックを除く) が issueNumber を Closes/Fixes/Resolves/Refs のいずれかで
 * 指しているか。番号は完全一致 (#432 は #4321 に誤ヒットしない)。
 */
export function bodyReferencesIssue(body, issueNumber) {
  const pattern = new RegExp(`\\b(?:${CLOSING_KEYWORDS.join('|')})\\s*:?\\s*#${issueNumber}\\b`, 'i');
  return pattern.test(stripCodeSpans(body));
}

/**
 * チケットの external-ref (gh-<N>) があるのに、PR 本文が issue #N を Closes/Fixes/Resolves/Refs
 * のいずれでも指していなければ止める (bdboard-4y8q.8、既存の前提条件エラーと同じ EXIT.PRECONDITION)。
 * チケットは assertReviewRecorded が読んだものを使う (bd は1回だけ読む)。bd が読めなければ、
 * このチェックに来る前にレビュー記録の確認が止める。
 * S0 モード/rebase が要る (cls === 'R')/CI が緑でない/--dry-run、といった他の理由で止まる PR には
 * このチェックを先回りさせない — それらは全部このチェックより前で return / fail する。
 * 一方、cls === 'F' の着地予定ツリー verify (数分・verify スロット消費) よりは前で呼ぶ —
 * 本文が issue を指していないだけで結局 fail するなら、その重い verify を走らせる前に安く弾く。
 */
export function assertExternalRefLinked(pull, ticket, id, pr) {
  if (ticket === null) {
    return; // release-please の PR (チケットなし)
  }
  const externalRef = typeof ticket?.external_ref === 'string' ? ticket.external_ref : null;
  const issueNumber = issueNumberFromExternalRef(externalRef);
  if (issueNumber === null || bodyReferencesIssue(pull.body, issueNumber)) {
    return;
  }
  audit('prepare-external-ref-missing', { pr, id, external_ref: externalRef, issue: issueNumber });
  fail(EXIT.PRECONDITION, ...externalRefSteps(id, externalRef, issueNumber, pr));
}
