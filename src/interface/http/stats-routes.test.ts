import { describe, expect, it, vi } from 'vitest';
import { createApiRoutes } from './routes.js';
import { makeTicket } from '../../domain/test-support.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import { createReclaimHistory } from '../../application/lease/reclaim-history.js';
import { NOW, project, createFakeBoardCache, createDeps, assertNoDates } from './routes-test-support.js';

// bdboard-sso1.7: routes.test.ts (createApiRoutes 総合テスト) を実装側のルート
// モジュール分割 (bdboard-sso1.1) に追随させてリソース別へ move-only 分割した一部。
// テスト本体・期待値・モックの記述は元の routes.test.ts から一字一句変更していない。
describe('createApiRoutes', () => {
  it('filters stats by projects query', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a-closed',
          projectId: a.id,
          closedAt,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-b-closed',
          projectId: b.id,
          closedAt,
        }),
        makeTicket({
          id: 'bdboard-b-closed-2',
          projectId: b.id,
          closedAt,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(`/api/stats?weeks=1&projects=${encodeURIComponent(a.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].projectId).toBe(a.id);
    expect(body.totals.weeklyCloses[0].count).toBe(1);
  });
  it('returns throughput stats with ISO weekStart and projectName', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: { ...a, name: 'Alpha Project' },
      tickets: [
        makeTicket({
          id: 'bdboard-stats-closed',
          projectId: a.id,
          closedAt,
        }),
        makeTicket({
          id: 'bdboard-stats-open',
          projectId: a.id,
          createdAt: new Date('2026-05-30T10:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/stats?weeks=1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeNull();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      projectId: a.id,
      projectName: 'Alpha Project',
      weeklyCloses: [{ count: 1 }],
      openTicketAge: {
        d0to1: 0,
        d1to7: 1,
        d7to30: 0,
        d30plus: 0,
      },
    });
    expect(typeof body.projects[0].weeklyCloses[0].weekStart).toBe('string');
    expect(body.totals.weeklyCloses[0].count).toBe(1);
    assertNoDates(body);
  });
  it('returns model stats with ISO weekStart and project filter', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-model-a',
          projectId: a.id,
          closedAt,
          models: [{ stage: 'implement', model: 'composer-2.5' }],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-model-b',
          projectId: b.id,
          closedAt,
          models: [{ stage: 'implement', model: 'gpt-5' }],
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request(
      `/api/model-stats?weeks=1&projects=${encodeURIComponent(a.id)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.weeklyCloses).toHaveLength(1);
    expect(typeof body.weeklyCloses[0].weekStart).toBe('string');
    expect(body.weeklyCloses[0].counts).toEqual({ 'composer-2.5': 1 });
    expect(body.stageModelDistribution).toEqual([
      { stage: 'implement', counts: { 'composer-2.5': 1 } },
    ]);
    assertNoDates(body);
  });
  it('returns harness KPI with the reclaim record start time', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    const reclaimAt = new Date('2026-06-01T09:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-kpi-gate',
          projectId: a.id,
          labels: ['human', 'harness'],
          title: '重複の統合',
          createdAt: new Date('2026-06-01T06:00:00.000Z'),
          closedAt: new Date('2026-06-01T08:00:00.000Z'),
          startedAt: new Date('2026-06-01T09:10:00.000Z'),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const reclaimHistory = createReclaimHistory({
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    reclaimHistory.record({
      projectId: a.id,
      at: reclaimAt,
      reclaimedCount: 1,
      ticketIds: ['bdboard-kpi-gate'],
    });

    const app = createApiRoutes(createDeps({ cache, reclaimHistory }));
    const response = await app.request('/api/harness-kpi?weeks=1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.rangeStart).toBe('string');
    expect(body.pendingDecisionDwell).toEqual({
      closedCount: 1,
      closedGateCount: 0,
      closedWorkCount: 1,
      openCount: 0,
      openGateCount: 0,
      openWorkCount: 0,
      medianMs: 2 * 60 * 60_000,
      p90Ms: 2 * 60 * 60_000,
      anchor: 'created',
    });
    expect(body.reclaim).toMatchObject({
      runCount: 1,
      identifiedTicketCount: 1,
      reclaimedThenInProgressCount: 1,
      reclaimedThenInProgressRate: 1,
      since: '2026-06-01T00:00:00.000Z',
      unparsedRunCount: 0,
    });
    expect(body.harnessLabeled).toEqual({ matchedCount: 1, totalCount: 1, rate: 1 });
    expect(body.duplicateMention).toEqual({ matchedCount: 1, totalCount: 1, rate: 1 });
    assertNoDates(body);
  });
  it('returns harness KPI without reclaim data when no history is wired', async () => {
    const cache = createFakeBoardCache();
    const app = createApiRoutes(createDeps({ cache }));
    const response = await app.request('/api/harness-kpi');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reclaim).toMatchObject({
      runCount: 0,
      since: null,
      unparsedRunCount: 0,
      // M2 (bdboard-t3ct): worktreeScanner が無いのでスキャン自体していない。
      // 「0件」と断言できないので null (UI は — を出す)。
      reclaimedLiveWorktreeCount: null,
      reclaimedLiveWorktreeRate: null,
    });
    assertNoDates(body);
  });
  it('returns null misreclaim count/rate when the git worktree scan is incomplete', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-live',
          projectId: a.id,
          status: 'open',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const reclaimHistory = createReclaimHistory({
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    reclaimHistory.record({
      projectId: a.id,
      at: new Date('2026-06-01T09:00:00.000Z'),
      reclaimedCount: 1,
      ticketIds: ['bdboard-live'],
    });

    // M2 (bdboard-t3ct): git-worktree-scanner.ts はコマンド失敗を throw せず
    // complete:false に畳む。scanGitLeftovers はそれでも「読めた範囲」の候補を
    // 返すが、harness-kpi ルートは complete:false を見て null に上書きすること。
    const worktreeScanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: vi.fn(async () => ({
        worktrees: [],
        bdBranches: [],
        complete: false,
      })),
    };

    const app = createApiRoutes(createDeps({ cache, reclaimHistory, worktreeScanner }));
    const response = await app.request('/api/harness-kpi?weeks=1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reclaim).toMatchObject({
      identifiedTicketCount: 1,
      reclaimedLiveWorktreeCount: null,
      reclaimedLiveWorktreeRate: null,
    });
  });
  it('counts a reclaimed ticket with a live worktree as reclaimedLiveWorktreeCount', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-live',
          projectId: a.id,
          status: 'open',
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const reclaimHistory = createReclaimHistory({
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    reclaimHistory.record({
      projectId: a.id,
      at: new Date('2026-06-01T09:00:00.000Z'),
      reclaimedCount: 1,
      ticketIds: ['bdboard-live'],
    });

    const worktreeScanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: vi.fn(async () => ({
        worktrees: [
          { path: '/projects/a', branch: 'main', isMain: true },
          {
            path: '/projects/a/.claude/worktrees/bdboard-live',
            branch: 'bd/bdboard-live',
            isMain: false,
          },
        ],
        bdBranches: ['bd/bdboard-live'],
        complete: true,
      })),
    };

    const app = createApiRoutes(createDeps({ cache, reclaimHistory, worktreeScanner }));
    const response = await app.request('/api/harness-kpi?weeks=1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reclaim).toMatchObject({
      identifiedTicketCount: 1,
      reclaimedLiveWorktreeCount: 1,
      reclaimedLiveWorktreeRate: 1,
    });
  });
  it('clamps stats weeks between 1 and 26 and defaults invalid values to 8', async () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a');
    cache.putProject({
      project: a,
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const app = createApiRoutes(createDeps({ cache }));

    const overWeeks = await app.request('/api/stats?weeks=100');
    expect(overWeeks.status).toBe(200);
    expect((await overWeeks.json()).totals.weeklyCloses).toHaveLength(26);

    const underWeeks = await app.request('/api/stats?weeks=0');
    expect(underWeeks.status).toBe(200);
    expect((await underWeeks.json()).totals.weeklyCloses).toHaveLength(1);

    const defaultWeeks = await app.request('/api/stats');
    expect(defaultWeeks.status).toBe(200);
    expect((await defaultWeeks.json()).totals.weeklyCloses).toHaveLength(8);

    const invalidWeeks = await app.request('/api/stats?weeks=abc');
    expect(invalidWeeks.status).toBe(200);
    expect((await invalidWeeks.json()).totals.weeklyCloses).toHaveLength(8);
  });
});
