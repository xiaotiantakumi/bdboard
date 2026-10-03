import { PrBadgeCommentCache } from './pr-badge-comment-cache.js';
import { createPrBadgeGates, type PrBadgeGates } from './pr-badge-gates.js';
import { PrBadgeStatusCache } from './pr-badge-status-cache.js';

/**
 * PR 情報 (コメント由来の PR URL / gh pr view の結果) を引く経路が共有する資源 (bdboard-p5l.27)。
 *
 * /api/pr-links (画面のバッジ)・/api/hygiene (close 証拠)・/api/model-stats (統計の修正 push
 * 回数) が同じキャッシュと同時実行ゲートを使う。バラバラに持つと、同じ PR を経路ごとに
 * gh で取り直し、ゲートの同時実行上限も経路の数だけ掛け算される (bdboard-sgpa と同じ
 * 事故)。routes.ts (createApiRoutes) が1組だけ作って各ルートグループへ渡す。
 */
export interface PrBadgeShared {
  readonly commentCache: PrBadgeCommentCache;
  readonly statusCache: PrBadgeStatusCache;
  readonly gates: PrBadgeGates;
}

/**
 * statusCache は bootstrap が永続化ストア付きで組み立てたもの (ApiDeps.prBadgeStatusCache)
 * を渡す。省略 (テスト等) 時は従来どおりプロセス内だけの空キャッシュを使う。
 */
export function createPrBadgeShared(statusCache?: PrBadgeStatusCache): PrBadgeShared {
  return {
    commentCache: new PrBadgeCommentCache(),
    statusCache: statusCache ?? new PrBadgeStatusCache(),
    gates: createPrBadgeGates(),
  };
}
