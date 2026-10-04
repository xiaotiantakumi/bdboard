// bdboard-ulxa.3: prepare のクラスを merge.mode ごとに決める (prepare.mjs の max-lines を空けるために
// 分けた。分類の材料と S2 / S3 の規則そのものは classify.mjs)。
//   S0 / S1: main が動いていれば R、動いていなければ N
//   S2:      classifyS2 の N / R / F
//   S3:      S2 の F を decideS3Class で F / L に分ける
// --dry-run ではどの段階でも S2 / S3 の分類を求めて参考表示する (verify はしない)。
import { gitOk } from './exec.mjs';
import { classifyS2, decideS3Class } from './classify.mjs';
import { PREDICTED_MODES } from './config.mjs';

/** @returns {{ cls: 'N'|'R'|'F'|'L', s2: object|null, s3: object|null }} */
export function classifyForMode(ctx, pull, predBase, head, { dryRun }) {
  const mode = ctx.config.mode;
  const moved = !gitOk(['merge-base', '--is-ancestor', predBase, head], { cwd: ctx.cwd });
  const wantS2 = PREDICTED_MODES.includes(mode) || dryRun;
  let s2 = !wantS2 ? null : moved ? classifyS2(ctx, predBase, head) : { class: 'N', reason: 'main 不動', overlap: [], mainFiles: [] };
  if (s2?.class === 'F' && pull.mergeable === false) {
    // GitHub が衝突と判定している (ort と GitHub の判定が食い違う)。gh pr merge が 405 で落ちるので R。
    s2 = { ...s2, class: 'R', reason: 'GitHub が PR を mergeable=false と判定しています' };
  }
  const s3 = s2 === null ? null : decideS3Class(s2, ctx.config.hotFiles, ctx.config.lightBlindFiles);
  if (mode === 'S3') {
    return { cls: s3.class, s2, s3 };
  }
  if (mode === 'S2') {
    return { cls: s2.class, s2, s3 };
  }
  return { cls: moved ? 'R' : 'N', s2, s3 };
}

/** 分類の説明 (いまの段階の分類と、ほかの段階での参考。S2 での S3 の参考は L になるときか --dry-run だけ)。 */
export function describeClass(mode, cls, s2, s3, dryRun) {
  if (s2 === null) {
    return [];
  }
  const counts = `main 側の変更 ${s2.mainFiles.length} 件・重なり ${s2.overlap.length} 件`;
  const lines = [];
  if (PREDICTED_MODES.includes(mode) && cls !== 'N') {
    lines.push(`${mode} の分類: ${(mode === 'S3' ? s3 : s2).reason} (${counts})`);
  }
  if (!PREDICTED_MODES.includes(mode)) {
    lines.push(`参考: merge.mode が S2 ならクラス=${s2.class} (${s2.reason}、${counts})`);
  }
  if (mode !== 'S3' && (dryRun || s3.class === 'L')) {
    lines.push(`参考: merge.mode が S3 ならクラス=${s3.class} (${s3.reason})`);
  }
  return lines;
}
