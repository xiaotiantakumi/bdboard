import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes, type ApiDeps } from './routes.js';

/**
 * bdboard-sso1.1: routes.ts (1973行・39ルートが同居) をリソース別のルート
 * モジュールへ分割した際の "move only" (挙動変更ゼロ) を保証するための
 * ロックダウンテスト。
 *
 * 期待値の配列は分割前の src/interface/http/routes.ts
 * (git show dfbc3b93acf627e701119b165786cb2055e86d10:src/interface/http/routes.ts、
 * 分割直前の HEAD) から
 * `app.get(` / `app.post(` / `app.patch(` / `app.delete(` の出現順を
 * そのまま書き写したもの (自己参照にしない: 分割後のファイル群から
 * 再生成していない)。Hono はルートを登録順で解決するため、この順序が
 * 変わると GET /api/tickets/:id{.+} のような catch-all が具体ルートより
 * 先に呼ばれてしまう (bdboard-qw26 / PR #514 の事故と同種)。
 */
const EXPECTED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/status' },
  { method: 'GET', path: '/api/projects' },
  { method: 'GET', path: '/api/board' },
  { method: 'GET', path: '/api/search' },
  { method: 'GET', path: '/api/activity' },
  { method: 'GET', path: '/api/stats' },
  { method: 'GET', path: '/api/model-stats' },
  { method: 'GET', path: '/api/harness-kpi' },
  { method: 'GET', path: '/api/cfd' },
  { method: 'GET', path: '/api/hygiene' },
  { method: 'GET', path: '/api/lease-health' },
  { method: 'GET', path: '/api/pr-links' },
  { method: 'GET', path: '/api/merge-slot-status' },
  { method: 'GET', path: '/api/graph' },
  { method: 'GET', path: '/api/tickets/pending-decisions' },
  { method: 'GET', path: '/api/tickets/:id/timeline' },
  { method: 'GET', path: '/api/tickets/:id/similar' },
  { method: 'GET', path: '/api/tickets/:id/in-flight-overlaps' },
  { method: 'GET', path: '/api/tickets/:id{.+}' },
  { method: 'POST', path: '/api/tickets/:id/decision' },
  { method: 'POST', path: '/api/tickets/:id/quick-action' },
  { method: 'POST', path: '/api/tickets/:id/quick-action/undo' },
  { method: 'POST', path: '/api/tickets/:id/dependencies' },
  { method: 'DELETE', path: '/api/tickets/:id/dependencies/:dependsOnId{.+}' },
  { method: 'PATCH', path: '/api/tickets/:id/title' },
  { method: 'PATCH', path: '/api/tickets/:id/description' },
  { method: 'POST', path: '/api/tickets/:id/labels' },
  { method: 'DELETE', path: '/api/tickets/:id/labels/:label{.+}' },
  { method: 'POST', path: '/api/tickets/:id/session-link' },
  { method: 'DELETE', path: '/api/tickets/:id/session-link' },
  { method: 'POST', path: '/api/tickets/:id/comment' },
  { method: 'GET', path: '/api/comments/:id{.+}' },
  { method: 'GET', path: '/api/sessions/history' },
  { method: 'GET', path: '/api/sessions/:id/tail' },
  { method: 'GET', path: '/api/sessions' },
  { method: 'GET', path: '/api/processes' },
  { method: 'POST', path: '/api/refresh' },
  { method: 'GET', path: '/api/events' },
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

describe('route order lock-down (bdboard-sso1.1)', () => {
  it('registers exactly the same routes, in the same order, as the pre-split routes.ts', () => {
    const app = createApiRoutes(buildMinimalDeps());

    // write-guard は app.use('*', ...) で登録されるミドルウェアで、
    // app.routes 上は method: 'ALL', path: '/*' として先頭に現れる
    // (下のテストで別途確認する)。ここでは明示的な method ルートの
    // method+path 順序だけを見る。
    const actual = app.routes
      .filter((route) => route.method !== 'ALL')
      .map((route) => ({ method: route.method, path: route.path }));

    expect(actual).toEqual(EXPECTED_ROUTES);
  });

  it('keeps exactly one write-guard middleware registered before every route (app.use("*", ...))', () => {
    const app = createApiRoutes(buildMinimalDeps());

    // ALL "*" は write-guard の app.use('*', ...) だけが登録するはず。件数までは 0 なら
    // どの位置に何個あっても index が 0 なので、個数も別途固定して増殖を検知する。
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
