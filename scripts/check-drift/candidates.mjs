// bdboard-sso1.53: check-drift.mjs から move-only 分割。open PR 候補の絞り込みと fetch・自分の追随判定 (「reportOpenPullRequestOverlap」節の前半)。
import { git, isAncestor } from './git.mjs';

export function classifyPullRequests(pullRequests, currentBranch) {
  const skippedAutomatic = [];
  const skippedCrossRepository = [];
  const comparisonCandidates = [];
  for (const pr of pullRequests) {
    if (pr.headRefName === currentBranch) {
      continue;
    }
    // release-please は package version/changelog を main の内容から自動生成する。
    // 作業中の機能ブランチとのマージ順を人が決める対象ではないのでノイズを避けて除外する。
    if (pr.headRefName.startsWith('release-please--')) {
      skippedAutomatic.push(pr);
      continue;
    }
    // fork の headRefName は fork 側の名前にすぎず、origin/<headRefName> はこの
    // リポジトリの同名ブランチへ解決される。fork の main を origin/main と比較して
    // 階層0の drift を peer 衝突と誤報しないよう、専用区分で除外する。
    if (pr.isCrossRepository) {
      skippedCrossRepository.push(pr);
      continue;
    }
    comparisonCandidates.push(pr);
  }

  return { comparisonCandidates, skippedAutomatic, skippedCrossRepository };
}

export function fetchPeerBranches(shouldFetch, comparisonCandidates) {
  let fetchDegraded = false;
  if (shouldFetch && comparisonCandidates.length > 0) {
    // bdboard-b0yd R2-4: 以前はここで対象ブランチだけを列挙した
    // `git fetch origin <b1> <b2> …` を叩いていたが、gh がリストしたブランチが
    // 1本でも削除済みだと fetch 全体が exit 128 で失敗し、**残りの peer も
    // 1本も更新されない**。この repo の手順は `gh pr merge --squash
    // --delete-branch` で drift はマージ直前に走るため、`gh pr list` と
    // この fetch の間 (約1秒) に並列セッションがマージ+ブランチ削除を終える
    // ことは現実に起きる。refspec を並べず既定の fetch にすれば、消えた
    // ブランチがあっても残りは正常に更新される。
    try {
      // bdboard-b0yd R4-F4: --prune を足す。gh pr list と fetch の間に peer
      // ブランチが削除された場合、--prune がないと消えた peer の古い
      // origin/<peer> がローカルに残り続け、次回以降も「生きている」ものとして
      // 比較され続ける (実体は既に消えている)。timeout は足さない (議長裁定:
      // 遅い回線での大きな fetch を壊しうるため)。
      git(['fetch', 'origin', '--prune', '--quiet']);
    } catch (error) {
      fetchDegraded = true;
      const reason = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
      const message = `drift: open PR のブランチを fetch できませんでした。手元のリモート追跡 ref で続けます (${reason})`;
      console.log(message);
      console.error(message);
    }
  }

  return fetchDegraded;
}

export function computeUpstreamCurrency(comparisonCandidates, upstream) {
  // bdboard-b0yd R2-2/R2-3: 自分自身が origin/main を取り込み済みかどうかは
  // peer によらず不変なので、ループの外で一度だけ判定する。判定できなければ
  // (通常起こらないが) 安全側 (= 明示的な base への切り替えをしない) に倒す。
  let weAreCurrentWithUpstream = false;
  if (comparisonCandidates.length > 0) {
    try {
      weAreCurrentWithUpstream = isAncestor(upstream, 'HEAD');
    } catch {
      weAreCurrentWithUpstream = false;
    }
  }

  return weAreCurrentWithUpstream;
}
