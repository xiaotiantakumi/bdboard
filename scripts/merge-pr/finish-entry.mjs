// finish の入口: worktree lock を取ることと、最初の finish で枠を返すこと (finish.mjs から分けた。bdboard-wea0.2)。
import { MergePrError } from './context.mjs';
import { releaseSlot } from './slot.mjs';
import { audit, readState, writeState } from './state.mjs';
import { holdWorktree } from './worktree-hold.mjs';

/** 通常の PR は最初に枠を返す (二度目の finish では返さない)。 */
export function releaseFirst(ctx, pr, state) {
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

/**
 * bdboard-wea0.2: 入口で worktree lock を取る (走っている finish・その孤児の verify・手動の verify が居れば 75)。lock は
 * 同じ worktree の 2 つの finish の releaseSlot も直列にするので、releaseFirst の後には動かさない。取れずに止まるとき
 * (75 / 1、main checkout からの実行も) は、最初の finish なら枠を返してから止める (#876 レビュー 1: slot.mjs に自動の
 * 返却は無いので、返さないと次の finish が通るまで枠が塞がる)。着地後検証はやり直しの finish か gate の自己修復が行う。
 */
export function holdOrReturnSlot(ctx, pr) {
  try {
    holdWorktree(ctx);
  } catch (error) {
    if (!(error instanceof MergePrError)) {
      throw error;
    }
    const before = readState(ctx.cwd, pr);
    const after = before === null ? null : releaseFirst(ctx, pr, before);
    const rerun = `lsof -t が空になったら (detach したままなら git checkout で PR のブランチに戻してから) 同じ BDBOARD_MERGER=chair npm run merge-pr -- finish ${pr} をやり直してください (prepare ではありません)。`;
    if (before?.repair) {
      error.lines.push(`修復 PR なので枠 (${before.holder}) は保持したままです。${rerun}`);
    } else if (after !== before) {
      error.lines.push(`枠は返しました (着地後検証はまだです)。${rerun}`);
    } else if (before !== null) {
      error.lines.push(`枠は前の finish で返してあります。${rerun}`);
    }
    throw error;
  }
}
