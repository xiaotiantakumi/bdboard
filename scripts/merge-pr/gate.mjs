// bdboard-ulxa.1: フェーズ 2 — 層3 ゲート (枠の外) → acquire → 層2 CAS → マージコマンドの印字。
//
// 枠の中に入るのは acquire → ls-remote → (エージェントが gh pr merge) → finish の release まで。
// gh pr merge はここでは打たない: 印字した 1 行をエージェントが実行する (設計 §6 裁定 4。
// 権限判定に拒否されたときにスクリプト経由で通すと「迂回」になるため)。
//
// --repair (main 破損の修復 PR 専用、設計 §3.6): PRED_BASE の台帳が failure でも止まらず、
// `<id> / main-broken <PRED_BASE 12 桁>` の枠を引き継ぐ (無ければその名前で取る)。この枠は
// gate でも finish でも、修復の着地後検証が success になるまで返さない。
import { shellQuote } from './exec.mjs';
import { EXIT, fail, fetchedMain, liveMain, refetchMain } from './context.mjs';
import { getPull } from './github.mjs';
import { waitForLanded } from './landed.mjs';
import { runLandedVerify } from './landed-verify.mjs';
import { brokenMainSteps, mergeInstructions } from './messages.mjs';
import { assertOpenPull } from './prepare.mjs';
import { acquireSlot, readSlot, releaseSlot } from './slot.mjs';
import { audit, readState, removeState, say, writeState } from './state.mjs';

const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: \S/;

export function mergeCommand(pr, head, title) {
  // 改行を含むタイトルでも印字は必ず 1 行にする。
  const subject = `${title.replace(/\s+/g, ' ').trim()} (#${pr})`;
  return `gh pr merge ${pr} --squash --delete-branch --match-head-commit ${head} --subject ${shellQuote(subject)}`;
}

function startOver(ctx, pr, ...lines) {
  removeState(ctx.cwd, pr);
  fail(EXIT.RETRY, ...lines, `prepare からやり直してください: npm run merge-pr -- prepare ${pr}`);
}

/** 層3: PRED_BASE の着地後検証が success であることを確かめる (必要なら待つ・自分で検証する)。 */
async function landedGate(ctx, pr, state) {
  const { predBase, id } = state;
  const decision = await waitForLanded(ctx, predBase, { mainMoved: () => refetchMain(ctx) !== predBase });
  if (decision.verdict === 'moved') {
    startOver(ctx, pr, `待っている間に ${ctx.mainRef} が ${predBase.slice(0, 12)} から動きました。`);
  }
  let verdict = decision.verdict;
  if (verdict === 'stale') {
    say(
      `${predBase.slice(0, 12)} の着地後検証が LEASE (${ctx.config.leaseMinutes} 分) を過ぎても記録されていません。`,
      '自分で検証して台帳に書きます (自己修復)。',
    );
    audit('gate-self-heal', { pr, id, base: predBase });
    const healed = await runLandedVerify(ctx, predBase, `${id} self-heal`);
    if (healed.result === 'error') {
      fail(EXIT.USAGE, '自己修復の検証を実行できませんでした (上のメッセージ参照)。');
    }
    verdict = healed.result;
  }
  if (verdict === 'failure') {
    audit('gate-main-broken', { pr, id, base: predBase });
    removeState(ctx.cwd, pr);
    fail(EXIT.MAIN_BROKEN, ...brokenMainSteps(predBase, ctx.repo, ctx.statusContext));
  }
}

/** 取る枠の名前。修復では既存の main-broken の枠 (誰が取ったものでも同じ PRED_BASE なら) を引き継ぐ。 */
function holderFor(ctx, pr, state, repair) {
  if (!repair) {
    return `${state.id} / PR#${pr}`;
  }
  const suffix = ` / main-broken ${state.predBase.slice(0, 12)}`;
  const current = readSlot(ctx.cwd);
  return current.ok && current.holder?.endsWith(suffix) ? current.holder : `${state.id}${suffix}`;
}

