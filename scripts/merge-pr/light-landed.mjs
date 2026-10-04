// bdboard-ulxa.3: クラス L (着地予定ツリーの軽量チェックだけで着地) の着地後検証の結果を監査ログ (light-landed) に
// 残し、failure なら S3 のすり抜け (S2 に戻す合図) として知らせる。
//
// PR #854 レビュー: finish だけで扱うと、finish の着地後検証が error (検証を実行できなかった) になった L は、
// その後の `merge-pr verify <sha>` や次の merger の gate の自己修復で failure が出ても、L であることが失われて
// すり抜けに数えられない。そこで 3 か所 (finish / verify / gate の自己修復) が同じ関数で報告する。
// verify と gate は PR 番号を知らないので、着地コミット (newMain) から状態ファイルを引く。finish は error のとき
// 状態ファイルを消さない (verify-guard.mjs の clearVerifyRecord は実行中の印を外して書き戻すだけ。SIGINT 等の
// 中断でも消さない) ので、newMain と class: 'L' が残っている。bdboard-ulxa.7: クラス L の failure でも消さない
// (フレークの再検証 `merge-pr verify <sha>` が L の記録を見つけ、success を最後の行にして数え直せる。finish.mjs) し、
// finish が newMain を書く前に落ちた L も、着地コミットの木と親で引ける (lightLandedState)。
//
// PR #854 再レビュー: ここは S2 でも通る (verify / gate の自己修復) 報告だけの経路なので、何があっても投げない
// (警告 1 行を出して null を返す)。投げると本来の exit (6 / 4) が「想定外のエラー」(exit 1) に化ける。
import { readCommit } from './exec.mjs';
import { lightSlipSteps } from './messages.mjs';
import { audit, listStates, say } from './state.mjs';

function warnLight(what, error) {
  const message = error instanceof Error ? error.message : String(error);
  say(`警告: クラス L の${what}に失敗しました (マージ手順は続けます): ${message.split('\n')[0]}`);
  return null;
}

/**
 * 着地コミット sha をクラス L で着地させた finish の記録 (状態ファイル)。無ければ (読めなくても) null。
 * 1. newMain === sha: finish が着地を確かめて書いた記録 (着地後検証が error / failure で残ったもの)。
 * 2. newMain が無い L の記録 (bdboard-ulxa.7): gate → gh pr merge の後、finish が newMain を書く前に落ちた
 *    (クラッシュ・compact・予算切れ)。LEASE 後の次の merger の自己修復や手動の verify はこの SHA を見つけるので、
 *    着地コミットの木が lightTree で、第一親が PRED_BASE の記録をその PR のものとみなす。件名の (#N) は --subject で
 *    書き換わりうるので使わない (着地した木が軽量チェックで承認した木であることが帰属の根拠)。
 *    状態ファイルは git common dir の下なので、別の clone の自己修復には見えない (帰属できず、普通の main 破損になる)。
 */
export function lightLandedState(root, sha) {
  try {
    const lights = listStates(root).filter((state) => state.class === 'L');
    return lights.find((state) => state.newMain === sha) ?? unfinishedLanding(root, sha, lights);
  } catch (error) {
    return warnLight('記録 (状態ファイル) の読み出し', error);
  }
}

function unfinishedLanding(root, sha, lights) {
  const unfinished = lights.filter((state) => !state.newMain && typeof state.lightTree === 'string' && typeof state.predBase === 'string');
  if (unfinished.length === 0) {
    return null;
  }
  const landed = readCommit(root, sha);
  if (landed === null) {
    return null;
  }
  return unfinished.find((state) => landed.tree === state.lightTree && landed.parents[0] === state.predBase) ?? null;
}

/**
 * state がクラス L の記録なら、着地後検証の結果を監査ログに残して案内する (L でなければ何もしない)。
 * by は誰の検証か (finish / manual / self-heal)。同じ着地コミットに複数の行が付きうる (error の後の再検証) ので、
 * 数えるときは new ごとに最後の success / failure を採る。
 * retried は runLandedVerify の返り値のまま渡す (bdboard-xdk8: 負荷由来の失敗で 1 回だけ再実行したときだけ
 * retried=1 を行末に足す。landed-verify の行と同じ規則で、しなければ項目ごと出さない)。
 */
export function reportLightLanded(state, landed, result, by, retried = false) {
  try {
    reportOrThrow(state, landed, result, by, retried);
  } catch (error) {
    warnLight('着地後検証の報告', error);
  }
  return null;
}

function reportOrThrow(state, landed, result, by, retried) {
  if (state?.class !== 'L') {
    return;
  }
  audit('light-landed', { pr: state.pr, id: state.id, new: landed, result, by, retried: retried ? 1 : undefined });
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
