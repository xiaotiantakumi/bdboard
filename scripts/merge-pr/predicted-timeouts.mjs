// bdboard-e8jj (PR #871 レビュー指摘 1): 着地予定ツリー (S2 の verify / S3 の軽量チェック) の失敗が全部時間切れの形のとき、
// 負荷由来として exit 75 で prepare のやり直しを案内するのは「同じ着地予定ツリーにつき 1 回」だけにする。
//
// 着地後検証の再実行 (load-retry.mjs) は 1 回で打ち切られる (決定的なハングは再実行でもう一度落ちて failure になる) ので、
// 時間切れの形だけを負荷由来とみなす判定が成り立つ。着地予定ツリーの verify は自動では再実行しない (人が prepare を
// 再実行する) ので、その上限が無いと、決定的なハング (main の変更と PR の組み合わせで毎回時間切れになる意味的衝突) が
// 毎回 exit 75 になり、rebase に格下げされないまま prepare の verify を何度も回させてしまう。
//
// 記録は pr-<n>-predicted-timeouts.json (pr-<n>-queue.json と同じ置き場。listStates の対象ではない) に { pr, tree } だけを残す。
// 見るのは着地予定ツリーの SHA だけで、PID や経過時間では判断しない: 同じツリーで 2 回続けて時間切れだけなら exit 3
// (rebase に格下げ)、別のツリー (main が動いた・PR が更新された) なら数え直す。成功したら消す。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { classifyVerifyFailure, readLogQuietly } from './load-retry.mjs';
import { stateDir } from './state.mjs';

function recordFile(root, pr) {
  return path.join(stateDir(root), `pr-${pr}-predicted-timeouts.json`);
}

function recordedTree(root, pr) {
  try {
    const { tree } = JSON.parse(readFileSync(recordFile(root, pr), 'utf8'));
    return typeof tree === 'string' ? tree : null;
  } catch {
    return null; // 無い・壊れている → 記録なし (最初の 1 回として扱う)
  }
}

/**
 * 落ちた verify のログを読んで判定する。loadInduced = 失敗が全部時間切れの形 (classifyVerifyFailure)、timeouts = その件数、
 * repeated = 同じ着地予定ツリーが前回も時間切れだけで落ちている (exit 3 に倒す側)。読むだけで、何も書かない。
 */
export function judgePredictedFailure(root, pr, tree, logPath) {
  const verdict = classifyVerifyFailure(readLogQuietly(logPath));
  return { loadInduced: verdict.loadInduced, timeouts: verdict.timeouts, repeated: verdict.loadInduced && recordedTree(root, pr) === tree };
}

/** このツリーが時間切れだけで落ちたことを残す (一時ファイル + rename)。書けなくても手順は止めない (次回も最初の 1 回になるだけ)。 */
export function rememberLoadInduced(root, pr, tree) {
  const file = recordFile(root, pr);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ pr, tree })}\n`);
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
  }
}

/** 着地予定ツリーの verify が成功した (または PR がマージされた) ので記録を消す。 */
export function forgetLoadInduced(root, pr) {
  rmSync(recordFile(root, pr), { force: true });
}
