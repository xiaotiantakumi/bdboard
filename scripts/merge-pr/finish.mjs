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
import { git, run, shellQuote } from './exec.mjs';
import { EXIT, REMOTE, fail, liveMain, refetchMain } from './context.mjs';
import { holdOrReturnSlot, releaseFirst } from './finish-entry.mjs';
import { getLandedStatus, getPull } from './github.mjs';
import { runLandedVerify } from './landed-verify.mjs';
import { forgetLightFailure, lightLandedState, reportLightLanded } from './light-landed.mjs';
import { brokenMainSteps, keptLightFailureSteps, mainBrokenSlotHeldSteps, mainBrokenSlotUnknownSteps, mainMovedOnSteps, unverifiedTipSteps } from './messages.mjs';
import { forgetLoadInduced } from './predicted-timeouts.mjs';
import { mainBrokenSlot, releaseSlot } from './slot.mjs';
import { audit, readState, removeState, say, writeState } from './state.mjs';
import { forgetQueueSince } from './verify-queue.mjs';

function holdBrokenMain(ctx, id, sha) {
  // 設計 §3.6 手順 1: 壊れた main を見つけた者が枠を取り、修復まで握る (S0 の merger も止める)。
  const holder = `${id} / main-broken ${sha.slice(0, 12)}`;
  const got = run('bd', ['merge-slot', 'acquire', '--holder', holder], { cwd: ctx.cwd });
  say(
    got.status === 0
      ? `枠を ${holder} で取りました。修復 PR は prepare → BDBOARD_MERGER=chair npm run merge-pr -- gate --repair → gh pr merge → BDBOARD_MERGER=chair npm run merge-pr -- finish (success で枠が返ります)。`
      : `枠を取れませんでした (${got.stderr.trim()})。他の merger は台帳の failure を見て止まります。`,
  );
  return holder;
}

/**
 * bdboard-89jv: 着地後検証が failure のときの締め。「main は先へ進んだ」と言えるのは、先頭が着地コミットの厳密な子孫と
 * 確かめられたときだけ。そのときは main-broken の枠を取らない — 修復が先に着地した後に古い SHA の枠を取ると、誰も返さないまま
 * 全 gate を止める。それ以外 (先頭 == 着地コミット・祖先・無関係) は従来どおり枠を取る (設計 §3.6)。
 *
 * 先頭は ls-remote (liveMain) と fetch 済みの origin/main の両方を見て、どちらかが着地コミットの厳密な子孫なら「進んだ」とする。
 * fetch に使う手元の origin/main は、stale な ref lock が残っていると fetch がオブジェクトは落としても ref を動かせず、マージ前の
 * PRED_BASE (着地コミットの祖先) のままになる (bdboard-1syo、finish は allowOffline で続ける)。それだけを見て「進んだ」と読むと、
 * 壊れた main に枠を取らず、先頭の台帳 success の案内まで出してしまう。ls-remote は lock の影響を受けないので祖先判定を必ず挟む。
 * ls-remote は fetch より先に読む: fetch がいま読んだ先頭のオブジェクトを落とし、間に着地が挟まる隙も閉じる。
 * 先頭が着地コミットでないのに祖先を調べられない (fetch が失敗してオブジェクトが無い等。exit 128) ときは、枠は取ったまま
 * (安全側) 先頭 T の名前を出し、T が子孫と分かったら枠を返す手順を添える (unverifiedTipSteps)。
 */
function failedLanding(ctx, pr, id, landed) {
  const live = liveMain(ctx);
  const fetched = refetchMain(ctx);
  const tips = [live, fetched].filter((sha, i, all) => sha !== null && sha !== landed && all.indexOf(sha) === i);
  const checked = tips.map((sha) => ({ sha, relation: relationToLanded(ctx, landed, sha) }));
  const moved = checked.find((c) => c.relation === 'descendant');
  if (moved !== undefined) {
    audit('finish-main-moved-on', { pr, id, landed, tip: moved.sha });
    return mainMovedOnSteps(landed, moved.sha, tipLedger(ctx, moved.sha), ctx.repo, ctx.statusContext);
  }
  const holder = holdBrokenMain(ctx, id, landed);
  const unchecked = checked.find((c) => c.relation === 'unknown');
  const caveat = unchecked === undefined ? [] : unverifiedTipSteps(landed, unchecked.sha, holder);
  return [...caveat, ...brokenMainSteps(landed, ctx.repo, ctx.statusContext)];
}

/** 着地コミットから見た先頭: 'descendant' (厳密な子孫) / 'other' (祖先・無関係) / 'unknown' (祖先を調べられない = exit 0/1 以外)。 */
function relationToLanded(ctx, landed, tip) {
  const { status } = run('git', ['merge-base', '--is-ancestor', landed, tip], { cwd: ctx.cwd });
  return status === 0 ? 'descendant' : status === 1 ? 'other' : 'unknown';
}

