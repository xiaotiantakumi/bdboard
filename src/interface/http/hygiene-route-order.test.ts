import { describe, expect, it, vi } from 'vitest';
import { createHygieneRoutes } from './hygiene-routes.js';
import { createInFlightOverlapMemo } from './api-route-shared.js';
import type { ApiDeps } from './routes.js';

/**
 * bdboard-sso1.61: hygiene-routes.ts (284行, 5ルートが同居) を関心別のルート
 * モジュールへ分割する際の "move only" (挙動変更ゼロ) を保証するための
 * ロックダウンテスト。
 *
 * この配列は、分割着手前の src/interface/http/hygiene-routes.ts
 * (git show <分割直前 HEAD>:src/interface/http/hygiene-routes.ts) に対して実際に
 * `createHygieneRoutes(...).routes` を呼び出し、返ってきた { method, path } の列を
 * そのまま書き写したもの (分割後のファイル群から再生成していない)。
 *
 * harness-route-order.test.ts (bdboard-sso1.56) / route-order.test.ts
 * (bdboard-sso1.1) と同じ方針。hygiene-routes.ts に write-guard 等の
 * ミドルウェアは無い (5ルートとも GET のみ) ため、明示的な method ルートの
 * 順序だけを固定する。
 */
const EXPECTED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/hygiene' },
  { method: 'GET', path: '/api/lease-health' },
  { method: 'GET', path: '/api/pr-links' },
  { method: 'GET', path: '/api/merge-slot-status' },
  { method: 'GET', path: '/api/graph' },
];

function buildMinimalDeps(): ApiDeps {
  // ハンドラは呼ばない (ルート登録の introspection のみ) ので、型を満たす
  // 最低限のスタブで十分。
  return {
    cache: {
      listProjects: () => [],
      getProject: () => undefined,
    } as unknown as ApiDeps['cache'],
    applicationVersion: { getVersion: () => 'test' } as ApiDeps['applicationVersion'],
    now: () => new Date('2026-01-01T00:00:00Z'),
    getStatus: () => ({ lastRefreshAt: null, errors: [], projectCount: 0 }),
    refresh: vi.fn(async () => {}),
    events: {
      subscribe: () => () => {},
      notificationsSince: () => [],
    } as unknown as ApiDeps['events'],
  };
}

describe('hygiene route order lock-down (bdboard-sso1.61)', () => {
  it('registers exactly the same routes, in the same order, as the pre-split hygiene-routes.ts', () => {
    const app = createHygieneRoutes(buildMinimalDeps(), createInFlightOverlapMemo());

    const actual = app.routes.map((route) => ({ method: route.method, path: route.path }));

    expect(actual).toEqual(EXPECTED_ROUTES);
  });
});