export async function gate(ctx, pr, { repair = false } = {}) {
  if (ctx.config.mode !== 'S1') {
    fail(EXIT.PRECONDITION, `merge.mode は ${ctx.config.mode} です。gate は S1 でだけ動きます (現行手順でマージしてください)。`);
  }
  const state = readState(ctx.cwd, pr);
  if (state === null) {
    fail(EXIT.PRECONDITION, `prepare の記録がありません。先に npm run merge-pr -- prepare ${pr}`);
  }
  if (state.gateAt) {
    fail(
      EXIT.PRECONDITION,
      `PR #${pr} は既に gate 済みで枠を保持しています (${state.holder})。`,
      `gh pr merge を打ったかどうかにかかわらず、次は npm run merge-pr -- finish ${pr}`,
    );
  }
  const pull = getPull(ctx, pr);
  assertOpenPull(ctx, pull, pr);
  if (pull.headSha !== state.head) {
    startOver(ctx, pr, `prepare の後に PR #${pr} の head が変わりました (${state.head.slice(0, 12)} → ${String(pull.headSha).slice(0, 12)})。`);
  }
  if (fetchedMain(ctx) !== state.predBase) {
    startOver(ctx, pr, `prepare の後に ${ctx.mainRef} が動きました (CAS は必ず負けます)。`);
  }
  if (repair) {
    say(`--repair: ${state.predBase.slice(0, 12)} の台帳を見ずに進みます (main 破損の修復 PR 専用)。`);
    audit('gate-repair', { pr, id: state.id, base: state.predBase });
  } else {
    await landedGate(ctx, pr, state);
  }

  const holder = holderFor(ctx, pr, state, repair);
  const got = await acquireSlot(ctx.cwd, holder, {
    waitMinutes: ctx.config.slotWaitMinutes,
    mainMoved: () => refetchMain(ctx) !== state.predBase,
  });
  if (!got.ok && got.reason === 'error') {
    fail(EXIT.USAGE, `bd merge-slot を使えません: ${got.detail}`);
  }
  if (!got.ok && got.reason === 'moved') {
    startOver(ctx, pr, `枠を待っている間に ${ctx.mainRef} が動きました。`);
  }
  if (!got.ok) {
    audit('gate-slot-timeout', { pr, id: state.id, holder: got.holder });
    fail(
      EXIT.RETRY,
      `${ctx.config.slotWaitMinutes} 分待っても枠が空きません (holder: ${got.holder ?? '不明'})。`,
      '他人の枠は release しません。握りっぱなしに見えるなら議長に報告し、時間を置いて gate し直してください。',
    );
  }
  const acquiredAt = Date.now();
  const live = liveMain(ctx);
  if (live !== state.predBase) {
    const kept = repair ? `main は壊れたままなので枠 (${holder}) は保持しています。` : '枠は返しました。';
    if (!repair) {
      releaseSlot(ctx.cwd, holder);
    }
    audit('gate-cas-lost', { pr, id: state.id, base: state.predBase, live: live ?? 'unknown' });
    startOver(
      ctx,
      pr,
      live === null
        ? `git ls-remote で remote の ${ctx.config.mainBranch} を読めませんでした (ネットワーク?)。${kept}`
        : `CAS 負け: remote の ${ctx.config.mainBranch} は ${live.slice(0, 12)} (期待 ${state.predBase.slice(0, 12)})。${kept}`,
    );
  }
  writeState(ctx.cwd, pr, { ...state, holder, repair, gateAt: new Date(acquiredAt).toISOString() });
  audit('gate-acquired', { pr, id: state.id, holder, base: state.predBase, live });
  if (!CONVENTIONAL.test(pull.title)) {
    say(`注意: PR タイトルが conventional commits の形ではありません: ${pull.title}`);
  }
  process.stdout.write(`${mergeCommand(pr, state.head, pull.title)}\n`);
  say(...mergeInstructions(pr));
  // 枠を持ったまま終了する。返すのは finish。
  return EXIT.OK;
}
