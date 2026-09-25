// bdboard-4y8q.8: PR が、チケットの external-ref (GitHub issue) を実際に閉じる/参照するかの
// 機械チェック。1つの issue に複数チケットがあるとき、最後にマージする PR だけ Closes を書き、
// それ以外は Refs を書く規約 (docs/GIT-WORKFLOW.md「PR 本文で external-ref の issue を閉じる」、
// worktree-pr-flow.md §4 が正本)。どちらを書くかは担当の判断で、ここでは「どちらかがあること」
// だけを機械的に確かめる — 最後の PR かどうかの判定はしない (bd に「最後」を機械的に決める
//情報が無い)。
import { run } from './exec.mjs';

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
 * ticket id の bd チケットを読み、external_ref を返す。bd が使えない・出力が読めない等は
 * { ok: false, reason } (呼び出し側の fail-open 判断に委ねる — ここでは判定しない)。
 */
export function readExternalRef(ctx, id) {
  const result = run('bd', ['show', id, '--json'], { cwd: ctx.cwd });
  if (result.status !== 0) {
    return { ok: false, reason: result.stderr.trim() || `bd show ${id} --json (exit ${result.status})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: `bd show ${id} --json の出力が JSON として読めません` };
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.issues;
  const entry = Array.isArray(entries) ? entries[0] : undefined;
  if (entry === undefined || entry === null) {
    return { ok: false, reason: `bd show ${id} --json にチケットが含まれていません` };
  }
  return { ok: true, externalRef: typeof entry.external_ref === 'string' ? entry.external_ref : null };
}
