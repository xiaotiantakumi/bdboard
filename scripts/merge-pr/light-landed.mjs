// bdboard-ulxa.3: クラス L (着地予定ツリーの軽量チェックだけで着地) の着地後検証の結果を監査ログ (light-landed) に
// 残し、failure なら S3 のすり抜け (S2 に戻す合図) として知らせる。
//
// PR #854 レビュー: finish だけで扱うと、finish の着地後検証が error (検証を実行できなかった) になった L は、
// その後の `merge-pr verify <sha>` や次の merger の gate の自己修復で failure が出ても、L であることが失われて
// すり抜けに数えられない。そこで 3 か所 (finish / verify / gate の自己修復) が同じ関数で報告する。
// verify と gate は PR 番号を知らないので、着地コミット (newMain) から状態ファイルを引く。finish は error のとき
// 状態ファイルを消さない (verify-guard.mjs の clearVerifyRecord は実行中の印を外して書き戻すだけ。SIGINT 等の
// 中断でも消さない) ので、newMain と class: 'L' が残っている。
import { lightSlipSteps } from './messages.mjs';
import { audit, listStates, say } from './state.mjs';

/** 着地コミット sha をクラス L で着地させた finish の記録 (状態ファイル)。無ければ null。 */
export function lightLandedState(root, sha) {
  return listStates(root).find((state) => state.class === 'L' && state.newMain === sha) ?? null;
}

/**
 * state がクラス L の記録なら、着地後検証の結果を監査ログに残して案内する (L でなければ何もしない)。
 * by は誰の検証か (finish / manual / self-heal)。同じ着地コミットに複数の行が付きうる (error の後の再検証) ので、
 * 数えるときは new ごとに最後の success / failure を採る。
 */
export function reportLightLanded(state, landed, result, by) {
  if (state?.class !== 'L') {
    return;
  }
  audit('light-landed', { pr: state.pr, id: state.id, new: landed, result, by });
  if (result === 'failure') {
    say(...lightSlipSteps(landed));
  }
  if (result === 'error') {
    say(
      `${landed.slice(0, 12)} はクラス L (軽量チェックだけで着地) ですが、着地後検証を実行できませんでした (結果なし)。`,
      `直して npm run merge-pr -- verify ${landed} を実行し、failure なら S3 のすり抜けとして扱います (verify は状態ファイルからクラス L を見分けて同じ案内を出します)。`,
    );
  }
}
