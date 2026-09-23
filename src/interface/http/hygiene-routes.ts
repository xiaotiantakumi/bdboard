import { Hono } from 'hono';
import { PrBadgeCommentCache } from '../../application/board/get-pr-badges.js';
import { createHygieneStatusRoutes } from './hygiene-status-routes.js';
import { createLeaseHealthRoutes } from './lease-health-routes.js';
import { createPrLinksRoutes } from './pr-links-routes.js';
import { createMergeSlotStatusRoutes } from './merge-slot-status-routes.js';
import { createDependencyGraphRoutes } from './dependency-graph-routes.js';
import type { InFlightOverlapMemo } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

// bdboard-sso1.61: hygiene-routes.ts (旧284行、5ルートが同居) を関心別のルート
// 登録モジュール (hygiene-status-routes.ts / lease-health-routes.ts /
// pr-links-routes.ts / merge-slot-status-routes.ts / dependency-graph-routes.ts)
// へ分割した (move only, 挙動変更ゼロ)。このファイルは合成層として残り、公開 API
// (createHygieneRoutes) は分割前と同一。GET /api/hygiene と GET /api/pr-links が
// 共有する PR コメント走査キャッシュ (prBadgeCommentCache, bdboard-pkr6.16) は
// ここで1個だけ作り、両方のグループへ明示引数で渡す (harness-routes.ts 分割
// bdboard-sso1.56 と同じ方針)。ルート登録順は元のファイルでの並び
// (hygiene → lease-health → pr-links → merge-slot-status → graph) をそのまま維持。

export function createHygieneRoutes(deps: ApiDeps, memo: InFlightOverlapMemo): Hono {
  const app = new Hono();
  const prBadgeCommentCache = new PrBadgeCommentCache();

  app.route('/', createHygieneStatusRoutes(deps, memo, { prBadgeCommentCache }));
  app.route('/', createLeaseHealthRoutes(deps));
  app.route('/', createPrLinksRoutes(deps, { prBadgeCommentCache }));
  app.route('/', createMergeSlotStatusRoutes(deps));
  app.route('/', createDependencyGraphRoutes(deps));

  return app;
}
