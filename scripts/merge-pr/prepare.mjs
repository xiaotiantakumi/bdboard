// bdboard-ulxa.1: フェーズ 1 (枠の外) — PR と main の状態を確かめ、どの main に対して
// マージするか (PRED_BASE) を決めて状態ファイルに残す。
//
// 分類 (設計 §2.3):
//   N = origin/main が PR head の祖先 (main 不動)。CI が見た木 = 着地する木。PRED_BASE = origin/main
//   R = main が進んでいて rebase が要る。rebase (か merge origin/main) → push → CI → prepare から
//       S1: main が進んでいれば常に R / S2: テキスト衝突・hot file のときだけ R (classify.mjs)
//   F = (S2 / S3) main が進んだが衝突も hot file も無い。着地予定ツリーを手元で verify して
//       通れば rebase せずに PRED_BASE = origin/main で gate へ (predicted.mjs、bdboard-ulxa.2)
//   L = (S3 のみ) F のうち変更ファイルの重なりが無く、どちらの側も hot file に触れていない。着地予定
//       ツリーで軽量チェック (merge.lightCheck) だけを回す (bdboard-ulxa.3)。着地後検証はフル verify
import { git, gitOk, run } from './exec.mjs';
import { classifyForMode, describeClass } from './mode-class.mjs';
import { PREDICTED_MODES } from './config.mjs';
import { EXIT, fail, fetchedMain, ticketIdFor } from './context.mjs';
import { assertExternalRefLinked } from './external-ref.mjs';
import { getLandedStatus, getPull, requiredChecks } from './github.mjs';
import { brokenMainSteps, keptLightFailureSteps, rebaseSteps } from './messages.mjs';
import { verifyPredicted } from './predicted.mjs';
import { audit, readState, removeState, say, writeState } from './state.mjs';

/** PR が OPEN・draft でない・base が main であることを確かめる (gate でも使う)。 */
export function assertOpenPull(ctx, pull, pr) {
  if (pull.merged) {
    fail(EXIT.PRECONDITION, `PR #${pr} は既にマージ済みです。`);
  }
  if (pull.state !== 'open') {
    fail(EXIT.PRECONDITION, `PR #${pr} は ${pull.state} です (open ではない)。`);
  }
  if (pull.draft) {
    fail(EXIT.PRECONDITION, `PR #${pr} は draft です。`);
  }
  if (pull.baseRef !== ctx.config.mainBranch) {
    fail(EXIT.PRECONDITION, `PR #${pr} の base は ${pull.baseRef} です (${ctx.config.mainBranch} ではない)。`);
  }
}

/** release-please は Beads のチケットを持たないリリース自動 PR。 */
export function isReleasePleasePull(pull) {
  return pull.headRef?.startsWith('release-please--') === true;
}

const REVIEW_MODEL = /^(?:claude[-:])?(?:opus|fable)(?![a-z])/i;

/** レビューは Opus または Fable の記録がある PR だけをマージ手順へ進める。 */
export function hasApprovedReview(metadata) {
  const value = metadata?.['bdboard.model.review'];
  return typeof value === 'string' && REVIEW_MODEL.test(value.trim());
}

