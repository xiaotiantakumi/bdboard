import { describe, expect, it } from 'vitest';
import { createHarnessRoutes, type HarnessRoutesDeps } from './harness-routes.js';

/**
 * bdboard-sso1.56: harness-routes.ts (347行, ミドルウェア1件+ルート5件が同居) を
 * 関心別のルートモジュールへ分割する際の "move only" (挙動変更ゼロ) を保証するための
 * ロックダウンテスト。
 *
 * この配列は、分割着手前の src/interface/http/harness-routes.ts
 * (git show <分割直前 HEAD>:src/interface/http/harness-routes.ts) に対して実際に
 * `createHarnessRoutes(...).routes` を呼び出し、返ってきた { method, path } の列を
 * そのまま書き写したもの (分割後のファイル群から再生成していない)。
 *
 * route-order.test.ts (bdboard-sso1.1) / agent-run-route-order.test.ts
 * (bdboard-sso1.27) と同じ方針: write-guard は app.use('*', ...) で登録される
 * ミドルウェアで、app.routes 上は method: 'ALL', path: '/*' として先頭に現れる
 * ため、明示的な method ルートの順序と、ALL ミドルウェアの位置・個数を分けて固定する。
 */
const EXPECTED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/harness/packs' },
  { method: 'GET', path: '/api/harness/status' },
  { method: 'GET', path: '/api/projects/*/harness' },
  { method: 'POST', path: '/api/projects/*/harness/inject' },
  { method: 'POST', path: '/api/projects/*/harness/contract-ticket' },
];

function buildMinimalDeps(): HarnessRoutesDeps {
  // ハンドラは呼ばない (ルート登録の introspection のみ) ので、型を満たす
  // 最低限のスタブで十分。
  return {
    cache: {
      listProjects: () => [],
      getProject: () => undefined,
    } as unknown as HarnessRoutesDeps['cache'],
    registry: {} as unknown as HarnessRoutesDeps['registry'],
    injector: {} as unknown as HarnessRoutesDeps['injector'],
    contractReader: {} as unknown as HarnessRoutesDeps['contractReader'],
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
}

describe('harness route order lock-down (bdboard-sso1.56)', () => {
  it('registers exactly the same routes, in the same order, as the pre-split harness-routes.ts', () => {
    const app = createHarnessRoutes(buildMinimalDeps());

    const actual = app.routes
      .filter((route) => route.method !== 'ALL')
      .map((route) => ({ method: route.method, path: route.path }));

    expect(actual).toEqual(EXPECTED_ROUTES);
  });

  it('keeps exactly one write-guard middleware registered before every route (app.use("*", ...))', () => {
    const app = createHarnessRoutes(buildMinimalDeps());

    const allMiddlewareRoutes = app.routes.filter((route) => route.method === 'ALL');
    expect(allMiddlewareRoutes).toHaveLength(1);
    expect(allMiddlewareRoutes[0]).toMatchObject({
      basePath: '/',
      path: '/*',
      method: 'ALL',
    });

    const allMiddlewareIndex = app.routes.findIndex(
      (route) => route.method === 'ALL' && route.path === '/*',
    );
    expect(allMiddlewareIndex).toBe(0);
  });
});
