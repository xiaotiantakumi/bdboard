// bdboard-ulxa.3: クラス L (着地予定ツリーの軽量チェックだけで着地) の着地後検証の結果を監査ログ (light-landed) に
// 残し、failure なら S3 のすり抜け (S2 に戻す合図) として知らせる。
//
// PR #854 レビュー: finish だけで扱うと、finish の着地後検証が error (検証を実行できなかった) になった L は、
// その後の `merge-pr verify <sha>` や次の merger の gate の自己修復で failure が出ても、L であることが失われて
// すり抜けに数えられない。そこで 3 か所 (finish / verify / gate の自己修復) が同じ関数で報告する。
// verify と gate は PR 番号を知らないので、着地コミット (newMain) から状態ファイルを引く。finish は error のとき
// 状態ファイルを消さない (SIGINT 等の中断でも消さない) ので、newMain と class: 'L' が残っている。bdboard-ulxa.7: クラス L の failure でも消さない
// (landedResult: 'failure' の印を付けて残す。フレークの再検証 `merge-pr verify <sha>` が L の記録を見つけ、success を
// 最後の行にして数え直せる。finish.mjs)。その再検証が success なら記録を消す (forgetLightFailure)。再検証も failure の
// 確定したすり抜けの記録は残ってよい — すり抜けは 1 件ごとに S2 に戻るので、残る数はすり抜けの件数で抑えられる。
// finish が newMain を書く前に落ちた L も、着地コミットの木と親で引ける (lightLandedState)。
//
// PR #854 再レビュー: ここは S2 でも通る (verify / gate の自己修復) 報告だけの経路なので、何があっても投げない
// (警告 1 行を出して null を返す)。投げると本来の exit (6 / 4) が「想定外のエラー」(exit 1) に化ける。
import { readCommit } from './exec.mjs';
import { lightSlipSteps } from './messages.mjs';
import { audit, auditLogPath, listStates, removeState, say } from './state.mjs';

function warnLight(what, error) {
  const message = error instanceof Error ? error.message : String(error);
  say(`警告: クラス L の${what}に失敗しました (マージ手順は続けます): ${message.split('\n')[0]}`);
  return null;
}

/**
 * 着地コミット sha をクラス L で着地させた finish の記録 (状態ファイル)。無ければ (読めなくても) null。
 * 1. newMain === sha: finish が着地を確かめて書いた記録 (着地後検証が error / failure で残ったもの)。
 * 2. newMain が無い、gate 済み (gateAt あり) の L の記録 (bdboard-ulxa.7): gate → gh pr merge の後、finish が
 *    newMain を書く前に落ちた (クラッシュ・compact・予算切れ)。LEASE 後の次の merger の自己修復や手動の verify は
 *    この SHA を見つけるので、着地コミットの木が lightTree で、第一親が PRED_BASE の記録をその PR のものとみなす。
 *    prepare しただけで gate していない記録は、同じ木と親でも引かない。件名の (#N) は --subject で書き換わりうる
 *    ので使わない (着地した木が軽量チェックで承認した木であることが帰属の根拠)。
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
  const unfinished = lights.filter(
    (state) => !state.newMain && state.gateAt && typeof state.lightTree === 'string' && typeof state.predBase === 'string',
  );
  if (unfinished.length === 0) {
    return null;
  }
  const landed = readCommit(root, sha);
  if (landed === null) {
    return null;
  }
  const matches = unfinished.filter((state) => landed.tree === state.lightTree && landed.parents[0] === state.predBase);
  if (matches.length > 1) {
    // 同じ木と親の gate 済みの記録が複数 (同じ変更を 2 回マージしようとした等)。readdir の順で黙って決めない。
    matches.sort(newestGateFirst);
    say(
      `注意: ${sha.slice(0, 12)} に合うクラス L の記録が複数あります (PR ${matches.map((state) => `#${state.pr}`).join(', ')})。`,
      `gate の時刻が最も新しい PR #${matches[0].pr} のものとして扱います。`,
    );
  }
  return matches[0] ?? null;
}

/** gateAt の新しい順 (同時刻なら PR 番号の大きい順)。 */
function newestGateFirst(a, b) {
  const [left, right] = [String(a.gateAt), String(b.gateAt)];
  if (left !== right) {
    return left < right ? 1 : -1;
  }
  return Number(b.pr) - Number(a.pr);
}

/**
 * 手動の再検証 (merge-pr verify <sha>) が success になったとき、フレークと確かめられた L の failure の記録を消す
 * (bdboard-ulxa.7)。消すのは finish が failure で残した記録 (newMain === sha かつ landedResult === 'failure') だけ。
 * その印は finish の着地後検証が終わってから書かれ、印のある PR の finish は入口で止まるので、実行中の finish の記録では
 * ない (bdboard-wea0.2 で PID の確認を外した)。何があっても投げない。
 */
export function forgetLightFailure(root, state, sha, { recorded = true } = {}) {
  try {
    if (state?.class !== 'L' || state.newMain !== sha || state.landedResult !== 'failure' || !Number.isInteger(state.pr)) {
      return;
    }
    if (recorded !== true) {
      say(`警告: 監査ログ (${auditLogPath()}) に light-landed の success 行を追記できなかったので、PR #${state.pr} のクラス L の failure の記録は残しました。監査ログを直して BDBOARD_MERGER=chair npm run merge-pr -- verify ${sha} をやり直してください (記録が無いと failure の行が最後の行のまま、すり抜けに数えられます)。`);
      return;
    }
    removeState(root, state.pr);
  } catch (error) {
    warnLight('failure の記録の後始末', error);
  }
}

/**
 * state がクラス L の記録なら、着地後検証の結果を監査ログに残して案内する (L でなければ何もしない)。
 * by は誰の検証か (finish / manual / self-heal)。同じ着地コミットに複数の行が付きうる (error の後の再検証) ので、
 * 数えるときは new ごとに最後の success / failure を採る。
 * retried は runLandedVerify の返り値のまま渡す (bdboard-xdk8 / bdboard-xw00: 1 回だけ再実行したとき (理由を問わない) だけ
 * retried=1 を行末に足す。landed-verify の行と同じ規則で、しなければ項目ごと出さない)。
 */
export function reportLightLanded(state, landed, result, by, retried = false) {
  try {
    return reportOrThrow(state, landed, result, by, retried);
  } catch (error) {
    warnLight('着地後検証の報告', error);
  }
  return null;
}

function reportOrThrow(state, landed, result, by, retried) {
  if (state?.class !== 'L') {
    return null;
  }
  const recorded = audit('light-landed', { pr: state.pr, id: state.id, new: landed, result, by, retried: retried ? 1 : undefined });
  if (result === 'failure') {
    say(...lightSlipSteps(landed));
  }
  if (result === 'error') {
    say(
      `${landed.slice(0, 12)} はクラス L (軽量チェックだけで着地) ですが、着地後検証を実行できませんでした (結果なし)。`,
      `直して BDBOARD_MERGER=chair npm run merge-pr -- verify ${landed} を実行し、failure なら S3 のすり抜けとして扱います (verify は状態ファイルからクラス L を見分けて同じ案内を出します)。`,
    );
  }
  return recorded === true ? true : null;
}
