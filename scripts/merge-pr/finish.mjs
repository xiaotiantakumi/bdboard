// bdboard-ulxa.1: フェーズ 3 — 枠を返す → (マージされていれば) 着地後検証 → 台帳へ記録。
//
// 枠を返すのが最優先なので、release は GitHub への問い合わせより先に行う (fetch が失敗しても
// 続行する — cli が openContext に allowOffline を渡す)。gh pr merge の成否は終了コードでは見ない
// ('main' is already used by worktree で exit 1 になってもマージ本体は成功する既知パターン)。REST
// の merged で判定する。merge.mode が S0 に戻されていても、gate 済みの記録があれば動く。
// --repair で gate した PR (state.repair) は main-broken の枠を握っているので、着地後検証が
// success になるまで返さない (設計 §3.6)。
// bdboard-ulxa.2: S2 のクラス F (rebase なし) は、着地した木が prepare で verify した着地予定ツリーと
// 同じかを突き合わせて表示・監査ログに残す。違っても着地後検証の結果が正 (台帳はいつもどおり)。
import { git, run } from './exec.mjs';
import { EXIT, REMOTE, fail, refetchMain } from './context.mjs';
import { getPull } from './github.mjs';
import { runLandedVerify } from './landed-verify.mjs';
import { brokenMainSteps } from './messages.mjs';
import { releaseSlot } from './slot.mjs';
import { audit, readState, removeState, say, writeState } from './state.mjs';
import { forgetQueueSince } from './verify-queue.mjs';

// bdboard-2hj4: verifyingPid の記録を「実行中」とみなす上限。状態ファイル (state.mjs) は finish が
// 中断・クラッシュしても残るので、書いた PID が後で別プロセスに再利用される (pidAlive は EPERM も
// alive 扱い) と、記録が永久に「二重に走らせません」(RETRY 75) になる。そこで verifyingAt (書いた時刻)
// からこの時間を超えた記録は、PID が生きていても古い記録として無視する。
// 値は、finish が正規に走っていられる時間より十分長く取る。verify スロットの待ちには上限が無い
// (waitTimeoutMs 15 分が効くのは走っている holder の顔ぶれが 15 分変わらないときだけで、列が進んで
// いる間は待ち続ける。verify-slot.mjs)。ほかに lockfile が変わったときの npm ci と、ネットワーク
// 呼び出しのタイムアウト (各 120 秒、exec.mjs) も足される。実測では landed-verify のログ 133 件で
// スロット待ちが最大 685 秒、vitest の合計が最大約 524 秒、finish から着地後検証の完了までは通常
// 4〜5 分なので、2 時間は十分に長い。並んだ時刻の記録を捨てる SENIORITY_RESET_MS (verify-queue.mjs)
// と同じ値にそろえた。短すぎると、本当に走っている finish と同じ worktree で 2 本目の verify が並走し、
// 1 本目の restoreBranch (landed-verify.mjs) が 2 本目の途中で木を差し替えて誤った結果を台帳に書く
// (長すぎる害は待つだけ)。
export const VERIFYING_PID_MAX_AGE_MS = 2 * 60 * 60_000;

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

/**
 * verifyingPid の記録からの経過ミリ秒。verifyingAt が無い・読めない記録は null
 * (bdboard-2hj4 より前に書かれた状態ファイル — 後方互換のため pid の生存だけで判定させる)。
 */
function verifyingAgeMs(state, now = Date.now()) {
  const writtenAt = typeof state.verifyingAt === 'string' ? Date.parse(state.verifyingAt) : Number.NaN;
  return Number.isFinite(writtenAt) ? now - writtenAt : null;
}

function holdBrokenMain(ctx, id, sha) {
  // 設計 §3.6 手順 1: 壊れた main を見つけた者が枠を取り、修復まで握る (S0 の merger も止める)。
  const holder = `${id} / main-broken ${sha.slice(0, 12)}`;
  const got = run('bd', ['merge-slot', 'acquire', '--holder', holder], { cwd: ctx.cwd });
  say(
    got.status === 0
      ? `枠を ${holder} で取りました。修復 PR は prepare → BDBOARD_MERGER=chair npm run merge-pr -- gate --repair → gh pr merge → BDBOARD_MERGER=chair npm run merge-pr -- finish (success で枠が返ります)。`
      : `枠を取れませんでした (${got.stderr.trim()})。他の merger は台帳の failure を見て止まります。`,
  );
}

