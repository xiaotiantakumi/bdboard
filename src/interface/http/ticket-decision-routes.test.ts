import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import { LOCAL_ENV, withLocalHost, project, createFakeBoardCache, seedCache, createDeps } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('posts a local decision response with freeform preferred over choice', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const respond = vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false }));
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          choice: 'yes',
          freeform: '  free text answer  ',
        }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      outcome: { kind: 'ticket', closed: false },
    });
    expect(respond).toHaveBeenCalledWith(
      '/projects/a',
      'bdboard-a',
      'free text answer',
    );
  });
  it('posts a local decision response with choice only', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const respond = vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false }));
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      outcome: { kind: 'ticket', closed: false },
    });
    expect(respond).toHaveBeenCalledWith('/projects/a', 'bdboard-a', 'yes');
  });
  it('forwards ambiguousGateIds from the respond outcome to the decision response', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const respond = vi.fn<HumanDecisionsPort['respond']>(async () => ({
      kind: 'ticket',
      closed: false,
      ambiguousGateIds: ['bdboard-gate-1', 'bdboard-gate-2'],
    }));
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      outcome: {
        kind: 'ticket',
        closed: false,
        ambiguousGateIds: ['bdboard-gate-1', 'bdboard-gate-2'],
      },
    });
  });
  it('forwards clearedHumanLabelTicketIds from the respond outcome to the decision response', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const respond = vi.fn<HumanDecisionsPort['respond']>(async () => ({
      kind: 'ticket',
      closed: false,
      clearedHumanLabelTicketIds: ['bdboard-sibling-1', 'bdboard-sibling-2'],
    }));
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond,
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      outcome: {
        kind: 'ticket',
        closed: false,
        clearedHumanLabelTicketIds: ['bdboard-sibling-1', 'bdboard-sibling-2'],
      },
    });
  });
  it('returns 400 when decision body has neither choice nor freeform', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'choice or freeform is required' });
  });
  it('returns 403 for decision POST through tunnel headers', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/bdboard-a/decision',
      withLocalHost({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Ray': 'abc123',
        },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'local access only' });
  });
  it('returns 404 for decision POST when ticket is not in cache', async () => {
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ humanDecisions }));
    const response = await app.request(
      '/api/tickets/missing-ticket/decision',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'yes' }),
      }),
      LOCAL_ENV,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
  });
});
