import { describe, expect, it } from 'vitest';
import { createTicketWriteRoutes } from './ticket-write-routes.js';
import type { ApiDeps } from './routes.js';

/**
 * bdboard-sso1.25: ticket-write-routes.ts (511行, チケット書き込み系12ルートが
 * 同居) をリソース別のルートモジュールへ分割する際の "move only" (挙動変更ゼロ) を
 * 保証するためのロックダウンテスト。
 *
 * この配列は、分割着手前の src/interface/http/ticket-write-routes.ts
 * (git show <分割直前 HEAD>:src/interface/http/ticket-write-routes.ts) に対して
 * 実際に `createTicketWriteRoutes(...).routes` を呼び出し、返ってきた
 * { method, path } の列をそのまま書き写したもの (分割後のファイル群から
 * 再生成していない)。routes.ts の route-order.test.ts (bdboard-sso1.1) や
 * chat-route-order.test.ts (bdboard-sso1.17) と同じ方針。
 *
 * このファイル自体は createTicketWriteRoutes 単体の app.use('*', ...) は無い
 * (write-guard ミドルウェアは routes.ts 側で全グループの外側に一度だけ適用される)
 * ため、ここでは 12 件の method+path 順序だけを固定すれば足りる。
 */
const EXPECTED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
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
];

function buildMinimalDeps(): ApiDeps {
  // ハンドラは呼ばない (ルート登録の introspection のみ) ので、型を満たす
  // 最低限のスタブで十分。
  return {
    cache: {
      listProjects: () => [],
      getProject: () => undefined,
    } as unknown as ApiDeps['cache'],
    applicationVersion: { getVersion: () => 'test' },
    now: () => new Date('2026-01-01T00:00:00Z'),
    getStatus: () => ({ lastRefreshAt: null, errors: [], projectCount: 0 }),
    refresh: async () => {},
    events: {
      subscribe: () => () => {},
      notificationsSince: () => [],
    } as unknown as ApiDeps['events'],
  };
}

describe('ticket write route order lock-down (bdboard-sso1.25)', () => {
  it('registers exactly the same routes, in the same order, as the pre-split ticket-write-routes.ts', () => {
    const app = createTicketWriteRoutes(buildMinimalDeps());

    const actual = app.routes.map((route) => ({ method: route.method, path: route.path }));

    expect(actual).toEqual(EXPECTED_ROUTES);
  });

  it('registers no ALL-method middleware of its own (write-guard is applied once, in routes.ts)', () => {
    const app = createTicketWriteRoutes(buildMinimalDeps());

    const allMiddlewareRoutes = app.routes.filter((route) => route.method === 'ALL');
    expect(allMiddlewareRoutes).toHaveLength(0);
  });
});
