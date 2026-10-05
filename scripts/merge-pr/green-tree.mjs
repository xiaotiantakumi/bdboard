// bdboard-xw00: 着地した木が、すでに verify success した木と同一かを決める (構造の証拠)。
//
// 同一ツリーが 1 回 green なら、その木の決定的な失敗はありえない。着地後検証の 1 回の failure が言えるのは
// 「非決定的 (環境かフレーク)」だけで、それは 1 回の実行では判定できない。そこで finish の着地後検証が落ちたとき、
// 着地した木が green 済みの木と同一なら、失敗の形 (load-retry.mjs の分類器) を見ずに 1 回だけ再実行する。
// 形の分類器は環境の失敗の形 (負荷・スリープ・ネットワーク・ディスク …) を 1 つ教えるたびに次の形で同じ事故を
// 起こしていた (bdboard-xdk8 → e8jj → 7qhq → 2bif)。
//
// 証拠は 2 つ (先に当たった方。(a) 優先):
//   (a) predicted — クラス F の着地予定ツリー (prepare がローカルで verify success した木。predictedVerifiedAt がある)
//   (b) ci-head   — PR head の木 (gate 済みの記録の head は、prepare が必須チェック pass を確かめた head。gate が
//                   head 不変を再確認している)。クラス N の着地木はこれと同じ。
// クラス L の lightTree は証拠にしない (軽量チェックはテストを走らせていない)。L の着地木は merge-tree の木で
// head の木と通常は違うので (b) には当たらない (main の移動が head に何も足さない場合 — コミットとその revert — は当たる)。
// 証拠を引けるのは finish だけ (gate 済みの状態ファイルがある)。手動の merge-pr verify と gate の自己修復は
// 対象外で、従来の分類器 (凍結) だけで判定する (docs/GIT-WORKFLOW.md「One retry for a landed failure」)。
import { run } from './exec.mjs';

/** rev の木の sha。読めなければ '' (オフラインで着地コミットが無い等)。 */
export function treeOf(ctx, rev) {
  if (!rev) {
    return '';
  }
  const tree = run('git', ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { cwd: ctx.cwd });
  return tree.status === 0 ? tree.stdout.trim() : '';
}

/**
 * 着地した木が green 済みの木と同一なら { how, tree }、そうでなければ (読めない場合も) null。
 * landedTree は呼び出し元が読み済みなら渡す (finish は comparePredicted と同じ値を使う)。
 * @returns {{ how: 'predicted'|'ci-head', tree: string } | null}
 */
export function greenIdenticalTree(ctx, state, landed, landedTree = treeOf(ctx, landed)) {
  if (!landedTree) {
    return null;
  }
  if (state.class === 'F' && state.predictedVerifiedAt && state.predictedTree === landedTree) {
    return { how: 'predicted', tree: landedTree };
  }
  if (treeOf(ctx, state.head) === landedTree) {
    return { how: 'ci-head', tree: landedTree };
  }
  return null;
}
