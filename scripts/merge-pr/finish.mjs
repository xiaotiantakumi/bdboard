// bdboard-ulxa.1: フェーズ 3 — 枠を返す → (マージされていれば) 着地後検証 → 台帳へ記録。
//
// 枠を返すのが最優先なので、release は GitHub への問い合わせより先に行う (fetch が失敗しても
// 続行する — cli が openContext に allowOffline を渡す)。gh pr merge の成否は終了コードでは見ない
// ('main' is already used by worktree で exit 1 になってもマージ本体は成功する既知パターン)。REST
// の merged で判定する。merge.mode が S0 に戻されていても、gate 済みの記録があれば動く。
// --repair で gate した PR (state.repair) は main-broken の枠を握っているので、着地後検証が
// success になるまで返さない (設計 §3.6)。
import { git, run } from './exec.mjs';
import { EXIT, REMOTE, fail, refetchMain } from './context.mjs';
import { getPull } from './github.mjs';
import { runLandedVerify } from './landed-verify.mjs';
import { brokenMainSteps } from './messages.mjs';
import { releaseSlot } from './slot.mjs';
import { audit, readState, removeState, say, writeState } from './state.mjs';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function holdBrokenMain(ctx, id, sha) {
  // 設計 §3.6 手順 1: 壊れた main を見つけた者が枠を取り、修復まで握る (S0 の merger も止める)。
  const holder = `${id} / main-broken ${sha.slice(0, 12)}`;
  const got = run('bd', ['merge-slot', 'acquire', '--holder', holder], { cwd: ctx.cwd });
  say(
    got.status === 0
      ? `枠を ${holder} で取りました。修復 PR は prepare → gate --repair → gh pr merge → finish (success で枠が返ります)。`
      : `枠を取れませんでした (${got.stderr.trim()})。他の merger は台帳の failure を見て止まります。`,
  );
}

/** 通常の PR は最初に枠を返す (二度目の finish では返さない)。 */
function releaseFirst(ctx, pr, state) {
  if (state.repair || state.releasedAt) {
    return state;
  }
  releaseSlot(ctx.cwd, state.holder);
  const released = { ...state, releasedAt: new Date().toISOString() };
  writeState(ctx.cwd, pr, released);
  const heldS = Math.round((Date.parse(released.releasedAt) - Date.parse(state.gateAt)) / 1000);
  audit('finish-released', { pr, id: state.id, held_s: heldS, base: state.predBase });
  return released;
}

export async function finish(ctx, pr) {
  const initial = readState(ctx.cwd, pr);
  if (initial === null || !initial.gateAt) {
    fail(EXIT.PRECONDITION, `PR #${pr} を gate した記録がありません (枠を取っていない)。`);
  }
  if (initial.verifyingPid && pidAlive(initial.verifyingPid)) {
    fail(EXIT.RETRY, `PR #${pr} の着地後検証は PID ${initial.verifyingPid} で実行中です。二重に走らせません。`);
  }
  const state = releaseFirst(ctx, pr, initial);
  const kept = `main は壊れたままなので枠 (${state.holder}) は保持しています。`;
  const pull = getPull(ctx, pr);
  audit('finish-merged', { pr, id: state.id, merged: pull.merged, new: pull.mergeCommitSha ?? '' });
  if (!pull.merged) {
    removeState(ctx.cwd, pr);
    fail(
      EXIT.NOT_MERGED,
      `PR #${pr} はマージされていません。${state.repair ? kept : '枠は返しました。'}`,
      '  - gh pr merge が権限判定で拒否された → 再試行しない。bd comment にマージ手順を書き、human ラベル + human gate',
      `  - head 不一致 (409) / main が動いた → npm run merge-pr -- prepare ${pr} から`,
    );
  }
  const landed = pull.mergeCommitSha;
  writeState(ctx.cwd, pr, { ...state, newMain: landed, verifyingPid: process.pid });
  refetchMain(ctx);
  const parent = run('git', ['rev-parse', `${landed}^`], { cwd: ctx.cwd });
  if (parent.status === 0 && parent.stdout.trim() !== state.predBase) {
    say(`注意: マージコミット ${landed.slice(0, 12)} の親が PRED_BASE (${state.predBase.slice(0, 12)}) ではありません。着地した木をそのまま検証します。`);
  }
  const verified = await runLandedVerify(ctx, landed, state.id);
  audit('landed-verify', { pr, id: state.id, new: landed, result: verified.result });
  const leftover = run('git', ['ls-remote', REMOTE, `refs/heads/${pull.headRef}`], { cwd: ctx.cwd });
  if (leftover.status === 0 && leftover.stdout.trim() !== '') {
    say(`remote にブランチ ${pull.headRef} が残っています: git push origin --delete ${pull.headRef}`);
  }
  if (verified.result === 'error') {
    writeState(ctx.cwd, pr, { ...readState(ctx.cwd, pr), verifyingPid: null });
    fail(
      EXIT.USAGE,
      `着地後検証を実行できませんでした。台帳 (${ctx.statusContext}) の ${landed.slice(0, 12)} には結果を書いていません。`,
      `原因を直して npm run merge-pr -- verify ${landed} を実行してください (LEASE を過ぎると次の merger が自己修復します)。`,
      ...(state.repair ? [kept, `success を確かめたら: bd merge-slot release --holder '${state.holder}'`] : []),
    );
  }
  removeState(ctx.cwd, pr);
  if (verified.result === 'failure') {
    if (state.repair) {
      say(`修復後も failure です。${kept}`);
    } else {
      holdBrokenMain(ctx, state.id, landed);
    }
    fail(EXIT.LANDED_FAILED, ...brokenMainSteps(landed, ctx.repo, ctx.statusContext));
  }
  if (state.repair) {
    releaseSlot(ctx.cwd, state.holder);
    audit('repair-released', { pr, id: state.id, holder: state.holder, new: landed });
    say(`main が緑に戻ったので枠 (${state.holder}) を返しました。壊した PR のチケットを再 open して理由を残してください。`);
  }
  const sameTree = run('git', ['diff', '--quiet', state.head, landed], { cwd: ctx.cwd }).status === 0;
  say(
    `着地後検証 success: ${landed.slice(0, 12)} (${ctx.statusContext})。`,
    `着地した木と PR head ${state.head.slice(0, 12)} の木は${sameTree ? '同一' : '異なります (git diff --stat で確認)'}。次は close と掃除 (worktree-pr-flow.md §6)。`,
  );
  return EXIT.OK;
}

/** 任意の main の SHA を手で着地後検証して台帳に書く (自己修復・§3.6 の後始末用)。 */
export async function verifyLanded(ctx, sha) {
  const full = git(['rev-parse', `${sha}^{commit}`], { cwd: ctx.cwd });
  const by = `manual ${git(['config', '--default', 'unknown', 'user.name'], { cwd: ctx.cwd })}`;
  const verified = await runLandedVerify(ctx, full, by);
  audit('landed-verify', { new: full, result: verified.result, by: 'manual' });
  if (verified.result === 'error') {
    fail(EXIT.USAGE, '着地後検証を実行できませんでした (上のメッセージ参照)。');
  }
  if (verified.result === 'failure') {
    fail(EXIT.LANDED_FAILED, ...brokenMainSteps(full, ctx.repo, ctx.statusContext));
  }
  say(`着地後検証 success: ${full.slice(0, 12)}`);
  return EXIT.OK;
}
