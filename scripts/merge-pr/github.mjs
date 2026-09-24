// bdboard-ulxa.1: merge-pr が使う GitHub 呼び出し。PR 情報と commit status は REST
// (`gh api`) で読む — GraphQL の枠切れで止まった実績がある (failure-catalog の
// graphql-quota-exhaustion)。必須チェックの判定だけは `gh pr checks --required` に任せる
// (どれが required かは ruleset 由来で、REST で組み立てると二重管理になる)。
import { run } from './exec.mjs';

function ghJson(args, cwd) {
  const result = run('gh', args, { cwd });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`gh ${args.join(' ')} returned non-JSON output`);
  }
}

/** PR を REST で読み、merge-pr が使う形に畳む。 */
export function getPull(ctx, pr) {
  const raw = ghJson(['api', `repos/${ctx.repo}/pulls/${pr}`], ctx.cwd);
  return {
    number: raw.number,
    state: raw.state,
    merged: raw.merged === true,
    mergeCommitSha: typeof raw.merge_commit_sha === 'string' ? raw.merge_commit_sha : null,
    title: typeof raw.title === 'string' ? raw.title : '',
    headSha: raw.head?.sha ?? null,
    headRef: raw.head?.ref ?? null,
    baseRef: raw.base?.ref ?? null,
    draft: raw.draft === true,
  };
}

/**
 * 必須チェックの状態。`gh pr checks` の終了コードは 0 = 全 pass / 8 = pending /
 * それ以外 = 失敗 (または取得エラー)。
 */
export function requiredChecks(ctx, pr) {
  const result = run('gh', ['pr', 'checks', String(pr), '--required'], { cwd: ctx.cwd });
  const verdict = result.status === 0 ? 'pass' : result.status === 8 ? 'pending' : 'fail';
  return { verdict, output: `${result.stdout}${result.stderr}`.trim() };
}

/** sha の commit status のうち statusContext のもの (無ければ null)。 */
export function getLandedStatus(ctx, sha) {
  const raw = ghJson(['api', `repos/${ctx.repo}/commits/${sha}/status`], ctx.cwd);
  const statuses = Array.isArray(raw.statuses) ? raw.statuses : [];
  const mine = statuses.filter((status) => status?.context === ctx.statusContext);
  if (mine.length === 0) {
    return null;
  }
  // combined status は context ごとの最新 1 件を返す仕様だが、念のため updated_at で最新を選ぶ。
  mine.sort((a, b) => Date.parse(b.updated_at ?? b.created_at ?? 0) - Date.parse(a.updated_at ?? a.created_at ?? 0));
  const top = mine[0];
  return {
    state: top.state,
    description: top.description ?? '',
    updatedAt: Date.parse(top.updated_at ?? top.created_at ?? '') || null,
  };
}

/** commit status を投稿する。description は GitHub の上限 (140 文字) に切り詰める。 */
export function postLandedStatus(ctx, sha, state, description) {
  const args = [
    'api',
    '-X',
    'POST',
    `repos/${ctx.repo}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    `context=${ctx.statusContext}`,
    '-f',
    `description=${description.slice(0, 140)}`,
  ];
  const result = run('gh', args, { cwd: ctx.cwd });
  if (result.status !== 0) {
    throw new Error(`commit status (${state}) の投稿に失敗しました: ${result.stderr.trim()}`);
  }
}
