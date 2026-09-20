import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeSessionLink, makeTicket } from '../../domain/test-support.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import { NOW, project, createFakeBoardCache, seedCache, createDeps, assertNoDates, inFlightScanner, inFlightCache, IN_FLIGHT_FILES } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns ticket detail for dot-containing id', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-3tw.10' }]);

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-3tw.10');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe('bdboard-3tw.10');
  });
  it('builds the direct children list (id/title/lane) for ticket detail, excluding grandchildren (bdboard-3tw.95)', async () => {
    // Exercises the children-index construction in the route handler itself
    // (buildDirectChildrenIndex over view.merged.cards + cardsById lookup),
    // not just the toTicketDetailDto passthrough covered in dto.test.ts.
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-epic', projectId: a.id, title: 'Epic' }),
        makeTicket({
          id: 'bdboard-child-open',
          projectId: a.id,
          parentId: 'bdboard-epic',
          title: 'Open child',
        }),
        makeTicket({
          id: 'bdboard-child-done',
          projectId: a.id,
          parentId: 'bdboard-epic',
          title: 'Done child',
          status: 'closed',
        }),
        makeTicket({
          id: 'bdboard-grandchild',
          projectId: a.id,
          parentId: 'bdboard-child-open',
          title: 'Grandchild',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-epic');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.children).toHaveLength(2);
    expect(body.children).toEqual(
      expect.arrayContaining([
        { id: 'bdboard-child-open', title: 'Open child', lane: 'ready' },
        { id: 'bdboard-child-done', title: 'Done child', lane: 'done' },
      ]),
    );
    expect(
      (body.children as { id: string }[]).map((child) => child.id),
    ).not.toContain('bdboard-grandchild');
  });
  it('includes token usage when links and cache usage exist', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    seedCache(cache, [{ project: a, ticketId: 'bdboard-3tw.10' }]);
    cache.getSessionUsage = () => [
      {
        model: 'claude-opus-5',
        inputTokens: 12,
        outputTokens: 6,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
      },
    ];

    const links = () => [
      {
        ticketId: 'bdboard-3tw.10',
        sessionId: 'sess-a',
        source: 'transcript' as const,
        confidence: 0.6,
        observedAt: NOW,
      },
    ];

    const app = createApiRoutes(createDeps({ cache, links }));
    const response = await app.request('/api/tickets/bdboard-3tw.10');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.usage).toEqual({
      totalInputTokens: 12,
      totalOutputTokens: 6,
      totalCacheCreationInputTokens: 100,
      totalCacheReadInputTokens: 50,
      byModel: [
        {
          model: 'claude-opus-5',
          inputTokens: 12,
          outputTokens: 6,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 50,
        },
      ],
    });
  });
  it('still finds a closed ticket older than /api/board default closedLimit (bdboard-3tw.86)', async () => {
    // /api/board のclosedLimit(既定100件/プロジェクト)は表示用の一覧を絞るだけで、
    // IDでの直接取得(/api/tickets/:id)には効かせない設計であることの回帰確認。
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

    // bdboard-closed-119 is the oldest -> falls outside the top-100 by closedAt desc
    const boardResponse = await app.request('/api/board');
    const boardBody = await boardResponse.json();
    expect(
      boardBody.merged.lanes.done.some(
        (c: { ticket: { id: string } }) => c.ticket.id === 'bdboard-closed-119',
      ),
    ).toBe(false);

    const detailResponse = await app.request('/api/tickets/bdboard-closed-119');
    const detailBody = await detailResponse.json();
    expect(detailResponse.status).toBe(200);
    expect(detailBody.id).toBe('bdboard-closed-119');
  });
  it('returns 404 for missing ticket', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/tickets/missing-ticket');
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'ticket not found', id: 'missing-ticket' });
  });
  it('returns ticket timeline events for a cached ticket id', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');
    const startedAt = new Date('2026-06-01T09:00:00.000Z');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-timeline',
          projectId: a.id,
          title: 'Timeline ticket',
          createdAt,
          startedAt,
          closedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-timeline/timeline');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual({
      kind: 'closed',
      at: closedAt.toISOString(),
      id: 'bdboard-timeline',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Timeline ticket',
      status: 'open',
      priority: 2,
      issueType: 'task',
    });
    assertNoDates(body);
  });
  it('returns an empty array for ticket timeline when ticket is missing', async () => {
    const cache = createFakeBoardCache();
    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/missing-ticket/timeline');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
  it('returns similar tickets sorted by score for a cached ticket id', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const target = makeTicket({
      id: 'bdboard-target',
      projectId: a.id,
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });
    const high = makeTicket({
      id: 'bdboard-high',
      projectId: a.id,
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });
    const medium = makeTicket({
      id: 'bdboard-medium',
      projectId: b.id,
      title: 'Similar ticket panel',
      description: 'Show similar tickets in the detail panel',
    });
    const unrelated = makeTicket({
      id: 'bdboard-unrelated',
      projectId: b.id,
      title: 'Mobile tunnel QR code',
      description: 'Fix Safari credential URL handling',
    });

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [target, high],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: { ...b, name: 'Beta Project' },
      tickets: [medium, unrelated],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/bdboard-target/similar');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      id: 'bdboard-high',
      projectId: a.id,
      projectName: 'Alpha Project',
      title: 'Similar ticket detection',
      status: 'open',
      priority: 2,
      issueType: 'task',
      score: 1,
    });
    expect(body[1].id).toBe('bdboard-medium');
    expect(body[1].score).toBeGreaterThan(0);
    expect(body.some((entry: { id: string }) => entry.id === 'bdboard-target')).toBe(false);
    expect(body.some((entry: { id: string }) => entry.id === 'bdboard-unrelated')).toBe(false);
    assertNoDates(body);
  });
  it('returns an empty array for similar tickets when ticket is missing', async () => {
    const cache = createFakeBoardCache();
    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/tickets/missing-ticket/similar');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
  it('clamps similar ticket limit between 1 and 20', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const target = makeTicket({
      id: 'bdboard-target',
      projectId: a.id,
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });
    const similarTickets = Array.from({ length: 25 }, (_, index) =>
      makeTicket({
        id: `bdboard-similar-${index}`,
        projectId: a.id,
        title: 'Similar ticket detection',
        description: 'Detail panel display',
      }),
    );

    cache.putProject({
      project: a,
      tickets: [target, ...similarTickets],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const over = await app.request('/api/tickets/bdboard-target/similar?limit=100');
    expect(over.status).toBe(200);
    expect((await over.json()) as unknown[]).toHaveLength(20);

    const under = await app.request('/api/tickets/bdboard-target/similar?limit=0');
    expect(under.status).toBe(200);
    expect((await under.json()) as unknown[]).toHaveLength(1);

    const defaultLimit = await app.request('/api/tickets/bdboard-target/similar');
    expect(defaultLimit.status).toBe(200);
    expect((await defaultLimit.json()) as unknown[]).toHaveLength(5);
  });
  it('returns the in-flight overlaps of a single ticket for the detail panel', async () => {
    const { cache } = inFlightCache();
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: inFlightScanner(IN_FLIGHT_FILES) }),
    );

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      { ticketId: 'bdboard-y', files: ['src/domain/hygiene.ts'] },
    ]);

    const noOverlap = await (
      await app.request('/api/tickets/bdboard-z/in-flight-overlaps')
    ).json();
    expect(noOverlap).toEqual([]);
  });
  it('returns an empty in-flight overlap list without a worktreeScanner', async () => {
    const { cache } = inFlightCache();
    const app = createApiRoutes(createDeps({ cache }));

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
  it('returns an empty in-flight overlap list when the ticket has no worktree', async () => {
    const { cache } = inFlightCache();
    const listChangedFiles = vi.fn(async () => ['src/domain/hygiene.ts']);
    const scanner: WorktreeScanner = {
      scan: async () => ({
        worktrees: [{ path: '/projects/a', branch: 'main', isMain: true }],
        bdBranches: [],
        complete: true,
      }),
      listChangedFiles,
    };
    const app = createApiRoutes(createDeps({ cache, worktreeScanner: scanner }));

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(listChangedFiles).not.toHaveBeenCalled();
  });
  it('reuses one scan for /api/hygiene and the detail panel', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;
    expect(afterHygiene).toBeGreaterThan(0);

    // 同じプロジェクト集合なので、詳細パネルは 30 秒メモを引く
    const body = await (
      await app.request('/api/tickets/bdboard-x/in-flight-overlaps')
    ).json();

    expect(body).toEqual([{ ticketId: 'bdboard-y', files: ['src/domain/hygiene.ts'] }]);
    expect(listChangedFiles.mock.calls.length).toBe(afterHygiene);
  });
  it('does not reuse the memo after the project is refetched on close (bdboard-3tw.162)', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;

    // 他セッションが bdboard-y を close した → refresh が putProject し直す (board.changed と同じ条件)
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-x', projectId: a.id, status: 'in_progress' }),
        makeTicket({ id: 'bdboard-y', projectId: a.id, status: 'closed' }),
        makeTicket({ id: 'bdboard-z', projectId: a.id, status: 'in_progress' }),
      ],
      fingerprint: 'fp-a-2',
      fetchedAt: new Date(NOW.getTime() + 1_000),
    });

    const body = await (
      await app.request('/api/tickets/bdboard-x/in-flight-overlaps')
    ).json();

    expect(body).toEqual([]);
    expect(listChangedFiles.mock.calls.length).toBeGreaterThan(afterHygiene);

    // 新しい世代で計算し直した結果は、同じ世代のあいだは再び使い回す
    const afterRescan = listChangedFiles.mock.calls.length;
    await app.request('/api/hygiene?projects=proj-a');
    expect(listChangedFiles.mock.calls.length).toBe(afterRescan);
  });
  it('does not reuse the memo after a forced refetch that keeps the fingerprint', async () => {
    const { cache } = inFlightCache();
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;

    // 書き込み後の強制リフレッシュは fingerprint が同じでも fetchedAt を進める
    const entry = cache.getProject('proj-a');
    if (entry === undefined) {
      throw new Error('proj-a must be cached');
    }
    cache.putProject({ ...entry, fetchedAt: new Date(NOW.getTime() + 1_000) });

    await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(listChangedFiles.mock.calls.length).toBeGreaterThan(afterHygiene);
  });
  it('keeps the memo when only another project is refetched', async () => {
    const { cache } = inFlightCache();
    const b = project('proj-b', '/projects/b');
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'other-1', projectId: b.id, status: 'open' })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });
    const base = inFlightScanner(IN_FLIGHT_FILES);
    const listChangedFiles = vi.fn(base.listChangedFiles);
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: { ...base, listChangedFiles } }),
    );

    await app.request('/api/hygiene?projects=proj-a');
    const afterHygiene = listChangedFiles.mock.calls.length;

    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'other-1', projectId: b.id, status: 'closed' })],
      fingerprint: 'fp-b-2',
      fetchedAt: new Date(NOW.getTime() + 1_000),
    });

    const body = await (
      await app.request('/api/tickets/bdboard-x/in-flight-overlaps')
    ).json();

    expect(body).toEqual([{ ticketId: 'bdboard-y', files: ['src/domain/hygiene.ts'] }]);
    expect(listChangedFiles.mock.calls.length).toBe(afterHygiene);
  });
  it('returns an empty in-flight overlap list for a closed ticket without touching git', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-x', projectId: a.id, status: 'closed' })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    const scan = vi.fn(async () => ({ worktrees: [], bdBranches: [], complete: true }));
    const app = createApiRoutes(
      createDeps({
        cache,
        worktreeScanner: { scan, listChangedFiles: async () => [] },
      }),
    );

    const response = await app.request('/api/tickets/bdboard-x/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });
  it('returns an empty in-flight overlap list for an unknown ticket', async () => {
    const { cache } = inFlightCache();
    const app = createApiRoutes(
      createDeps({ cache, worktreeScanner: inFlightScanner(IN_FLIGHT_FILES) }),
    );

    const response = await app.request('/api/tickets/bdboard-nope/in-flight-overlaps');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
  it('returns 501 when human decisions port is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/tickets/pending-decisions');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'pending decisions not available' });
  });
  it('returns pending decisions from cache without shelling out to bd', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    const projectB = project('proj-b', '/projects/b');
    cache.putProject({
      project: projectA,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: projectA.id })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [
        {
          id: 'bdboard-a',
          kind: 'gate',
          question: 'Q1?',
          options: [{ label: 'Yes', value: 'yes' }],
          allowFreeform: true,
        },
      ],
    });
    cache.putProject({
      project: projectB,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: projectB.id })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: vi.fn(async () => {
        throw new Error('should not be called');
      }),
      respond: vi.fn<HumanDecisionsPort['respond']>(async () => ({ kind: 'ticket', closed: false })),
    };

    const app = createApiRoutes(createDeps({ cache, humanDecisions }));
    const response = await app.request('/api/tickets/pending-decisions');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(humanDecisions.listPendingDecisions).not.toHaveBeenCalled();
    expect(body).toEqual([
      {
        id: 'bdboard-a',
        projectId: 'proj-a',
        kind: 'gate',
        question: 'Q1?',
        options: [{ label: 'Yes', value: 'yes' }],
        allowFreeform: true,
      },
    ]);
  });
  describe('GET /api/tickets/:id sessionLinks', () => {
    it('includes transcript-sourced links from deps.links', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

      const links = () => [
        makeSessionLink({
          ticketId: 'bdboard-a',
          sessionId: 'sess-inferred',
          source: 'transcript',
        }),
        // Different ticket: must not leak into bdboard-a's sessionLinks.
        makeSessionLink({ ticketId: 'bdboard-other', sessionId: 'sess-other' }),
      ];

      const app = createApiRoutes(createDeps({ cache, links }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([
        { sessionId: 'sess-inferred', source: 'transcript' },
      ]);
    });

    it('merges the cached manual link, preferring metadata over transcript for the same session', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{
        project: a,
        ticketId: 'bdboard-a',
        ticket: { manualSessionId: 'sess-shared' },
      }]);

      const links = () => [
        makeSessionLink({
          ticketId: 'bdboard-a',
          sessionId: 'sess-shared',
          source: 'transcript',
        }),
      ];
      const app = createApiRoutes(createDeps({ cache, links }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([
        { sessionId: 'sess-shared', source: 'metadata' },
      ]);
    });

    it('includes models cached with the ticket in stage order', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{
        project: a,
        ticketId: 'bdboard-a',
        ticket: {
          models: [
            { stage: 'implement', model: 'composer-2.5' },
            { stage: 'test', model: 'opus' },
            { stage: 'review', model: 'fable' },
          ],
        },
      }]);

      const app = createApiRoutes(createDeps({ cache }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.models).toEqual([
        { stage: 'implement', model: 'composer-2.5' },
        { stage: 'test', model: 'opus' },
        { stage: 'review', model: 'fable' },
      ]);
    });

    it('keeps distinct manual and inferred links side by side', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{
        project: a,
        ticketId: 'bdboard-a',
        ticket: { manualSessionId: 'sess-manual' },
      }]);

      const links = () => [
        makeSessionLink({
          ticketId: 'bdboard-a',
          sessionId: 'sess-inferred',
          source: 'transcript',
        }),
      ];
      const app = createApiRoutes(createDeps({ cache, links }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([
        { sessionId: 'sess-inferred', source: 'transcript' },
        { sessionId: 'sess-manual', source: 'metadata' },
      ]);
    });

    it('returns no manual link and empty models when the cache has no metadata', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

      const app = createApiRoutes(createDeps({ cache }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([]);
      expect(body.models).toEqual([]);
      expect(body.id).toBe('bdboard-a');
    });

    it('returns an empty sessionLinks array when no links are configured', async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/root/a');
      seedCache(cache, [{ project: a, ticketId: 'bdboard-a' }]);

      const app = createApiRoutes(createDeps({ cache }));
      const response = await app.request('/api/tickets/bdboard-a');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionLinks).toEqual([]);
    });
  });
});
