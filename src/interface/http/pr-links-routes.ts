import { Hono } from 'hono';
import {
  getPrBadges,
  PrBadgeStatusCache,
  type PrBadgeCommentCache,
} from '../../application/board/get-pr-badges.js';
import { toPrBadgeDto } from './dto.js';
import { parseProjectIds } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

// bdboard-sso1.61: hygiene-routes.ts (旧284行、5ルートが同居) の分割で
// GET /api/pr-links をここへ切り出した (move only, 挙動変更ゼロ)。PR コメント
// 走査キャッシュ (prBadgeCommentCache) は GET /api/hygiene
// (hygiene-status-routes.ts) の close 証拠チェックと共有する (bdboard-pkr6.16)
// ため、合成層 (hygiene-routes.ts) から明示引数で受け取る。PR ステータス
// キャッシュ (prBadgeStatusCache) はこのルートでしか使わないためここで
// インスタンス化する。

export interface PrLinksRoutesParams {
  readonly prBadgeCommentCache: PrBadgeCommentCache;
}

export function createPrLinksRoutes(
  deps: ApiDeps,
  { prBadgeCommentCache }: PrLinksRoutesParams,
): Hono {
  const app = new Hono();
  const prBadgeStatusCache = new PrBadgeStatusCache();

  app.get('/api/pr-links', async (c) => {
    if (deps.commentReader === undefined || deps.prStatusReader === undefined) {
      return c.json({ error: 'pr links not available' }, 501);
    }

    const projectIds = parseProjectIds(c.req.query('projects'));
    const badges = await getPrBadges(
      deps.cache,
      deps.commentReader,
      deps.prStatusReader,
      {
        ...(projectIds !== undefined ? { projectIds } : {}),
        commentCache: prBadgeCommentCache,
        statusCache: prBadgeStatusCache,
      },
    );
    return c.json(badges.map(toPrBadgeDto));
  });

  return app;
}
