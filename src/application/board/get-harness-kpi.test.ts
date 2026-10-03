import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { ReclaimRunRecord } from '../../domain/harness-kpi.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import { getHarnessKpi } from './get-harness-kpi.js';

const UTC = 'UTC';

function utcInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

describe('getHarnessKpi', () => {
  const now = utcInstant(2026, 8, 15, 12);

  it('returns an empty result for an empty cache', async () => {
    const cache = createFakeBoardCache();

    const { kpi, reclaimSince } = await getHarnessKpi(cache, now, { timeZone: UTC });

    expect(reclaimSince).toBeNull();
    expect(kpi.pendingDecisionDwell).toEqual({
      closedCount: 0,
      closedGateCount: 0,
      closedWorkCount: 0,
      openCount: 0,
      openGateCount: 0,
      openWorkCount: 0,
      medianMs: null,
      p90Ms: null,
      anchor: 'created',
    });
    expect(kpi.harnessLabeled.rate).toBeNull();
    expect(kpi.duplicateMention.rate).toBeNull();
    expect(kpi.reclaim.runCount).toBe(0);
  });

  it('handles a project with 150,000 tickets', async () => {
    const cache = createFakeBoardCache();
    const proj = project('/large', '/projects/large');
    cache.putProject({
      project: proj,
      tickets: Array.from({ length: 150_000 }, (_, index) =>
        makeTicket({
          id: `bdboard-large-${index}`,
          projectId: proj.id,
          labels: ['human'],
        }),
      ),
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const { kpi } = await getHarnessKpi(cache, now, { timeZone: UTC });
    expect(kpi.pendingDecisionDwell.openCount).toBe(150_000);
  });

  it('starts the range at the first week monday of the selected week count', async () => {
    const cache = createFakeBoardCache();
    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    // now = 2026-08-15 (土) → その週の月曜は 08-10。2 週なら 08-03 が起点。
    const { kpi } = await getHarnessKpi(cache, now, { weeks: 2, timeZone: UTC });
    expect(kpi.rangeStart.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(kpi.rangeEnd).toBe(now);
  });

  it('aggregates tickets across projects and honours the project filter', async () => {
    const cache = createFakeBoardCache();
    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [
        makeTicket({
          id: 'bdboard-a1',
          projectId: '/a',
          labels: ['harness'],
          createdAt: utcInstant(2026, 8, 11),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });
    cache.putProject({
      project: project('/b', '/projects/b'),
      tickets: [
        makeTicket({
          id: 'bdboard-b1',
          projectId: '/b',
          createdAt: utcInstant(2026, 8, 12),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    expect((await getHarnessKpi(cache, now, { weeks: 2, timeZone: UTC })).kpi.harnessLabeled).toEqual({
      matchedCount: 1,
      totalCount: 2,
      rate: 0.5,
    });

    expect(
      (await getHarnessKpi(cache, now, { weeks: 2, timeZone: UTC, projectIds: ['/a'] })).kpi
        .harnessLabeled,
    ).toEqual({ matchedCount: 1, totalCount: 1, rate: 1 });
  });

  it('joins reclaim runs against the cached tickets and reports the record start', async () => {
    const cache = createFakeBoardCache();
    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [
        makeTicket({
          id: 'bdboard-a1',
          projectId: '/a',
          createdAt: utcInstant(2026, 8, 11),
          startedAt: utcInstant(2026, 8, 12, 0, 10),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reclaimSince = utcInstant(2026, 8, 12);
    const reclaimRuns: ReclaimRunRecord[] = [
      {
        projectId: '/a',
        at: utcInstant(2026, 8, 12),
        reclaimedCount: 1,
        ticketIds: ['bdboard-a1'],
      },
    ];

    const result = await getHarnessKpi(cache, now, {
      weeks: 2,
      timeZone: UTC,
      reclaimRuns,
      reclaimSince,
    });

    expect(result.reclaimSince).toBe(reclaimSince);
    expect(result.kpi.reclaim).toMatchObject({
      runCount: 1,
      reclaimedCountTotal: 1,
      identifiedTicketCount: 1,
      reclaimedThenInProgressCount: 1,
      reclaimedThenInProgressRate: 1,
    });
  });

  it('applies the project filter to reclaim runs as well as tickets', async () => {
    const cache = createFakeBoardCache();
    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [
        makeTicket({
          id: 'bdboard-a1',
          projectId: '/a',
          createdAt: utcInstant(2026, 8, 11),
          startedAt: utcInstant(2026, 8, 12, 0, 10),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });
    cache.putProject({
      project: project('/b', '/projects/b'),
      tickets: [
        makeTicket({
          id: 'bdboard-b1',
          projectId: '/b',
          createdAt: utcInstant(2026, 8, 11),
          startedAt: utcInstant(2026, 8, 12, 0, 10),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reclaimRuns: ReclaimRunRecord[] = [
      {
        projectId: '/a',
        at: utcInstant(2026, 8, 12),
        reclaimedCount: 1,
        ticketIds: ['bdboard-a1'],
      },
      {
        projectId: '/b',
        at: utcInstant(2026, 8, 12),
        reclaimedCount: 1,
        ticketIds: ['bdboard-b1'],
      },
    ];

    const options = { weeks: 2, timeZone: UTC, reclaimRuns } as const;

    expect((await getHarnessKpi(cache, now, options)).kpi.reclaim).toMatchObject({
      runCount: 2,
      identifiedTicketCount: 2,
    });

    // /a だけを選んだら /b の発火は発火回数にも母数にも入らない。
    expect(
      (await getHarnessKpi(cache, now, { ...options, projectIds: ['/a'] })).kpi.reclaim,
    ).toMatchObject({
      runCount: 1,
      reclaimedCountTotal: 1,
      identifiedTicketCount: 1,
    });
  });

  it('applies the project filter to leftoverCandidates as well', async () => {
    const cache = createFakeBoardCache();
    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [makeTicket({ id: 'bdboard-a1', projectId: '/a' })],
      fingerprint: 'fp',
      fetchedAt: now,
    });
    cache.putProject({
      project: project('/b', '/projects/b'),
      tickets: [makeTicket({ id: 'bdboard-b1', projectId: '/b' })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reclaimRuns: ReclaimRunRecord[] = [
      {
        projectId: '/a',
        at: utcInstant(2026, 8, 12),
        reclaimedCount: 1,
        ticketIds: ['bdboard-a1'],
      },
      {
        projectId: '/b',
        at: utcInstant(2026, 8, 12),
        reclaimedCount: 1,
        ticketIds: ['bdboard-b1'],
      },
    ];
    const leftoverCandidates = [
      {
        projectId: '/a',
        repoRootPath: '/projects/a',
        ticketId: 'bdboard-a1',
        worktreePath: '/projects/a/.claude/worktrees/bdboard-a1',
        branchName: null,
      },
      {
        projectId: '/b',
        repoRootPath: '/projects/b',
        ticketId: 'bdboard-b1',
        worktreePath: '/projects/b/.claude/worktrees/bdboard-b1',
        branchName: null,
      },
    ];

    const options = { weeks: 2, timeZone: UTC, reclaimRuns, leftoverCandidates } as const;

    expect((await getHarnessKpi(cache, now, options)).kpi.reclaim).toMatchObject({
      reclaimedLiveWorktreeCount: 2,
    });

    // /a だけを選んだら /b の worktree は母数にも件数にも入らない。
    expect(
      (await getHarnessKpi(cache, now, { ...options, projectIds: ['/a'] })).kpi.reclaim,
    ).toMatchObject({
      reclaimedLiveWorktreeCount: 1,
    });
  });

  it('passes the unparsed run count through untouched', async () => {
    const cache = createFakeBoardCache();

    expect((await getHarnessKpi(cache, now, { timeZone: UTC })).reclaimUnparsedRunCount).toBe(0);
    expect(
      (await getHarnessKpi(cache, now, { timeZone: UTC, reclaimUnparsedRunCount: 4 }))
        .reclaimUnparsedRunCount,
    ).toBe(4);
  });

  it('clamps weeks to at least one', async () => {
    const cache = createFakeBoardCache();
    const { kpi } = await getHarnessKpi(cache, now, { weeks: 0, timeZone: UTC });
    expect(kpi.rangeStart.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  // bdboard-4x55: listProjects() は全チケット JSON をデシリアライズする同期処理なので、
  // listProjectsChunked() があるキャッシュ (SQLite) ではそちらを使い、同期版を
  // 呼ばないこと。戻り値はフォールバック (listProjects) 経路と同一。
  it('prefers listProjectsChunked() over listProjects() when the cache provides it', async () => {
    const base = createFakeBoardCache();
    base.putProject({
      project: project('/a', '/projects/a'),
      tickets: [
        makeTicket({
          id: 'bdboard-a1',
          projectId: '/a',
          labels: ['harness'],
          createdAt: utcInstant(2026, 8, 11),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });
    base.putProject({
      project: project('/b', '/projects/b'),
      tickets: [
        makeTicket({
          id: 'bdboard-b1',
          projectId: '/b',
          createdAt: utcInstant(2026, 8, 12),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const expected = await getHarnessKpi(base, now, { weeks: 2, timeZone: UTC });

    const listProjects = vi.fn(() => base.listProjects());
    const listProjectsChunked = vi.fn(() => Promise.resolve(base.listProjects()));
    const cache: BoardCache = { ...base, listProjects, listProjectsChunked };

    const stats = await getHarnessKpi(cache, now, { weeks: 2, timeZone: UTC });

    expect(listProjectsChunked).toHaveBeenCalledTimes(1);
    expect(listProjects).not.toHaveBeenCalled();
    expect(stats).toEqual(expected);
    expect(stats.kpi.harnessLabeled).toEqual({ matchedCount: 1, totalCount: 2, rate: 0.5 });

    // プロジェクト絞り込みは chunked 経路の結果にも掛かる。
    const filtered = await getHarnessKpi(cache, now, {
      weeks: 2,
      timeZone: UTC,
      projectIds: ['/a'],
    });
    expect(listProjects).not.toHaveBeenCalled();
    expect(filtered.kpi.harnessLabeled).toEqual({ matchedCount: 1, totalCount: 1, rate: 1 });
  });
});
