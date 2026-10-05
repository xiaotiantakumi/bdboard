// bdboard-ulxa.1: merge-pr が使う GitHub 呼び出し。PR 情報と commit status は REST
// (`gh api`) で読む — GraphQL の枠切れで止まった実績がある (failure-catalog の
// graphql-quota-exhaustion)。必須チェックの判定だけは `gh pr checks --required` に任せる
// (どれが required かは ruleset 由来で、REST で組み立てると二重管理になる)。ただし判定は終了コードではなく
// --json の行ごとの bucket で行う (bdboard-bsc3: cancel は終了コードに現れない)。
import { run } from './exec.mjs';

const TRANSIENT = /graphql|rate limit|HTTP 5\d\d|timed? ?out|ETIMEDOUT|could not resolve|connection (refused|reset)|network/i;

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
    // external-ref の issue を Closes/Fixes/Resolves/Refs しているかの判定に使う (bdboard-4y8q.8)。
    body: typeof raw.body === 'string' ? raw.body : '',
    headSha: raw.head?.sha ?? null,
    headRef: raw.head?.ref ?? null,
    baseRef: raw.base?.ref ?? null,
    draft: raw.draft === true,
    // GitHub のマージ可否 (true / false / 計算中の null)。S2 は false をクラス R に倒す。
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
  };
}

// bdboard-bsc3: gh pr checks --json の行の bucket (gh の aggregateChecks。cli/cli v2.86.0
// pkg/cmd/pr/checks/aggregate.go) のうち、必須チェックとして満たされているもの。skipping は
// SKIPPED / NEUTRAL (GitHub の ruleset も満たしたものとして扱う)。これ以外 — fail・cancel・未知の綴り・
// 欠落 — は green ではない。pending だけは待てば変わるので別に数える。
const GREEN_BUCKETS = new Set(['pass', 'skipping']);

/**
 * `gh pr checks --required --json name,state,bucket,link` の stdout を判定する (純粋)。
 * 行は全部読む: fail・cancel・未知の bucket は 'fail'、pending が残れば 'pending'、全部 pass / skipping なら 'pass'。
 * 読めない出力 (JSON でない・配列でない) は 'unknown'、空の配列は 'fail' (gh は必須チェックが 0 件のとき自分で失敗する)。
 * cancelled は cancel の行 ({ name, link }) で、prepare が流し直しの案内に使う。
 */
export function judgeCheckRows(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) {
    return { verdict: 'unknown', output: String(stdout).trim(), cancelled: [] };
  }
  const cell = (value) => (typeof value === 'string' ? value : '');
  const lines = rows.map((row) => `${cell(row?.name)}\t${cell(row?.bucket)}\t${cell(row?.state)}\t${cell(row?.link)}`);
  const buckets = rows.map((row) => cell(row?.bucket));
  const cancelled = rows
    .filter((row) => cell(row?.bucket) === 'cancel')
    .map((row) => ({ name: cell(row?.name), link: cell(row?.link) }));
  let verdict = 'pass';
  if (rows.length === 0) {
    verdict = 'fail';
    lines.push('(gh pr checks が必須チェックを 1 件も返しませんでした)');
  } else if (buckets.some((bucket) => !GREEN_BUCKETS.has(bucket) && bucket !== 'pending')) {
    verdict = 'fail';
  } else if (buckets.includes('pending')) {
    verdict = 'pending';
  }
  return { verdict, output: lines.join('\n'), cancelled };
}

// --json を持たない古い gh の stderr (cobra の unknown flag / gh の Unknown JSON field)。
const JSON_UNSUPPORTED = /unknown (shorthand )?flag|unknown json field/i;

/**
 * 必須チェックの状態。bdboard-bsc3: `gh pr checks --json` の行ごとの bucket で判定する。終了コードは使えない:
 * cancel は fail にも pending にも数えられず (必須が cancel だけなら 0)、--json では fail / pending でも 0 になる。
 * 取得エラーと分かるものは 'unknown'。--json を持たない gh だけは従来の終了コード
 * (0 = 全 pass / 8 = pending / それ以外 = 失敗) に落ち、source: 'exit-code' を返す (cancel は見分けられない)。
 */
export function requiredChecks(ctx, pr) {
  const result = run('gh', ['pr', 'checks', String(pr), '--required', '--json', 'name,state,bucket,link'], { cwd: ctx.cwd });
  if (result.status === 0) {
    return { ...judgeCheckRows(result.stdout), source: 'json' };
  }
  if (JSON_UNSUPPORTED.test(result.stderr)) {
    return { ...requiredChecksByExitCode(ctx, pr), source: 'exit-code' };
  }
  return { ...verdictByExitCode(result), source: 'json' };
}

function requiredChecksByExitCode(ctx, pr) {
  return verdictByExitCode(run('gh', ['pr', 'checks', String(pr), '--required'], { cwd: ctx.cwd }));
}

function verdictByExitCode(result) {
  let verdict = result.status === 0 ? 'pass' : result.status === 8 ? 'pending' : 'fail';
  // gh pr checks は GraphQL。枠切れ・ネットワーク・タイムアウトを「CI が赤」と取り違えない
  // (stderr だけを見る。stdout はチェック名の一覧で、名前に network 等が入りうる)。
  if (verdict === 'fail' && TRANSIENT.test(result.stderr)) {
    verdict = 'unknown';
  }
  return { verdict, output: `${result.stdout}${result.stderr}`.trim(), cancelled: [] };
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