/** クラス F: 着地した木と着地予定ツリーの一致を確かめる。一致なら true、確かめられなければ null。 */
function comparePredicted(ctx, pr, state, landed) {
  if (state.class !== 'F' || !state.predictedTree) {
    return null;
  }
  const tree = run('git', ['rev-parse', `${landed}^{tree}`], { cwd: ctx.cwd });
  const landedTree = tree.status === 0 ? tree.stdout.trim() : '';
  if (landedTree === '') {
    // オフラインの finish 等で着地コミットを読めない。不一致と数えない (S2 の受け入れ指標を汚さない)。
    audit('predicted-tree', { pr, id: state.id, match: 'unknown', predicted: state.predictedTree, landed: 'unknown' });
    say(`着地した木を読めないので着地予定ツリー (${state.predictedTree.slice(0, 12)}) と比べていません。`);
    return null;
  }
  const match = landedTree === state.predictedTree;
  audit('predicted-tree', { pr, id: state.id, match, predicted: state.predictedTree, landed: landedTree });
  if (!match) {
    say(
      `注意: 着地した木 (${landedTree.slice(0, 12) || '読めない'}) が prepare で verify した着地予定ツリー (${state.predictedTree.slice(0, 12)}) と違います。`,
      `着地後検証の結果を正とします。差分: git diff ${state.predictedCommit ?? state.predictedTree} ${landed} (bdboard-ulxa.2 に報告)`,
    );
  }
  return match;
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
  // 自分と同じ PID の記録は、死んだ finish の PID がたまたま自分に再利用されたもの (bdboard-2hj4)。
  if (initial.verifyingPid && initial.verifyingPid !== process.pid && pidAlive(initial.verifyingPid)) {
    const ageMs = verifyingAgeMs(initial);
    if (ageMs === null || ageMs <= VERIFYING_PID_MAX_AGE_MS) {
      const expiry =
        ageMs === null
          ? '記録に時刻が無い (旧形式) ので、PID が終わるまで古い記録とはみなしません。'
          : `記録は ${initial.verifyingAt} で、あと ${Math.ceil((VERIFYING_PID_MAX_AGE_MS - ageMs) / 60_000)} 分で古い記録として扱います。`;
      fail(
        EXIT.RETRY,
        `PR #${pr} の着地後検証は PID ${initial.verifyingPid} で実行中です。二重に走らせません。`,
        `  ${expiry}`,
        `  PID が本当に finish か確かめる: ps -p ${initial.verifyingPid} -o lstart=,command=`,
      );
    }
    say(
      `PR #${pr} の verifyingPid ${initial.verifyingPid} は ${initial.verifyingAt} (${Math.round(ageMs / 60_000)} 分前) の記録で、上限 ${Math.round(VERIFYING_PID_MAX_AGE_MS / 60_000)} 分を超えています。`,
      'PID 再利用などの古い記録とみなして無視し、着地後検証を進めます。',
    );
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
      '  - 405 "not mergeable" (GitHub は衝突と判定) → rebase してから prepare (S2 のクラス F でも)',
    );
  }
  const landed = pull.mergeCommitSha;
  forgetQueueSince(ctx.cwd, pr); // 着地予定ツリーの verify に並んだ時刻 (bdboard-ulxa.6) はもう要らない
  writeState(ctx.cwd, pr, { ...state, newMain: landed, verifyingPid: process.pid, verifyingAt: new Date().toISOString() });
  refetchMain(ctx);
  const parent = run('git', ['rev-parse', `${landed}^`], { cwd: ctx.cwd });
  if (parent.status === 0 && parent.stdout.trim() !== state.predBase) {
    say(`注意: マージコミット ${landed.slice(0, 12)} の親が PRED_BASE (${state.predBase.slice(0, 12)}) ではありません。着地した木をそのまま検証します。`);
  }
  const predictedMatch = comparePredicted(ctx, pr, state, landed);
  const verified = await runLandedVerify(ctx, landed, state.id, { retryHint: `BDBOARD_MERGER=chair npm run merge-pr -- finish ${pr}` });
  audit('landed-verify', { pr, id: state.id, new: landed, result: verified.result });
  const leftover = run('git', ['ls-remote', REMOTE, `refs/heads/${pull.headRef}`], { cwd: ctx.cwd });
  if (leftover.status === 0 && leftover.stdout.trim() !== '') {
    say(`remote にブランチ ${pull.headRef} が残っています: git push origin --delete ${pull.headRef}`);
  }
  if (verified.result === 'error') {
    writeState(ctx.cwd, pr, { ...readState(ctx.cwd, pr), verifyingPid: null, verifyingAt: null });
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
  const compared =
    predictedMatch === null
      ? `着地した木と PR head ${state.head.slice(0, 12)} の木は${sameTree ? '同一' : '異なります (git diff --stat で確認)'}。`
      : `クラス F: 着地した木は prepare で verify した着地予定ツリーと${predictedMatch ? '同一' : '異なります (上の注意を参照)'}。`;
  say(`着地後検証 success: ${landed.slice(0, 12)} (${ctx.statusContext})。`, `${compared}次は close と掃除 (worktree-pr-flow.md §6)。`);
  return EXIT.OK;
}

/** 任意の main の SHA を手で着地後検証して台帳に書く (自己修復・§3.6 の後始末用)。 */
export async function verifyLanded(ctx, sha) {
  const full = git(['rev-parse', `${sha}^{commit}`], { cwd: ctx.cwd });
  const by = `manual ${git(['config', '--default', 'unknown', 'user.name'], { cwd: ctx.cwd })}`;
  const verified = await runLandedVerify(ctx, full, by, { retryHint: `npm run merge-pr -- verify ${full}` });
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
