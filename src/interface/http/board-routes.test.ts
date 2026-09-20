import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { Hono } from 'hono';
import { makeSession, makeTicket } from '../../domain/test-support.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import { createBasicAuthMiddleware } from './basic-auth.js';
import { NOW, project, createFakeBoardCache, seedCache, createDeps, assertNoDates } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns projects sorted by rootPath', async () => {
    const cache = createFakeBoardCache();
    const z = project('/z', '/projects/z');
    const a = project('/a', '/projects/a');
    seedCache(cache, [
      { project: z, ticketId: 'bdboard-z' },
      { project: a, ticketId: 'bdboard-a' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/projects');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.map((entry: { rootPath: string }) => entry.rootPath)).toEqual([
      '/projects/a',
      '/projects/z',
    ]);
  });
  it('returns incomplete ticket counts from cached tickets', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-open', projectId: a.id, status: 'open' }),
        makeTicket({ id: 'bdboard-progress', projectId: a.id, status: 'in_progress' }),
        makeTicket({ id: 'bdboard-closed', projectId: a.id, status: 'closed' }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-done-only', projectId: b.id, status: 'closed' })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/projects');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.find((entry: { id: string }) => entry.id === a.id).incompleteTicketCount).toBe(2);
    expect(body.find((entry: { id: string }) => entry.id === b.id).incompleteTicketCount).toBe(0);
  });
  it('rejects invalid board view', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/board?view=bogus');
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid view',
      allowed: ['merged', 'split'],
    });
  });
  it('returns board JSON without Date objects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    assertNoDates(body);
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(response.headers.get('ETag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });
  it('puts a human-labeled ticket in the awaiting_human lane and out of ready', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-waiting', projectId: a.id }),
        makeTicket({ id: 'bdboard-plain', projectId: a.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [{ id: 'bdboard-waiting', kind: 'ticket', allowFreeform: true }],
    });

    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => []),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(humanDecisions.listPendingDecisions).not.toHaveBeenCalled();
    expect(
      body.merged.lanes.awaiting_human.map(
        (card: { ticket: { id: string } }) => card.ticket.id,
      ),
    ).toEqual(['bdboard-waiting']);
    expect(
      body.merged.lanes.ready.map((card: { ticket: { id: string } }) => card.ticket.id),
    ).toEqual(['bdboard-plain']);
  });
  it('leaves awaiting_human empty when no humanDecisions port is configured', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-plain' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.lanes.awaiting_human).toEqual([]);
    expect(
      body.merged.lanes.ready.map((card: { ticket: { id: string } }) => card.ticket.id),
    ).toEqual(['bdboard-plain']);
  });
  it('returns 304 with empty body when If-None-Match matches ETag', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const first = await app.request('/api/board');
    const etag = first.headers.get('ETag');
    expect(etag).not.toBeNull();

    const conditional = await app.request('/api/board', {
      headers: { 'If-None-Match': etag! },
    });

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('ETag')).toBe(etag);
    expect(conditional.headers.get('Cache-Control')).toBe('no-cache');
    expect(conditional.headers.get('Vary')).toBe('Accept-Encoding');
    expect(await conditional.text()).toBe('');
  });
  it('keeps ETag stable when generatedAt changes but board content is identical', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const nowEarlier = new Date('2026-06-01T12:00:00.000Z');
    const nowLater = new Date('2026-06-02T15:30:00.000Z');

    const appEarlier = createApiRoutes(
      createDeps({ cache, now: () => nowEarlier }),
    );
    const appLater = createApiRoutes(
      createDeps({ cache, now: () => nowLater }),
    );

    const earlier = await appEarlier.request('/api/board');
    const later = await appLater.request('/api/board');

    expect(earlier.headers.get('ETag')).toBe(later.headers.get('ETag'));
    expect((await earlier.json()).generatedAt).toBe(nowEarlier.toISOString());
    expect((await later.json()).generatedAt).toBe(nowLater.toISOString());
  });
  it('changes ETag when board content changes', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const deps = createDeps({ cache });
    const app = createApiRoutes(deps);

    const before = await app.request('/api/board');
    const etagBefore = before.headers.get('ETag');

    const b = project('/b', '/projects/b');
    seedCache(cache, [{ project: b, ticketId: 'bdboard-b' }]);

    const after = await app.request('/api/board');
    const etagAfter = after.headers.get('ETag');

    expect(etagBefore).not.toBeNull();
    expect(etagAfter).not.toBeNull();
    expect(etagBefore).not.toBe(etagAfter);
  });
  it('returns 401 not 304 when auth is enabled and credentials are missing', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const inner = createApiRoutes(createDeps({ cache }));
    const app = new Hono();
    app.use(
      '*',
      createBasicAuthMiddleware({
        kind: 'enabled',
        // Placeholder-shaped on purpose: adjacent username/password fixture
        // values are what GitGuardian's Username Password detector fires on
        // by pattern, regardless of whether the value is a real secret (see
        // CLAUDE.md).
        config: { username: 'example-user', password: 'example-password' },
      }),
    );
    app.route('/', inner);

    const authorized = await app.request('/api/board', {
      headers: {
        Authorization: `Basic ${Buffer.from('example-user:example-password').toString('base64')}`,
      },
    });
    const etag = authorized.headers.get('ETag');
    expect(authorized.status).toBe(200);
    expect(etag).not.toBeNull();

    const missingAuth = await app.request('/api/board', {
      headers: { 'If-None-Match': etag! },
    });
    expect(missingAuth.status).toBe(401);

    const wrongAuth = await app.request('/api/board', {
      headers: {
        'If-None-Match': etag!,
        Authorization: `Basic ${Buffer.from('example-user:wrong-pass').toString('base64')}`,
      },
    });
    expect(wrongAuth.status).toBe(401);
  });
  it('filters board by projects query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    // view=split: mode=merged(既定)ではbdboard-3tw.86でprojectsが空配列になるため、
    // projectsのフィルタ結果を検証するにはsplitビューを使う。
    const response = await app.request(
      `/api/board?view=split&projects=${encodeURIComponent(b.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].project.id).toBe(b.id);
  });
  it('treats empty projects query as no filter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?view=split&projects=');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.projects).toHaveLength(2);
  });
  it('empties projects in the default (merged) view so tickets are not sent twice', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe('merged');
    expect(body.projects).toEqual([]);
    expect(body.merged).not.toBeNull();
  });
  it('does not send the same ticket id twice in the merged view response', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?view=merged');
    const bodyText = await response.text();

    expect(response.status).toBe(200);
    expect((bodyText.match(/bdboard-a/g) ?? []).length).toBe(1);
    expect((bodyText.match(/bdboard-b/g) ?? []).length).toBe(1);
  });
  it('filters the board by epicId (bdboard-3tw.95)', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-epic', projectId: a.id }),
        makeTicket({ id: 'bdboard-child', projectId: a.id, parentId: 'bdboard-epic' }),
        makeTicket({ id: 'bdboard-unrelated', projectId: a.id }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?epicId=bdboard-epic');
    const body = await response.json();

    expect(response.status).toBe(200);
    const ids = body.merged.lanes.ready.map(
      (card: { ticket: { id: string } }) => card.ticket.id,
    );
    expect(ids.sort()).toEqual(['bdboard-child', 'bdboard-epic'].sort());
    expect(body.merged.cardCount).toBe(2);
  });
  it('treats an empty epicId query as no filter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?epicId=');
    const body = await response.json();

    expect(response.status).toBe(200);
    const ids = body.merged.lanes.ready.map(
      (card: { ticket: { id: string } }) => card.ticket.id,
    );
    expect(ids).toEqual(['bdboard-a']);
  });
  it('returns 200 with an empty board for an unknown epicId', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?epicId=bdboard-does-not-exist');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.cardCount).toBe(0);
    expect(body.merged.lanes.ready).toEqual([]);
    expect(body.merged.lanes.blocked).toEqual([]);
    expect(body.merged.lanes.done).toEqual([]);
  });
  it('keeps split view fully populated (no dedup applies there)', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?view=split');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged).toBeNull();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].board.lanes.ready.map((c: { ticket: { id: string } }) => c.ticket.id)).toEqual([
      'bdboard-a',
    ]);
  });
  it('truncates the done lane to the default closedLimit and reports closedTotal', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const closedTickets = Array.from({ length: 120 }, (_, i) =>
      makeTicket({
        id: `bdboard-closed-${i}`,
        projectId: a.id,
        status: 'closed',
        closedAt: new Date(NOW.getTime() - i * 60_000),
      }),
    );
    cache.putProject({
      project: a,
      tickets: closedTickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.lanes.done).toHaveLength(100);
    expect(body.merged.closedTotal).toBe(120);
    // 最近closedされた順に残る: bdboard-closed-0 が最新
    expect(body.merged.lanes.done[0].ticket.id).toBe('bdboard-closed-0');
    // load-bearing (bdboard-3tw.86 追補, 議長レビュー指摘): 切り捨てられた20件は
    // カードとしては消えるが、IDだけは merged.truncatedClosedIds として実際の
    // /api/board レスポンスに載っていること(既知ID自動リンク bdboard-3tw.64 の配線)。
    expect(body.merged.truncatedClosedIds).toHaveLength(20);
    expect(body.merged.truncatedClosedIds).toContain('bdboard-closed-119');
    expect(body.merged.truncatedClosedIds).not.toContain('bdboard-closed-0');
  });
  it('honors an explicit closedLimit query param', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const closedTickets = Array.from({ length: 10 }, (_, i) =>
      makeTicket({
        id: `bdboard-closed-${i}`,
        projectId: a.id,
        status: 'closed',
        closedAt: new Date(NOW.getTime() - i * 60_000),
      }),
    );
    cache.putProject({
      project: a,
      tickets: closedTickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?closedLimit=3');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged.lanes.done).toHaveLength(3);
    expect(body.merged.closedTotal).toBe(10);
    expect(body.merged.truncatedClosedIds).toHaveLength(7);
    expect(body.merged.truncatedClosedIds).toContain('bdboard-closed-9');
  });
  it('reports truncatedClosedIds per project in split view too', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const closedTickets = Array.from({ length: 5 }, (_, i) =>
      makeTicket({
        id: `bdboard-closed-${i}`,
        projectId: a.id,
        status: 'closed',
        closedAt: new Date(NOW.getTime() - i * 60_000),
      }),
    );
    cache.putProject({
      project: a,
      tickets: closedTickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/board?view=split&closedLimit=2');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.merged).toBeNull();
    expect(body.projects[0].board.lanes.done).toHaveLength(2);
    expect(body.projects[0].board.closedTotal).toBe(5);
    expect(body.projects[0].board.truncatedClosedIds).toHaveLength(3);
    expect(body.projects[0].board.truncatedClosedIds).toContain('bdboard-closed-4');
  });
  it('filters activity by projects query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, createdAt })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, createdAt })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(`/api/activity?projects=${encodeURIComponent(b.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].projectId).toBe(b.id);
    expect(body[0].id).toBe('bdboard-b');
  });
  it('returns search results across projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-alpha',
          projectId: a.id,
          title: 'Alpha feature',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: { ...b, name: 'Beta Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-beta',
          projectId: b.id,
          title: 'Beta feature',
          description: 'mentions alpha',
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/search?q=alpha');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      id: 'bdboard-alpha',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Alpha feature',
      status: 'open',
      priority: 2,
      issueType: 'task',
    });
    expect(body[1].id).toBe('bdboard-beta');
    assertNoDates(body);
  });
  it('returns empty array for empty search query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));

    const missing = await app.request('/api/search');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual([]);

    const blank = await app.request('/api/search?q=');
    expect(blank.status).toBe(200);
    expect(await blank.json()).toEqual([]);

    const whitespace = await app.request('/api/search?q=%20%20');
    expect(whitespace.status).toBe(200);
    expect(await whitespace.json()).toEqual([]);
  });
  it('clamps search limit between 1 and 50', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const tickets = Array.from({ length: 60 }, (_, index) =>
      makeTicket({
        id: `bdboard-${index}`,
        projectId: a.id,
        title: 'searchable ticket',
      }),
    );
    cache.putProject({
      project: a,
      tickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const over = await app.request('/api/search?q=searchable&limit=100');
    expect(over.status).toBe(200);
    expect((await over.json()) as unknown[]).toHaveLength(50);

    const under = await app.request('/api/search?q=searchable&limit=0');
    expect(under.status).toBe(200);
    expect((await under.json()) as unknown[]).toHaveLength(1);

    const defaultLimit = await app.request('/api/search?q=searchable');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()) as unknown[]).toHaveLength(30);
  });
  it('returns activity events with ISO timestamps and no ETag', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');
    const startedAt = new Date('2026-06-01T09:00:00.000Z');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-activity',
          projectId: a.id,
          title: 'Activity ticket',
          createdAt,
          startedAt,
          closedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/activity');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual({
      kind: 'closed',
      at: closedAt.toISOString(),
      id: 'bdboard-activity',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Activity ticket',
      status: 'open',
      priority: 2,
      issueType: 'task',
    });
    assertNoDates(body);
  });
  it('clamps activity days between 1 and 30 and limit between 1 and 200', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const tickets = Array.from({ length: 250 }, (_, index) =>
      makeTicket({
        id: `bdboard-${index}`,
        projectId: a.id,
        createdAt: new Date(NOW.getTime() - index * 60_000),
      }),
    );
    cache.putProject({
      project: a,
      tickets,
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const overLimit = await app.request('/api/activity?limit=500');
    expect(overLimit.status).toBe(200);
    expect((await overLimit.json()) as unknown[]).toHaveLength(200);

    const underLimit = await app.request('/api/activity?limit=0');
    expect(underLimit.status).toBe(200);
    expect((await underLimit.json()) as unknown[]).toHaveLength(1);

    const defaultLimit = await app.request('/api/activity');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()) as unknown[]).toHaveLength(100);

    const overDays = await app.request('/api/activity?days=99');
    expect(overDays.status).toBe(200);
    expect((await overDays.json()) as unknown[]).toHaveLength(100);

    const underDays = await app.request('/api/activity?days=0');
    expect(underDays.status).toBe(200);
    expect((await underDays.json()) as unknown[]).toHaveLength(100);

    const invalidDays = await app.request('/api/activity?days=abc&limit=xyz');
    expect(invalidDays.status).toBe(200);
    expect((await invalidDays.json()) as unknown[]).toHaveLength(100);
  });
  it('returns projects with session fields when provider is present', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const aliveInA = makeSession({
      sessionId: 'session-alive-a',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const deadInA = makeSession({
      sessionId: 'session-dead-a',
      cwd: '/projects/a/subdir',
      alive: false,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const worktreeInA = makeSession({
      sessionId: 'session-worktree-a',
      cwd: '/projects/a/.claude/worktrees/x',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const sessionInB = makeSession({
      sessionId: 'session-b',
      cwd: '/projects/b',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [aliveInA, deadInA, worktreeInA, sessionInB],
      }),
    );

    const response = await app.request('/api/projects');
    const body = await response.json();

    expect(response.status).toBe(200);

    const projectA = body.find((entry: { id: string }) => entry.id === a.id);
    const projectB = body.find((entry: { id: string }) => entry.id === b.id);

    expect(projectA.activeSessionCount).toBe(2);
    expect(projectA.sessionCount).toBe(3);
    expect(projectA.sessions).toHaveLength(3);
    expect(projectA.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(
      expect.arrayContaining([
        'session-alive-a',
        'session-dead-a',
        'session-worktree-a',
      ]),
    );

    expect(projectB.activeSessionCount).toBe(1);
    expect(projectB.sessionCount).toBe(1);
    expect(projectB.sessions).toHaveLength(1);
    expect(projectB.sessions[0].sessionId).toBe('session-b');
  });
  it('returns empty session fields on projects when provider is absent', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/projects');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0].activeSessionCount).toBe(0);
    expect(body[0].sessionCount).toBe(0);
    expect(body[0].sessions).toEqual([]);
  });
  it('includes activeSessionCount on board split view projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    seedCache(cache, [
      { project: a, ticketId: 'bdboard-a' },
      { project: b, ticketId: 'bdboard-b' },
    ]);

    const aliveInA = makeSession({
      sessionId: 'session-alive-a',
      cwd: '/projects/a',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const deadInA = makeSession({
      sessionId: 'session-dead-a',
      cwd: '/projects/a',
      alive: false,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
    const sessionInB = makeSession({
      sessionId: 'session-b',
      cwd: '/projects/other',
      alive: true,
      startedAt: NOW,
      lastActivityAt: NOW,
    });

    const app = createApiRoutes(
      createDeps({
        cache,
        sessions: () => [aliveInA, deadInA, sessionInB],
      }),
    );

    const response = await app.request('/api/board?view=split');
    const body = await response.json();

    expect(response.status).toBe(200);

    const projectA = body.projects.find(
      (entry: { project: { id: string } }) => entry.project.id === a.id,
    );
    const projectB = body.projects.find(
      (entry: { project: { id: string } }) => entry.project.id === b.id,
    );

    expect(projectA.project.activeSessionCount).toBe(1);
    expect(projectA.project.sessionCount).toBe(2);
    expect(projectA.project.sessions).toHaveLength(2);
    expect(projectB.project.activeSessionCount).toBe(0);
    expect(projectB.project.sessionCount).toBe(0);
    expect(projectB.project.sessions).toEqual([]);
  });
});
