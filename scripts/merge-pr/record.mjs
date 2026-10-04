// bdboard-ulxa.3: gate が prepare の記録 (状態ファイル) をこの段階のまま使ってよいかの判定。
//
// 記録のクラスと「何で検証したか」のフィールドの組み合わせが、いまの merge.mode で通る形のときだけ
// gate に進ませる。合わない・欠けている・知らないクラスは、どれも prepare からやり直し (安全側)。
//   N = main 不動。どの段階でも通る (S1 / S2 / S3)
//   F = 着地予定ツリーのフル verify。S2 / S3 で、predictedTree と predictedVerifiedAt があること
//   L = 着地予定ツリーの軽量チェック。S3 だけで、lightTree / lightCommit / lightCheckedAt があり、
//       lightCommit の木と親が記録 (lightTree・PRED_BASE・PR head) と一致すること
// S3 → S2 (や S1) に巻き戻した後に残っていた L の記録は、ここで prepare に戻され、S2 の分類で
// フル verify (F) になる。巻き戻しは契約の merge.mode 1 行で済む。
// 軽量チェックの記録 (light*) はフル verify の記録 (predicted*) の代わりにならないし、その逆も無い。
import { PREDICTED_MODES } from './config.mjs';

/**
 * @param {string} mode いまの merge.mode
 * @param {object} state prepare の記録
 * @param {(sha: string) => ({ tree: string, parents: string[] } | null)} readCommit L の記録の照合用
 * @returns {string | null} gate に進めない理由 (null なら進めてよい)
 */
export function recordProblem(mode, state, readCommit) {
  switch (state.class) {
    case 'N':
      return null;
    case 'F':
      if (!PREDICTED_MODES.includes(mode)) {
        return `クラス F (rebase なし) の記録ですが merge.mode は ${mode} です。`;
      }
      return state.predictedTree && state.predictedVerifiedAt ? null : 'クラス F (rebase なし) の記録に着地予定ツリーの verify の結果がありません。';
    case 'L':
      if (mode !== 'S3') {
        return `クラス L (軽量チェック) の記録ですが merge.mode は ${mode} です (S3 から巻き戻された)。`;
      }
      return lightProblem(state, readCommit);
    default:
      return `知らないクラス ${JSON.stringify(state.class)} の記録です。`;
  }
}

function lightProblem(state, readCommit) {
  if (!state.lightTree || !state.lightCommit || !state.lightCheckedAt) {
    return 'クラス L (軽量チェック) の記録に軽量チェックの結果がありません。';
  }
  const commit = readCommit(state.lightCommit);
  const parents = commit?.parents ?? [];
  if (commit === null || commit.tree !== state.lightTree || parents.length !== 2 || parents[0] !== state.predBase || parents[1] !== state.head) {
    return `クラス L (軽量チェック) の記録が食い違っています (着地予定コミット ${String(state.lightCommit).slice(0, 12)} の木か親が記録と違う、または読めない)。`;
  }
  return null;
}