/** 案内の文面を選ぶためだけに先頭の台帳を読む。読めなくても落とさない。 */
function tipLedger(ctx, tip) {
  try {
    return getLandedStatus(ctx, tip)?.state ?? 'none';
  } catch {
    return 'unknown';
  }
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

export async function finish(ctx, pr) {
  const initial = readState(ctx.cwd, pr);
  if (initial === null || !initial.gateAt) {
    fail(EXIT.PRECONDITION, `PR #${pr} を gate した記録がありません (枠を取っていない)。`);
  }
  if (initial.landedResult === 'failure') {
    // bdboard-ulxa.7: クラス L の failure で残した記録 (下)。やり直すと直った後の main に main-broken の枠を取り直す。
    fail(EXIT.PRECONDITION, ...keptLightFailureSteps(pr, initial));
  }
  holdOrReturnSlot(ctx, pr);
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
  forgetLoadInduced(ctx.cwd, pr); // 時間切れだけで落ちた記録 (bdboard-e8jj) も
  writeState(ctx.cwd, pr, { ...state, newMain: landed });
  refetchMain(ctx);
  const parent = run('git', ['rev-parse', `${landed}^`], { cwd: ctx.cwd });
  if (parent.status === 0 && parent.stdout.trim() !== state.predBase) {
    say(`注意: マージコミット ${landed.slice(0, 12)} の親が PRED_BASE (${state.predBase.slice(0, 12)}) ではありません。着地した木をそのまま検証します。`);
  }
  const predictedMatch = comparePredicted(ctx, pr, state, landed);
  const verified = await runLandedVerify(ctx, landed, state.id, {
    retryHint: `BDBOARD_MERGER=chair npm run merge-pr -- finish ${pr}`,
  });
  // bdboard-xdk8: 負荷由来の失敗で 1 回だけ再実行したときだけ retried=1 を足す (しなければ項目ごと出さない)。
  // bdboard-7qhq: failure のログに子プロセスの時間切れ (spawnSync ETIMEDOUT) があれば etimedout=N も足す (0 件は出さない)。
  audit('landed-verify', { pr, id: state.id, new: landed, result: verified.result, retried: verified.retried ? 1 : undefined, etimedout: verified.etimedout || undefined });
  reportLightLanded(state, landed, verified.result, 'finish', verified.retried); // error でも L であることを残す
  const leftover = run('git', ['ls-remote', REMOTE, `refs/heads/${pull.headRef}`], { cwd: ctx.cwd });
  if (leftover.status === 0 && leftover.stdout.trim() !== '') {
    say(`remote にブランチ ${pull.headRef} が残っています: git push origin --delete ${pull.headRef}`);
  }
  if (verified.result === 'error') {
    fail(
      EXIT.USAGE,
      `着地後検証を実行できませんでした。台帳 (${ctx.statusContext}) の ${landed.slice(0, 12)} には結果を書いていません。`,
      `原因を直して BDBOARD_MERGER=chair npm run merge-pr -- verify ${landed} を実行してください (LEASE を過ぎると次の merger が自己修復します)。`,
      ...(state.repair ? [kept, `success を確かめたら: bd merge-slot release --holder ${shellQuote(state.holder)}`] : []),
    );
  }
  if (verified.result === 'failure' && state.class === 'L') {
    // bdboard-ulxa.7: クラス L の failure は記録 (newMain と class: 'L') を残す。lightSlipSteps の「フレークなら
    // merge-pr verify <sha> でやり直し、数えない」を実行した再検証が L を見分けて light-landed の success を最後の
    // 行に書けるように (消すと failure by=finish が最後の行として残り、すり抜けに数えられる)。
    // landedResult: 'failure' の印で finish / gate / prepare のやり直しは止まる (入口)。消えるのはその再検証が
    // success のとき (verifyLanded の forgetLightFailure) だけ。再検証も failure の確定したすり抜けの記録は残るが、
    // すり抜けは 1 件ごとに S2 に戻るので、残る数はすり抜けの件数で抑えられる。
    writeState(ctx.cwd, pr, { ...readState(ctx.cwd, pr), landedResult: 'failure' });
  } else {
    removeState(ctx.cwd, pr);
  }
  if (verified.result === 'failure') {
    if (state.repair) {
      say(`修復後も failure です。${kept}`);
      fail(EXIT.LANDED_FAILED, ...brokenMainSteps(landed, ctx.repo, ctx.statusContext));
    }
    fail(EXIT.LANDED_FAILED, ...failedLanding(ctx, pr, state.id, landed));
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
  const verified = await runLandedVerify(ctx, full, by, { retryHint: `BDBOARD_MERGER=chair npm run merge-pr -- verify ${full}` });
  audit('landed-verify', { new: full, result: verified.result, by: 'manual', retried: verified.retried ? 1 : undefined, etimedout: verified.etimedout || undefined });
  // finish が error / failure で終わったクラス L の着地、finish が走らなかった L の着地なら、その記録 (状態ファイル) から L を見分ける。
  const light = lightLandedState(ctx.cwd, full);
  const recorded = reportLightLanded(light, full, verified.result, 'manual', verified.retried) === true;
  if (verified.result === 'error') {
    fail(EXIT.USAGE, '着地後検証を実行できませんでした (上のメッセージ参照)。');
  }
  if (verified.result === 'failure') {
    fail(EXIT.LANDED_FAILED, ...brokenMainSteps(full, ctx.repo, ctx.statusContext));
  }
  forgetLightFailure(ctx.cwd, light, full, { recorded }); // success 行を記録できたフレーク L の記録だけ消す
  say(`着地後検証 success: ${full.slice(0, 12)}`);
  // この SHA の main-broken 枠 (finish が failure のときに取ったもの・gate --repair が引き継いだもの・手で取ったもの) は、
  // この再検証では返らない。コマンドを案内するだけで返さない (修復 PR が gate --repair でその枠を引き継いでいると、返すと
  // 修復の finish が枠を失う)。bdboard-89jv: 枠を読めないときは黙らず、手で確かめる 1 行を出す。
  const slot = mainBrokenSlot(ctx.cwd, full);
  if (!slot.ok) {
    say(...mainBrokenSlotUnknownSteps(full, slot.error));
  } else if (slot.holder !== null) {
    say(...mainBrokenSlotHeldSteps(full, slot.holder));
  }
  return EXIT.OK;
}