/** レビュー記録を確かめ、読んだチケットを返す (release-please の PR はチケットを持たないので null)。 */
function assertReviewRecorded(ctx, pull, pr) {
  if (isReleasePleasePull(pull)) {
    return null;
  }
  const match = /^bd\/(.+)$/.exec(pull.headRef ?? '');
  if (match === null) {
    fail(EXIT.PRECONDITION, `PR #${pr} のチケット ID がありません。bd/<id> ブランチで作成してください。`);
  }
  const id = match[1];
  const shown = run('bd', ['show', id, '--json', '--readonly'], { cwd: ctx.cwd });
  if (shown.status !== 0) {
    const detail = `${shown.stdout}${shown.stderr}`;
    if (/no issue(s)? found/i.test(detail)) {
      audit('prepare-review-missing', { pr, id, reason: 'not-found' });
      fail(EXIT.PRECONDITION, `チケット ${id} が bd にありません`);
    }
    audit('prepare-review-missing', { pr, id, reason: 'bd-error' });
    fail(EXIT.USAGE, `bd show ${id} --json に失敗しました: ${(shown.stderr || shown.stdout).trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(shown.stdout);
  } catch {
    audit('prepare-review-missing', { pr, id, reason: 'bad-json' });
    fail(EXIT.USAGE, `bd show ${id} --json の出力が JSON ではありません: ${shown.stdout.trim()}`);
  }
  const ticket = Array.isArray(parsed) ? parsed[0] : parsed;
  const value = ticket?.metadata?.['bdboard.model.review'];
  if (!hasApprovedReview(ticket?.metadata)) {
    audit('prepare-review-missing', { pr, id, reason: 'no-match', value: value ?? '' });
    fail(
      EXIT.PRECONDITION,
      `レビュー記録がありません: bd update ${id} --set-metadata bdboard.model.review=<model>`,
      `現在の値: ${value ?? 'なし'}`,
    );
  }
  return ticket;
}

function assertLocalHead(ctx, pull, pr) {
  const head = git(['rev-parse', 'HEAD'], { cwd: ctx.cwd });
  if (head !== pull.headSha) {
    const detached = run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: ctx.cwd }).status !== 0;
    fail(
      EXIT.PRECONDITION,
      `ローカル HEAD (${head.slice(0, 12)}) が PR #${pr} の head (${String(pull.headSha).slice(0, 12)}) と違います。`,
      'PR の worktree で実行しているか、push 済みかを確認してください。',
      ...(detached ? [`HEAD が detach されたままです (verify の中断?)。git checkout ${pull.headRef} で戻してください。`] : []),
    );
  }
  return head;
}

/** 台帳が failure の main の上で着地予定ツリーを verify しても落ちるだけ。先に「main が壊れている」を返す。 */
function refuseBrokenBase(ctx, pr, predBase) {
  let ledger;
  try {
    ledger = getLandedStatus(ctx, predBase);
  } catch {
    return; // 読めなければ進む (gate が台帳を待つ・自己修復する)
  }
  if (ledger?.state === 'failure' || ledger?.state === 'error') {
    audit('prepare-main-broken', { pr, base: predBase });
    fail(
      EXIT.MAIN_BROKEN,
      ...brokenMainSteps(predBase, ctx.repo, ctx.statusContext),
      `  (この PR が修復 PR なら: git merge ${ctx.mainRef} → push → CI → prepare でクラス N にしてから gate --repair)`,
    );
  }
}

