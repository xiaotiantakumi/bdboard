// bdboard-h2fk (PR #847 レビュー指摘 7): S2 prepare が起こす着地予定ツリーの verify (predicted.mjs) のプロセス
// グループを記録し、SIGKILL された prepare が残す孤児の verify を、再実行した prepare が検出する。
//
// finish は verifyPgid を状態ファイル (pr-<n>.json) に残して再実行時に見る (verify-guard.mjs) が、prepare は
// 検証の前に状態ファイルを消し、成功したときだけ書く (prepare.mjs) ので、そこには残せない。そこで専用の小さな
// ファイル (pr-<n>-predicted-verify.json。verify-queue.mjs の pr-<n>-queue.json と同じ置き場。listStates の対象
// ではないので gate / finish は読まない) に、finish と同じ項目 (verifyPgid / verifyPgidAt / verifyPgidStart) を
// 残す。runLandedVerify が戻ったら (成功・失敗・やめた・実行できない) 消すので、残るのは prepare が SIGKILL・クラッシュ
// したときだけ。SIGINT / SIGTERM の中断は interrupt.mjs がグループが空になるのを待ってから終わるので、残った記録の
// グループは空で、次の prepare に無視される。
//
// なぜ要るか: prepare が SIGKILL されると worktree は着地予定コミットで detach したままになり、孤児の verify がそこで
// 走り続ける。再実行した prepare は assertLocalHead で「HEAD が detach されたまま。git checkout <ブランチ> で戻して」
// と案内するが、その checkout は孤児の足元の木を差し替え、続く 2 本目の verify が孤児と並走する。着地予定ツリーの
// verify は台帳に書かないので main を壊す結果は載らないが、build の出力が混ざった誤った failure で rebase に
// 格下げされうる。孤児が居る間は、その案内より先に止める。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { EXIT, fail } from './context.mjs';
import { say, stateDir } from './state.mjs';
import { VERIFYING_PID_MAX_AGE_MS, groupInspectLines, groupProceedLines, leaderlessHeldLine, stampVerifyGroup } from './verify-guard.mjs';
import { judgeVerifyGroup } from './verifying-record.mjs';

function recordFile(root, pr) {
  return path.join(stateDir(root), `pr-${pr}-predicted-verify.json`);
}

/** verify を起こした直後に、そのプロセスグループを専用ファイルへ残す (runLandedVerify の onSpawn)。 */
export function recordPredictedGroup(ctx, pr, child) {
  stampVerifyGroup(child, (fields) => {
    mkdirSync(stateDir(ctx.cwd), { recursive: true });
    writeFileSync(recordFile(ctx.cwd, pr), `${JSON.stringify({ pr, ...fields }, null, 2)}\n`);
  });
}

/** verify が終わった (または記録を使い終えた) ので記録を消す。 */
export function forgetPredictedGroup(ctx, pr) {
  rmSync(recordFile(ctx.cwd, pr), { force: true });
}

function readPredictedGroup(ctx, pr) {
  try {
    return JSON.parse(readFileSync(recordFile(ctx.cwd, pr), 'utf8'));
  } catch {
    return null; // 無い・壊れている → 孤児の手がかりは無い
  }
}

/**
 * prepare の入口: 前回の prepare が残した着地予定ツリーの verify のグループがまだ動いていれば RETRY (75) で止める
 * (何も触らない)。古い記録・不明は通知して記録を消し、進む。判定は finish と同じ judgeVerifyGroup。
 *
 * readOnly (prepare --dry-run): 動いている間は同じ文面で RETRY (75) で止めるが、記録を消しも書きもせず、通知も出さない。
 * dry-run は verify を起こさないので、止めなくてよい理由はない — 止めずに進むと、孤児が生きたまま assertLocalHead が
 * 「HEAD が detach されたまま、git checkout で戻して」と案内してしまう (この関門が防ぎたい案内そのもの)。
 */
export function guardAgainstOrphanedPredictedVerify(ctx, pr, { readOnly = false } = {}) {
  const record = readPredictedGroup(ctx, pr);
  if (record === null || typeof record !== 'object') {
    return;
  }
  const verdict = judgeVerifyGroup(record, VERIFYING_PID_MAX_AGE_MS);
  if (verdict.running) {
    fail(
      EXIT.RETRY,
      `PR #${pr} の前回の prepare が起こした着地予定ツリーの verify (プロセスグループ ${record.verifyPgid}) がまだ動いています。二重に走らせません。`,
      '  前回の prepare は終わっています (SIGKILL などで中断された孤児の verify)。終わるのを待つか、畳んでから prepare をやり直してください。',
      '  この worktree は着地予定コミットで detach したままのはずです。孤児が居る間は git checkout で戻さないでください (孤児の足元の木が変わります)。畳んでから git checkout で PR のブランチに戻し、prepare をやり直します。',
      ...(verdict.identity === 'leaderless' ? [leaderlessHeldLine(record.verifyPgid, verdict.ageMs)] : []),
      ...groupInspectLines(record.verifyPgid),
    );
  }
  if (readOnly) {
    return; // 動いていない記録は、dry-run では読むだけ。消すのは本物の prepare
  }
  say(...groupProceedLines(pr, record, verdict, 'prepare を進めます'));
  forgetPredictedGroup(ctx, pr);
}
