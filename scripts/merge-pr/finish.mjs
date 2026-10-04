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
// bdboard-ulxa.3: S3 のクラス L (軽量チェックだけ) も着地後検証はフル verify のまま。結果を監査ログ
// (light-landed) に残し、failure は S3 のすり抜け (S2 に戻す合図) として知らせる (light-landed.mjs。error の
// ときも L であることを残し、後の merge-pr verify が同じ扱いをする)。木の突き合わせは F が predicted-tree、
// L が light-tree (S2 の指標・戻し規則が数える predicted-tree に L を混ぜない)。
import { git, run } from './exec.mjs';
import { EXIT, REMOTE, fail, refetchMain } from './context.mjs';
import { getPull } from './github.mjs';
import { runLandedVerify } from './landed-verify.mjs';
import { lightLandedState, reportLightLanded } from './light-landed.mjs';
import { brokenMainSteps } from './messages.mjs';
import { releaseSlot } from './slot.mjs';
import { audit, readState, removeState, say, writeState } from './state.mjs';
import { clearVerifyRecord, guardAgainstRunningVerify, recordVerifyGroup, verifyingStamp } from './verify-guard.mjs';
import { forgetQueueSince } from './verify-queue.mjs';

// bdboard-2hj4: 古い verifyingPid の記録を捨てる上限。説明と bdboard-ky9l での位置づけは verify-guard.mjs。
export { VERIFYING_PID_MAX_AGE_MS } from './verify-guard.mjs';

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

/** prepare が着地予定ツリーで検証した記録 (F = フル verify、L = 軽量チェック) と、突き合わせの監査イベント名。無ければ null。 */
function predictedRecord(state) {
  if (state.class === 'F' && state.predictedTree) {
    return { tree: state.predictedTree, commit: state.predictedCommit, how: 'verify', event: 'predicted-tree' };
  }
  if (state.class === 'L' && state.lightTree) {
    return { tree: state.lightTree, commit: state.lightCommit, how: '軽量チェック', event: 'light-tree' };
  }
  return null;
}

/** クラス F / L: 着地した木と着地予定ツリーの一致を確かめる。一致なら true、確かめられなければ null。 */
function comparePredicted(ctx, pr, state, landed) {
  const predicted = predictedRecord(state);
  if (predicted === null) {
    return null;
  }
  const tree = run('git', ['rev-parse', `${landed}^{tree}`], { cwd: ctx.cwd });
  const landedTree = tree.status === 0 ? tree.stdout.trim() : '';
  if (landedTree === '') {
    // オフラインの finish 等で着地コミットを読めない。不一致と数えない (S2 の受け入れ指標を汚さない)。
    audit(predicted.event, { pr, id: state.id, match: 'unknown', predicted: predicted.tree, landed: 'unknown', class: state.class });
    say(`着地した木を読めないので着地予定ツリー (${predicted.tree.slice(0, 12)}) と比べていません。`);
    return null;
  }
  const match = landedTree === predicted.tree;
  audit(predicted.event, { pr, id: state.id, match, predicted: predicted.tree, landed: landedTree, class: state.class });
  if (!match) {
    say(
      `注意: 着地した木 (${landedTree.slice(0, 12) || '読めない'}) が prepare で ${predicted.how} した着地予定ツリー (${predicted.tree.slice(0, 12)}) と違います。`,
      `着地後検証の結果を正とします。差分: git diff ${predicted.commit ?? predicted.tree} ${landed} (bdboard-ulxa.2 に報告)`,
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
  guardAgainstRunningVerify(pr, initial);
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
  // bdboard-ky9l: 自分の PID と開始時刻を刻む (次の finish が PID 再利用か同一プロセスかを見分ける)。
  writeState(ctx.cwd, pr, { ...state, newMain: landed, ...verifyingStamp() });
  refetchMain(ctx);
  const parent = run('git', ['rev-parse', `${landed}^`], { cwd: ctx.cwd });
  if (parent.status === 0 && parent.stdout.trim() !== state.predBase) {
    say(`注意: マージコミット ${landed.slice(0, 12)} の親が PRED_BASE (${state.predBase.slice(0, 12)}) ではありません。着地した木をそのまま検証します。`);
  }
  const predictedMatch = comparePredicted(ctx, pr, state, landed);
  const verified = await runLandedVerify(ctx, landed, state.id, {
    retryHint: `BDBOARD_MERGER=chair npm run merge-pr -- finish ${pr}`,
    onSpawn: (child) => recordVerifyGroup(ctx, pr, child),
  });
  // bdboard-xdk8: 負荷由来の失敗で 1 回だけ再実行したときだけ retried=1 を足す (しなければ項目ごと出さない)。
  audit('landed-verify', { pr, id: state.id, new: landed, result: verified.result, retried: verified.retried ? 1 : undefined });
  reportLightLanded(state, landed, verified.result, 'finish', verified.retried); // error でも L であることを残す
  const leftover = run('git', ['ls-remote', REMOTE, `refs/heads/${pull.headRef}`], { cwd: ctx.cwd });
  if (leftover.status === 0 && leftover.stdout.trim() !== '') {
    say(`remote にブランチ ${pull.headRef} が残っています: git push origin --delete ${pull.headRef}`);
  }
  if (verified.result === 'error') {
    clearVerifyRecord(ctx, pr);
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
      : `クラス ${state.class}: 着地した木は prepare で ${predictedRecord(state).how} した着地予定ツリーと${predictedMatch ? '同一' : '異なります (上の注意を参照)'}。`;
  say(`着地後検証 success: ${landed.slice(0, 12)} (${ctx.statusContext})。`, `${compared}次は close と掃除 (worktree-pr-flow.md §6)。`);
  return EXIT.OK;
}

/** 任意の main の SHA を手で着地後検証して台帳に書く (自己修復・§3.6 の後始末用)。 */
export async function verifyLanded(ctx, sha) {
  const full = git(['rev-parse', `${sha}^{commit}`], { cwd: ctx.cwd });
  const by = `manual ${git(['config', '--default', 'unknown', 'user.name'], { cwd: ctx.cwd })}`;
  const verified = await runLandedVerify(ctx, full, by, { retryHint: `npm run merge-pr -- verify ${full}` });
  audit('landed-verify', { new: full, result: verified.result, by: 'manual', retried: verified.retried ? 1 : undefined });
  // finish が error で終わったクラス L の着地なら、その記録 (状態ファイル) から L を見分ける。
  reportLightLanded(lightLandedState(ctx.cwd, full), full, verified.result, 'manual', verified.retried);
  if (verified.result === 'error') {
    fail(EXIT.USAGE, '着地後検証を実行できませんでした (上のメッセージ参照)。');
  }
  if (verified.result === 'failure') {
    fail(EXIT.LANDED_FAILED, ...brokenMainSteps(full, ctx.repo, ctx.statusContext));
  }
  say(`着地後検証 success: ${full.slice(0, 12)}`);
  return EXIT.OK;
}
