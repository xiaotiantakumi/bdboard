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

// bdboard-se3v: /api/pr-links が (再起動直後の未キャッシュ状態で) 55秒かかっていた
// 問題への対応。gh 起動の並列度をコメント取得と切り離して上げた (get-pr-badges.ts
// 側) のに加え、ここでリクエスト全体に時間予算を持たせる —— 予算を超えたら
// その時点で分かっている分だけ返し (未解決分は status:null のまま)、残りは
// バックグラウンドで走らせ続けて次回の呼び出し (board.changed のたびに来る) で
// キャッシュヒットとして返す。受け入れ基準の「5秒以内」に余裕を持たせるため、
// レスポンス自体のシリアライズ/転送時間を差し引いた 4.5 秒を予算にする。
const PR_LINKS_OVERALL_TIMEOUT_MS = 4_500;

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
        overallTimeoutMs: PR_LINKS_OVERALL_TIMEOUT_MS,
      },
    );
    return c.json(badges.map(toPrBadgeDto));
  });

  return app;
}
