// bdboard-ulxa.1: フェーズ 1 (枠の外) — PR と main の状態を確かめ、どの main に対して
// マージするか (PRED_BASE) を決めて状態ファイルに残す。
//
// 分類 (設計 §2.3):
//   N = origin/main が PR head の祖先 (main 不動)。CI が見た木 = 着地する木。PRED_BASE = origin/main
//   R = main が進んでいて rebase が要る。rebase (か merge origin/main) → push → CI → prepare から
//       S1: main が進んでいれば常に R / S2: テキスト衝突・hot file のときだけ R (classify.mjs)
//   F = (S2 のみ) main が進んだが衝突も hot file も無い。着地予定ツリーを手元で verify して
//       通れば rebase せずに PRED_BASE = origin/main で gate へ (predicted.mjs、bdboard-ulxa.2)
// L (軽量チェック) は S3 (bdboard-ulxa.3)。
import { git, gitOk, run } from './exec.mjs';
import { classifyS2 } from './classify.mjs';
import { EXIT, fail, fetchedMain, ticketIdFor } from './context.mjs';
import { bodyReferencesIssue, issueNumberFromExternalRef, readExternalRef } from './external-ref.mjs';
import { getLandedStatus, getPull, requiredChecks } from './github.mjs';
import { brokenMainSteps, externalRefSteps, rebaseSteps } from './messages.mjs';
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

/** クラスを決める。S2 か --dry-run のときは S2 の分類も求める (dry-run では参考表示だけ)。 */
function classify(ctx, pull, predBase, head, { dryRun }) {
  const moved = !gitOk(['merge-base', '--is-ancestor', predBase, head], { cwd: ctx.cwd });
  const wantS2 = ctx.config.mode === 'S2' || dryRun;
  let s2 = !wantS2 ? null : moved ? classifyS2(ctx, predBase, head) : { class: 'N', reason: 'main 不動', overlap: [], mainFiles: [] };
  if (s2?.class === 'F' && pull.mergeable === false) {
    // GitHub が衝突と判定している (ort と GitHub の判定が食い違う)。gh pr merge が 405 で落ちるので R。
    s2 = { ...s2, class: 'R', reason: 'GitHub が PR を mergeable=false と判定しています' };
  }
  if (ctx.config.mode === 'S2') {
    return { cls: s2.class, s2 };
  }
  return { cls: moved ? 'R' : 'N', s2 };
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

/**
 * チケットの external-ref (gh-<N>) があるのに、PR 本文が issue #N を Closes/Fixes/Resolves/Refs
 * のいずれでも指していなければ止める (bdboard-4y8q.8、既存の前提条件エラーと同じ EXIT.PRECONDITION)。
 * bd が読めないときは fail-open — 警告だけして進む (bd 障害でマージ自体を止める理由にはしない)。
 * S0 モード/rebase が要る (cls === 'R')/CI が緑でない/--dry-run、といった他の理由で止まる PR には
 * このチェックを先回りさせない (bd への不要な呼び出しを避ける) — それらは全部このチェックより
 * 前で return / fail する。一方、cls === 'F' の着地予定ツリー verify (数分・verify スロット消費)
 * よりは前で呼ぶ — 本文が issue を指していないだけで結局 fail するなら、その重い verify を
 * 走らせる前に安く弾く。
 */
function assertExternalRefLinked(ctx, pull, id, pr) {
  const ref = readExternalRef(ctx, id);
  if (!ref.ok) {
    audit('prepare-external-ref-unreadable', { pr, id, reason: ref.reason });
    say(`external-ref を確認できませんでした (${ref.reason})。このチェックは省略して進みます (fail-open)。`);
    return;
  }
  const issueNumber = issueNumberFromExternalRef(ref.externalRef);
  if (issueNumber === null || bodyReferencesIssue(pull.body, issueNumber)) {
    return;
  }
  audit('prepare-external-ref-missing', { pr, id, external_ref: ref.externalRef, issue: issueNumber });
  fail(EXIT.PRECONDITION, ...externalRefSteps(id, ref.externalRef, issueNumber, pr));
}

export async function prepare(ctx, pr, { dryRun = false } = {}) {
  const prior = readState(ctx.cwd, pr);
  if (prior?.gateAt) {
    fail(
      EXIT.PRECONDITION,
      `PR #${pr} は gate 済みで枠を保持しています (${prior.holder})。prepare の前に npm run merge-pr -- finish ${pr}`,
    );
  }
  const pull = getPull(ctx, pr);
  assertOpenPull(ctx, pull, pr);
  const head = assertLocalHead(ctx, pull, pr);
  const id = ticketIdFor(pull.headRef, pr);
  const predBase = fetchedMain(ctx);
  const mode = ctx.config.mode;
  const { cls, s2 } = classify(ctx, pull, predBase, head, { dryRun });
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
    main_files: s2?.mainFiles.length,
    overlap: s2?.overlap.length,
  });
  say(
    `PR #${pr} (${id}) head=${head.slice(0, 12)} ${ctx.mainRef}=${predBase.slice(0, 12)} クラス=${cls} 必須チェック=${checks.verdict} merge.mode=${mode}`,
  );
  if (s2 !== null && mode !== 'S2') {
    say(`参考: merge.mode が S2 ならクラス=${s2.class} (${s2.reason}、main 側の変更 ${s2.mainFiles.length} 件・重なり ${s2.overlap.length} 件)`);
  } else if (s2 !== null && cls !== 'N') {
    say(`S2 の分類: ${s2.reason} (main 側の変更 ${s2.mainFiles.length} 件・重なり ${s2.overlap.length} 件)`);
  }
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
    fail(EXIT.NEEDS_REBASE, ...rebaseSteps(ctx.mainRef, mode === 'S2' ? s2.reason : undefined));
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
    say(`--dry-run: 状態ファイルは書きません${cls === 'F' ? ' (着地予定ツリーの verify もしません)' : ''}。`);
    return EXIT.OK;
  }
  removeState(ctx.cwd, pr);
  // external-ref のチェックは軽い (bd 呼び出し1回) 一方、cls === 'F' の着地予定ツリー verify は
  // 数分かかり verify スロットも消費する。PR 本文が issue を指していないだけで結局 fail する
  // なら、その重い verify の前に安く弾く (bdboard-4y8q.8 レビュー指摘)。
  assertExternalRefLinked(ctx, pull, id, pr);
  const state = { pr, id, head, predBase, class: cls, preparedAt: new Date().toISOString() };
  if (cls === 'F') {
    refuseBrokenBase(ctx, pr, predBase);
    say(`rebase せずに着地予定ツリー ${s2.tree.slice(0, 12)} を verify します (数分。verify スロット待ちを含む)。`);
    Object.assign(state, await verifyPredicted(ctx, pr, id, { predBase, head, tree: s2.tree }));
    say(`着地予定ツリーの verify success (${state.predictedVerifySecs} 秒)。`);
  }
  writeState(ctx.cwd, pr, state);
  say(`準備完了。次: npm run merge-pr -- gate ${pr}`);
  return EXIT.OK;
}