export async function prepare(ctx, pr, { dryRun = false } = {}) {
  const mergeBase = run('git', ['merge-base', 'HEAD', ctx.mainRef], { cwd: ctx.cwd });
  if (mergeBase.status !== 0) {
    fail(
      EXIT.USAGE,
      `HEAD と ${ctx.mainRef} の merge base を特定できませんでした: ${mergeBase.stderr.trim()}`,
    );
  }
  const mergeBaseSha = mergeBase.stdout.trim();
  if (!gitOk(['diff', '--quiet', mergeBaseSha, ctx.mainRef, '--', 'scripts/merge-pr', 'scripts/merge-pr.mjs'], { cwd: ctx.cwd })) {
    fail(
      EXIT.NEEDS_REBASE,
      `merge-pr 自身のコード (scripts/merge-pr) が ${ctx.mainRef} と食い違っています。`,
      `git merge ${ctx.mainRef} で取り込んでから npm run merge-pr -- prepare ${pr} をやり直してください。`,
    );
  }
  const prior = readState(ctx.cwd, pr);
  if (prior?.landedResult === 'failure') {
    fail(EXIT.PRECONDITION, ...keptLightFailureSteps(pr, prior)); // finish が failure で残したクラス L の記録 (bdboard-ulxa.7)
  }
  if (prior?.gateAt) {
    fail(
      EXIT.PRECONDITION,
      `PR #${pr} は gate 済みで枠を保持しています (${prior.holder})。prepare の前に BDBOARD_MERGER=chair npm run merge-pr -- finish ${pr}`,
    );
  }
  const pull = getPull(ctx, pr);
  assertOpenPull(ctx, pull, pr);
  const ticket = assertReviewRecorded(ctx, pull, pr);
  const head = assertLocalHead(ctx, pull, pr);
  const id = ticketIdFor(pull.headRef, pr);
  const predBase = fetchedMain(ctx);
  const mode = ctx.config.mode;
  const { cls, s2, s3 } = classifyForMode(ctx, pull, predBase, head, { dryRun });
  const checks = cls !== 'R' ? requiredChecks(ctx, pr) : { verdict: 'skipped', output: '' };
  audit('prepare', {
    pr,
    id,
    mode,
    class: cls,
    head,
    base: predBase,
    checks: checks.verdict,
    s2: s2?.class,
    s3: s3?.class,
    main_files: s2?.mainFiles.length,
    overlap: s2?.overlap.length,
  });
  say(
    `PR #${pr} (${id}) head=${head.slice(0, 12)} ${ctx.mainRef}=${predBase.slice(0, 12)} クラス=${cls} 必須チェック=${checks.verdict} merge.mode=${mode}`,
  );
  say(...describeClass(mode, cls, s2, s3, dryRun));
  if (mode === 'S0') {
    removeState(ctx.cwd, pr);
    say(
      `merge.mode は ${mode} です (${ctx.config.source})。gate / finish は動きません。`,
      '現行手順 (docs/GIT-WORKFLOW.md「Merge serialization」の S0) でマージしてください。',
    );
    return EXIT.OK;
  }
  if (cls === 'R') {
    removeState(ctx.cwd, pr);
    fail(EXIT.NEEDS_REBASE, ...rebaseSteps(ctx.mainRef, PREDICTED_MODES.includes(mode) ? s2.reason : undefined));
  }
  if (checks.verdict === 'unknown') {
    fail(EXIT.RETRY, '必須チェックの状態を GitHub から取得できませんでした (API の枠・ネットワーク)。時間を置いて prepare し直してください:', checks.output);
  }
  if (checks.verdict === 'pending') {
    fail(EXIT.RETRY, '必須チェックがまだ終わっていません。gh pr checks <n> --required --watch で待ってから prepare し直してください。');
  }
  if (checks.verdict !== 'pass') {
    fail(EXIT.PRECONDITION, '必須チェックが green ではありません:', checks.output);
  }
  if (dryRun) {
    const skipped = { F: ' (着地予定ツリーの verify もしません)', L: ' (着地予定ツリーの軽量チェックもしません)' }[cls] ?? '';
    say(`--dry-run: 状態ファイルは書きません${skipped}。`);
    return EXIT.OK;
  }
  removeState(ctx.cwd, pr);
  // external-ref のチェックは軽い (読み済みのチケットを見るだけ) 一方、cls === 'F' の着地予定ツリー verify は
  // 数分かかり verify スロットも消費する。PR 本文が issue を指していないだけで結局 fail する
  // なら、その重い verify の前に安く弾く (bdboard-4y8q.8 レビュー指摘)。
  assertExternalRefLinked(pull, ticket, id, pr);
  const state = { pr, id, head, predBase, class: cls, preparedAt: new Date().toISOString() };
  if (cls === 'F') {
    refuseBrokenBase(ctx, pr, predBase);
    say(`rebase せずに着地予定ツリー ${s2.tree.slice(0, 12)} を verify します (数分。verify スロット待ちを含む)。`);
    Object.assign(state, await verifyPredicted(ctx, pr, id, { predBase, head, tree: s2.tree }));
    say(`着地予定ツリーの verify success (${state.predictedVerifySecs} 秒)。`);
  }
  if (cls === 'L') {
    // bdboard-ulxa.3: 軽量チェックの成功は light* に残す (フル verify の predicted* とは別。gate が見分ける)。
    refuseBrokenBase(ctx, pr, predBase);
    say(`rebase せずに着地予定ツリー ${s3.tree.slice(0, 12)} で軽量チェック (${ctx.config.lightCheck}) を回します (テストは着地後検証で回る)。`);
    Object.assign(state, await verifyPredicted(ctx, pr, id, { predBase, head, tree: s3.tree }, { kind: 'light' }));
    say(`着地予定ツリーの軽量チェック success (${state.lightCheckSecs} 秒)。`);
  }
  writeState(ctx.cwd, pr, state);
  say(`準備完了。次: BDBOARD_MERGER=chair npm run merge-pr -- gate ${pr}`);
  return EXIT.OK;
}
