// bdboard-sso1.53: check-drift.mjs から move-only 分割。open PR ごとの merge-tree / ファイル差分比較ループ (「reportOpenPullRequestOverlap」節の中盤)。
import { changedFiles, git, isAncestor, mergeTree } from './git.mjs';
import { computeDrift } from './compute.mjs';

export function comparePullRequests(comparisonCandidates, branchFiles, upstream, weAreCurrentWithUpstream) {
  const skippedMissingRef = [];
  const skippedComparison = [];
  const conflicts = [];
  const conflictsOutsideBranchFiles = [];
  const sharedFileOverlaps = [];
  const unavailableMergeTree = [];
  let comparedCount = 0;

  for (const pr of comparisonCandidates) {
    const ref = `origin/${pr.headRefName}`;
    try {
      git(['rev-parse', '--verify', '--quiet', ref]);
    } catch {
      skippedMissingRef.push(pr);
      continue;
    }

    try {
      // bdboard-b0yd R2-2/R2-3: merge-tree の既定の3-way baseは
      // merge-base(HEAD, peer) であり、peer が origin/main に対して古いと
      // 「peer 対 main」の衝突が「peer 対 自分」の衝突に化ける。peer が
      // origin/main を既に取り込んでいて (= is-ancestor)、かつ自分も
      // 取り込み済みなら、base を明示的に origin/main に固定してよい —
      // このとき初めて「衝突します」という断定が安全になる。
      //
      // bdboard-b0yd R4-A/B: 象限は4つある (自分/peer それぞれ current か
      // stale か)。`weAreCurrentWithUpstream` (以下 W) が false ⟺
      // `aheadCount > 0` ⟺ origin/main が HEAD の祖先でない ⟺ drift が
      // 本来報告したい「自分が rebase していない」状況そのもの。W が false
      // なら peer が current だろうと stale だろうと、衝突の原因を peer 側に
      // 決め打ちしてはいけない — 自分の drift が混ざっている可能性を
      // 消せないため。よって出し分けは W を最優先で見る:
      //   W && P (peerIsCurrentWithUpstream) → 断定 (現行の文言のまま)
      //   !W     → 自分が stale。P の値に関わらずこちらを優先し、
      //            「rebase してから再実行してください」に倒す
      //   W && !P → 現行の「peer が古いため」の文言を維持
      const peerIsCurrentWithUpstream = isAncestor(upstream, ref);
      const canUseUpstreamBase = weAreCurrentWithUpstream && peerIsCurrentWithUpstream;
      const mergeResult = mergeTree(ref, canUseUpstreamBase ? { mergeBase: upstream } : undefined);
      const mergeTreeUnavailable = mergeResult.status === 'unavailable';

      if (mergeTreeUnavailable) {
        // bdboard-b0yd R2-5: 古い git 等で merge-tree 自体が使えないケース。
        // 以前は完全に無言でファイル単位の比較へフォールバックしていた。
        unavailableMergeTree.push({ pr, reason: mergeResult.reason });
      }

      if (mergeResult.status === 'conflict') {
        const files = computeDrift(mergeResult.files, branchFiles).overlap;
        if (files.length > 0) {
          conflicts.push({
            pr,
            files,
            weCurrent: weAreCurrentWithUpstream,
            peerCurrent: peerIsCurrentWithUpstream,
          });
          comparedCount += 1;
          continue;
        }
      }

      const peerMergeBase = git(['merge-base', upstream, ref]);
      const peerFiles = changedFiles(peerMergeBase, ref);
      const files = computeDrift(peerFiles, branchFiles).overlap;
      // bdboard-b0yd R4-C: merge-tree が使えなかった peer は「テキスト衝突を
      // 判定できた」わけではないので、comparedCount (= 衝突判定まで到達できた
      // peer の数) には数えない。数えないことで全 peer が unavailable なら
      // 自然に「比較できた open PR がありません。」に落ちる。
      if (!mergeTreeUnavailable) {
        comparedCount += 1;
      }
      if (mergeResult.status === 'conflict') {
        // peer が a.txt→b.txt に rename して編集し、こちらが旧名 a.txt を編集すると、
        // merge-tree は解決後の新名 b.txt にだけ衝突を付ける。branchFiles との交差は
        // 空でも実 git merge は衝突するため、「衝突しません」とは断定できない。
        //
        // bdboard-b0yd R4-B: is-ancestor で原因が一意に決まるのは自分が
        // origin/main に対して current (W) のときだけ。自分が stale なまま
        // だと、この衝突が「peer 側の rename」なのか「origin/main 側の
        // rename を最新の peer がただ継承しただけ」なのかを peer 側の情報
        // だけでは切り分けられない (後者は無実の peer を rename 犯人扱いする
        // 誤報になる — レビューが実測済み)。よって:
        //   !W      → 自分が stale。原因を切り分けられない旨を出す
        //   W && !P → peer 自身が origin/main に対して stale
        //   W && P  → peer は最新なのに衝突が自分のファイル外 → rename しかありえない
        conflictsOutsideBranchFiles.push({
          pr,
          conflictFiles: mergeResult.files,
          sharedFiles: files,
          weCurrent: weAreCurrentWithUpstream,
          peerCurrent: peerIsCurrentWithUpstream,
        });
      } else if (files.length > 0) {
        sharedFileOverlaps.push({ pr, files, mergeTreeUnavailable });
      }
    } catch (error) {
      // ref の存在確認とは分ける。unrelated histories 等を「追跡ブランチがない」と
      // 誤案内せず、比較そのものの失敗として原因を一行で残す。
      skippedComparison.push({
        pr,
        reason: String(error?.message ?? error).replace(/\s+/g, ' ').trim(),
      });
    }
  }

  return {
    conflicts,
    conflictsOutsideBranchFiles,
    sharedFileOverlaps,
    unavailableMergeTree,
    skippedMissingRef,
    skippedComparison,
    comparedCount,
  };
}
