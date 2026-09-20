import { describe, expect, it } from 'vitest';
import { createChatRoutes, type ChatRoutesDeps } from './chat-routes.js';

/**
 * bdboard-sso1.17: chat-routes.ts (1015行, 20エントリ: ミドルウェア8件+ルート12件が
 * 同居) をリソース別のルートモジュールへ分割する際の "move only" (挙動変更ゼロ) を
 * 保証するためのロックダウンテスト。
 *
 * この配列は、分割着手前の src/interface/http/chat-routes.ts
 * (git show <分割直前 HEAD>:src/interface/http/chat-routes.ts) に対して実際に
 * `createChatRoutes(...).routes` を呼び出し、返ってきた { method, path } の列を
 * そのまま書き写したもの (分割後のファイル群から再生成していない)。
 *
 * routes.ts の route-order.test.ts (bdboard-sso1.1) と違い、ここでは ALL
 * メソッド (app.use によるミドルウェア登録) を除外しない — chatMessageBodyLimit
 * は「レート制限より先にボディサイズを弾く」ため意図的に rateLimit の手前に
 * 登録されており (chat-routes.ts のコメント参照)、ミドルウェアどうしの相対順序が
 * 変わるとその挙動が壊れるため、ルートだけでなくミドルウェアも含めた完全な登録順を
 * 固定する。
 */
const EXPECTED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'ALL', path: '/api/chat' },
  { method: 'ALL', path: '/api/chat/*' },
  { method: 'ALL', path: '/api/chat/message' },
  { method: 'ALL', path: '/api/chat/message/stream' },
  { method: 'ALL', path: '/api/chat' },
  { method: 'ALL', path: '/api/chat/*' },
  { method: 'ALL', path: '/api/chat/projects/:projectId/discovered-sessions' },
  { method: 'ALL', path: '/api/chat/projects/:projectId/discovered-sessions/*' },
  { method: 'GET', path: '/api/chat/availability' },
  { method: 'GET', path: '/api/chat/agents' },
  { method: 'GET', path: '/api/chat/sessions/:sessionId/messages' },
  { method: 'GET', path: '/api/chat/threads' },
  { method: 'GET', path: '/api/chat/turn-status' },
  { method: 'DELETE', path: '/api/chat/turn-status' },
  { method: 'PATCH', path: '/api/chat/sessions/:sessionId/thread' },
  { method: 'DELETE', path: '/api/chat/sessions/:sessionId' },
  { method: 'POST', path: '/api/chat/message' },
  { method: 'POST', path: '/api/chat/message/stream' },
  { method: 'GET', path: '/api/chat/projects/:projectId/discovered-sessions' },
  { method: 'POST', path: '/api/chat/projects/:projectId/discovered-sessions/:sessionId/adopt' },
];

function buildMinimalDeps(): ChatRoutesDeps {
  // ハンドラは呼ばない (ルート登録の introspection のみ) ので、型を満たす
  // 最低限のスタブで十分。
  return {
    cache: {} as unknown as ChatRoutesDeps['cache'],
    agents: {
      defaultAgent: () => undefined,
      list: () => [],
      get: () => undefined,
    } as unknown as ChatRoutesDeps['agents'],
    store: {} as unknown as ChatRoutesDeps['store'],
    messages: {} as unknown as ChatRoutesDeps['messages'],
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
}

describe('chat route order lock-down (bdboard-sso1.17)', () => {
  it('registers exactly the same routes and middleware, in the same order, as the pre-split chat-routes.ts', () => {
    const app = createChatRoutes(buildMinimalDeps());

    const actual = app.routes.map((route) => ({ method: route.method, path: route.path }));

    expect(actual).toEqual(EXPECTED_ROUTES);
  });

  it('registers the chat message body-size guard before the rate limiter on message paths (ordering the split must not disturb)', () => {
    const app = createChatRoutes(buildMinimalDeps());

    const messagePathRoutes = app.routes.filter(
      (route) => route.method === 'ALL' && route.path === '/api/chat/message',
    );
    // index 0 は chatGuard の '/api/chat' (前方一致で '/api/chat/message' にも
    // マッチする), index 1 が chatMessageBodyLimit 固有の '/api/chat/message' 登録。
    // どちらも rateLimit 用の '/api/chat' (2回目) より前に来ることを固定する。
    const chatMessageBodyLimitIndex = app.routes.findIndex(
      (route) => route.method === 'ALL' && route.path === '/api/chat/message',
    );
    const secondChatWildcardIndex = app.routes.findIndex(
      (route, index) =>
        route.method === 'ALL' && route.path === '/api/chat' && index > chatMessageBodyLimitIndex,
    );

    expect(messagePathRoutes.length).toBeGreaterThan(0);
    expect(chatMessageBodyLimitIndex).toBeGreaterThanOrEqual(0);
    expect(secondChatWildcardIndex).toBeGreaterThan(chatMessageBodyLimitIndex);
  });
});
