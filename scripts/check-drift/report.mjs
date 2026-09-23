// bdboard-sso1.53: check-drift.mjs から move-only 分割。open PR 比較結果の出力整形と統括 (「reportOpenPullRequestOverlap」節の後半+本体)。
import { listOpenPullRequests } from './gh.mjs';
import { classifyPullRequests, computeUpstreamCurrency, fetchPeerBranches } from './candidates.mjs';
import { comparePullRequests } from './compare.mjs';

export function printOverlapReport({
  comparedCount,
  conflicts,
  conflictsOutsideBranchFiles,
  sharedFileOverlaps,
  skippedMissingRef,
  skippedComparison,
  unavailableMergeTree,
  skippedAutomatic,
  skippedCrossRepository,
  fetchDegraded,
}) {
  const hasFindings =
    conflicts.length > 0 ||
    conflictsOutsideBranchFiles.length > 0 ||
    sharedFileOverlaps.length > 0;
  // bdboard-b0yd R2-4: fetch が劣化したまま比較した結論は、古い ref に基づく
  // ものだと結論行自体に残す。個別行を全部辿らないと分からない扱いにしない。
  const degradedSuffix = fetchDegraded ? ' (古い ref で比較)' : '';
  if (comparedCount === 0) {
    // all-clear と行の形を変え、stdout の行一致しか見ない呼び出し側にも未比較を伝える。
    // bdboard-b0yd R4-D: fetch が劣化し、かつ全 peer が missing-ref 等に落ちて
    // 比較できた peer が0件になる場合もある。ここだけ degradedSuffix が
    // 付いていなかったので付ける。
    console.log(`drift: 比較できた open PR がありません。${degradedSuffix}`);
  } else if (!hasFindings) {
    console.log(`drift: open PR ${comparedCount} 件との重なりはありません。${degradedSuffix}`);
  } else {
    for (const { pr, files, weCurrent, peerCurrent } of conflicts) {
      // bdboard-b0yd R4-A: W (weCurrent) を最優先で見る。自分が stale なら
      // peer の新旧に関わらず「自分の drift が混ざっている可能性」を消せない
      // ため、peer を犯人扱いする文言には倒さない。
      if (!weCurrent) {
        console.log(
          `drift: open PR #${pr.number} (${pr.headRefName}) と衝突する可能性があります (このブランチが origin/main に対して古いため、main との drift が混ざっている可能性があります。まず rebase してから再実行してください):`,
        );
      } else if (peerCurrent) {
        console.log(`drift: open PR #${pr.number} (${pr.headRefName}) と衝突します (rebase でテキスト衝突):`);
      } else {
        console.log(
          `drift: open PR #${pr.number} (${pr.headRefName}) と衝突する可能性があります (peer が origin/main に対して古いため、peer 側の rebase で解消するかもしれません):`,
        );
      }
      for (const file of files) {
        console.log(`  ${file}`);
      }
    }
    for (const { pr, conflictFiles, sharedFiles, weCurrent, peerCurrent } of conflictsOutsideBranchFiles) {
      console.log(
        `drift: open PR #${pr.number} (${pr.headRefName}) は衝突していますが、衝突パスはこのブランチが触ったファイルの外です:`,
      );
      if (conflictFiles.length === 0) {
        console.log('  (merge-tree は衝突パスを返しませんでした)');
      } else {
        for (const file of conflictFiles) {
          console.log(`  ${file}`);
        }
      }
      // bdboard-b0yd R4-B: !weCurrent を最優先で見る。自分が stale だと、
      // origin/main 側の rename を最新の peer がただ継承しただけのケースと
      // peer 自身の rename を区別できない (前者で peer を犯人扱いすると誤報)。
      if (!weCurrent) {
        console.log('drift:   このブランチが origin/main に対して古いため、この衝突の原因を peer 側と切り分けられません。まず rebase してから再実行してください。');
      } else if (!peerCurrent) {
        console.log('drift:   peer 自身が origin/main に対して古いため、この衝突は peer 側の rebase で解消する可能性が高いです。');
      } else {
        console.log('drift:   peer 側の rename によるパス名のずれによる衝突の可能性があります。実物を確認してください。');
      }
      if (sharedFiles.length > 0) {
        console.log('drift: この PR と同じファイルも触っています (意味的な整合も要確認):');
        for (const file of sharedFiles) {
          console.log(`  ${file}`);
        }
      }
    }
    for (const { pr, files, mergeTreeUnavailable } of sharedFileOverlaps) {
      // bdboard-b0yd R4-C: merge-tree が使えなかった peer について「衝突は
      // しません」と断定しない。判定できていないだけなので、その旨を伝える。
      const caveat = mergeTreeUnavailable
        ? '(テキスト衝突は判定できませんでした。意味的な整合とあわせて実物を確認してください)'
        : '(衝突はしませんが意味的な整合は要確認)';
      console.log(`drift: open PR #${pr.number} (${pr.headRefName}) と同じファイルを触っています ${caveat}:`);
      for (const file of files) {
        console.log(`  ${file}`);
      }
    }
    console.log(`drift: マージ順は議長が決めてください (これは報告であり、終了コードには影響しません)。${degradedSuffix}`);
  }
  if (skippedMissingRef.length > 0) {
    console.log(`drift: リモート追跡ブランチがないため比較を省略しました (${skippedMissingRef.map((pr) => `PR #${pr.number}`).join(', ')})。`);
  }
  if (skippedComparison.length > 0) {
    for (const { pr, reason } of skippedComparison) {
      console.log(`drift: 比較に失敗したため省略しました (PR #${pr.number}: ${reason})。`);
    }
  }
  if (unavailableMergeTree.length > 0) {
    for (const { pr, reason } of unavailableMergeTree) {
      console.log(`drift: merge-tree が使えないため PR #${pr.number} (${pr.headRefName}) はファイル単位でのみ比較しました (${reason})。`);
    }
  }
  if (skippedAutomatic.length > 0) {
    console.log(`drift: release-please の自動生成 PR は比較から除外しました (${skippedAutomatic.map((pr) => `PR #${pr.number}`).join(', ')})。`);
  }
  if (skippedCrossRepository.length > 0) {
    console.log(`drift: fork 由来の PR は比較から除外しました (${skippedCrossRepository.map((pr) => `PR #${pr.number}`).join(', ')})。`);
  }
}

/**
 * bdboard-b0yd R2-7: このブランチがまだ何も変更していないとき (worktree 作成
 * 直後など) は branchFiles が空集合であり、階層1の交差は定義上つねに空になる。
 * その結果、stale な peer が1本でもあれば毎回バケットC (「ファイルの外」) が
 * 100% 発火してノイズになる。比較そのものに材料が無いので、gh を呼ぶ前に畳む。
 */
export function reportOpenPullRequestOverlap(currentBranch, branchFiles, shouldFetch, upstream) {
  if (branchFiles.length === 0) {
    console.log('drift: このブランチはまだ何も変更していないため、open PR との比較は省略しました。');
    return;
  }

  const listed = listOpenPullRequests();
  if (listed.error) {
    console.log(listed.error);
    console.error(listed.error);
    return;
  }

  const { comparisonCandidates, skippedAutomatic, skippedCrossRepository } = classifyPullRequests(
    listed.pullRequests,
    currentBranch,
  );
  const fetchDegraded = fetchPeerBranches(shouldFetch, comparisonCandidates);
  const weAreCurrentWithUpstream = computeUpstreamCurrency(comparisonCandidates, upstream);
  const {
    conflicts,
    conflictsOutsideBranchFiles,
    sharedFileOverlaps,
    unavailableMergeTree,
    skippedMissingRef,
    skippedComparison,
    comparedCount,
  } = comparePullRequests(comparisonCandidates, branchFiles, upstream, weAreCurrentWithUpstream);

  printOverlapReport({
    comparedCount,
    conflicts,
    conflictsOutsideBranchFiles,
    sharedFileOverlaps,
    skippedMissingRef,
    skippedComparison,
    unavailableMergeTree,
    skippedAutomatic,
    skippedCrossRepository,
    fetchDegraded,
  });
}
