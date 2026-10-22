import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeTicket } from '../../domain/test-support.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import { NOW, project, createFakeBoardCache, seedCache, createDeps, assertNoDates } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('returns dependency graph filtered by projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          dependencies: [
            { issueId: 'bdboard-a', dependsOnId: 'bdboard-b', kind: 'blocks' },
          ],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, dependencies: [] })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(`/api/graph?projects=${encodeURIComponent(a.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    assertNoDates(body);
  });
  it('returns dependency graph nodes and edges across projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          dependencies: [
            { issueId: 'bdboard-a', dependsOnId: 'bdboard-b', kind: 'blocks' },
          ],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, dependencies: [] })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/graph');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toEqual([
      { from: 'bdboard-a', to: 'bdboard-b', kind: 'blocks' },
    ]);
    expect(body.nodes[0]).toMatchObject({
      ticketId: expect.any(String),
      projectId: expect.any(String),
      title: expect.any(String),
      status: expect.any(String),
      priority: expect.any(Number),
      issueType: expect.any(String),
      layer: expect.any(Number),
    });
    assertNoDates(body);
  });
  it('returns 501 when lease health dependencies are not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/lease-health');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'lease health not available' });
  });
  it('returns stale leases and reclaim scheduler status', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-active',
          projectId: a.id,
          status: 'in_progress',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const leaseReader: LeaseReader = {
      listInProgressWithLease: vi.fn(async () => [
        {
          id: 'bdboard-stale',
          leaseExpiresAt: '2026-06-01T11:50:00.000Z',
          heartbeatAt: '2026-06-01T11:45:00.000Z',
          startedAt: null,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ]),
    };
    const reclaimScheduler: ReclaimScheduler = {
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(() => ({
        enabled: true,
        intervalMs: 300_000,
        olderThan: '10m',
        projects: [
          {
            projectId: a.id,
            lastRunAt: '2026-06-01T11:55:00.000Z',
            reclaimedCount: 1,
            reclaimedCountUnknown: false,
            rawSummary: 'reclaimed 1 issue',
            lastError: null,
          },
        ],
      })),
    };

    const app = createApiRoutes(
      createDeps({ cache, leaseReader, reclaimScheduler }),
    );
    const response = await app.request('/api/lease-health');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.staleLeases).toEqual([
      {
        ticketId: 'bdboard-stale',
        projectId: 'proj-a',
        leaseExpiresAt: '2026-06-01T11:50:00.000Z',
        staleForMs: 10 * 60_000,
      },
    ]);
    expect(body.reclaim).toMatchObject({
      enabled: true,
      intervalMs: 300_000,
      olderThan: '10m',
      projects: [
        expect.objectContaining({
          projectId: 'proj-a',
          reclaimedCount: 1,
          lastError: null,
        }),
      ],
    });
    assertNoDates(body);
  });
  it('returns 501 when pr link dependencies are not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/pr-links');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'pr links not available' });
  });
  it('returns pr badges for tickets with PR comments', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const prUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/42';

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-pr',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${prUrl}`,
          createdAt: NOW,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'open', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const app = createApiRoutes(
      createDeps({ cache, commentReader, prStatusReader }),
    );
    const response = await app.request('/api/pr-links');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        ticketId: 'bdboard-pr',
        projectId: 'proj-a',
        url: prUrl,
        state: 'open',
        checkStatus: 'pass',
      },
    ]);
    assertNoDates(body);
  });
  it('returns pr badges filtered by projects', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');
    const prUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/99';

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-b',
          projectId: b.id,
          commentCount: 1,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${prUrl}`,
          createdAt: NOW,
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () =>
        ({ status: { state: 'merged', checkStatus: 'pass' } satisfies PrStatus }),
      ),
    };

    const app = createApiRoutes(
      createDeps({ cache, commentReader, prStatusReader }),
    );
    const response = await app.request(
      `/api/pr-links?projects=${encodeURIComponent(b.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      ticketId: 'bdboard-b',
      projectId: 'proj-b',
      url: prUrl,
      state: 'merged',
      checkStatus: 'pass',
    });
    assertNoDates(body);
  });
  it('returns 501 when merge slot reader is not configured', async () => {
    const app = createApiRoutes(createDeps());
    const response = await app.request('/api/merge-slot-status');
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toEqual({ error: 'merge slot status not available' });
  });
  it('returns held merge slot status for cached projects', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    seedCache(cache, [{ project: projectA, ticketId: 'bdboard-a' }]);

    const mergeSlotReader: MergeSlotReader = {
      readMergeSlotSignal: vi.fn(async () => ({
        status: 'in_progress',
        holder: 'session-merge-holder',
        // 15 minutes before the suite's frozen NOW, so heldForMs below is a
        // real positive delta rather than clamping to 0 (a future-relative-
        // to-NOW updatedAt would silently mask a heldForMs regression).
        updatedAt: '2026-06-01T11:45:00.000Z',
      })),
    };

    const app = createApiRoutes(createDeps({ cache, mergeSlotReader }));
    const response = await app.request('/api/merge-slot-status');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        projectId: 'proj-a',
        present: true,
        held: true,
        holder: 'session-merge-holder',
        heldSinceIso: '2026-06-01T11:45:00.000Z',
        heldForMs: 15 * 60_000,
        isLongHeld: false,
      },
    ]);
    assertNoDates(body);
  });
  it('filters merge slot status by projects query parameter', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('proj-a', '/projects/a');
    const projectB = project('proj-b', '/projects/b');
    seedCache(cache, [
      { project: projectA, ticketId: 'bdboard-a' },
      { project: projectB, ticketId: 'bdboard-b' },
    ]);

    const readMergeSlotSignal = vi.fn(async () => ({
      status: 'open',
      holder: null,
      updatedAt: '2026-08-17T10:48:26Z',
    }));
    const mergeSlotReader: MergeSlotReader = { readMergeSlotSignal };

    const app = createApiRoutes(createDeps({ cache, mergeSlotReader }));
    const response = await app.request(
      `/api/merge-slot-status?projects=${encodeURIComponent(projectA.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]?.projectId).toBe('proj-a');
    expect(readMergeSlotSignal).toHaveBeenCalledTimes(1);
    expect(readMergeSlotSignal).toHaveBeenCalledWith('/projects/a');
  });
});
