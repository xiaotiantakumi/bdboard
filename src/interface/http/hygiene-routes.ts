import { Hono } from 'hono';
import { createPrBadgeShared, type PrBadgeShared } from '../../application/board/pr-badge-shared.js';
import { createLeaseHealthRoutes } from './lease-health-routes.js';
import { createPrLinksRoutes } from './pr-links-routes.js';
import { createMergeSlotStatusRoutes } from './merge-slot-status-routes.js';
import { createDependencyGraphRoutes } from './dependency-graph-routes.js';
import type { ApiDeps } from './api-deps.js';

// bdboard-sso1.61: 関心別のルート登録モジュール (lease-health-routes.ts /
// pr-links-routes.ts / merge-slot-status-routes.ts / dependency-graph-routes.ts)
// を束ねる合成層。健全性ステータス (GET /api/hygiene) と閾値は bdboard-i9g4.6 で撤去した。
// ルート登録順は lease-health → pr-links → merge-slot-status → graph。

// bdboard-p5l.27: PR 情報のキャッシュ・ゲート (prBadgeShared) は routes.ts が1組だけ作り、
// /api/model-stats (修正 push 回数) とも共有する。省略時 (このグループ単体のテスト等) は
// 従来どおりこの関数の中で作る。
export function createHygieneRoutes(
  deps: ApiDeps,
  prBadgeShared: PrBadgeShared = createPrBadgeShared(deps.prBadgeStatusCache),
): Hono {
  const app = new Hono();
  const prBadgeCommentCache = prBadgeShared.commentCache;

  app.route('/', createLeaseHealthRoutes(deps));
  app.route(
    '/',
    createPrLinksRoutes(deps, {
      prBadgeCommentCache,
      prBadgeStatusCache: prBadgeShared.statusCache,
      gates: prBadgeShared.gates,
    }),
  );
  app.route('/', createMergeSlotStatusRoutes(deps));
  app.route('/', createDependencyGraphRoutes(deps));

  return app;
}
