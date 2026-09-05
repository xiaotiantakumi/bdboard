import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { ReclaimPlan } from '../../domain/reclaim-plan.js';
import type { LeaseReclaimer } from '../ports/lease-reclaimer.js';
import {
  createReclaimScheduler,
  DEFAULT_RECLAIM_INTERVAL_MS,
  DEFAULT_RECLAIM_OLDER_THAN,
  MIN_SAFE_RECLAIM_OLDER_THAN_MS,
  parseReclaimDurationMs,
} from './reclaim-scheduler.js';

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    aliasPaths: [],
    prefixes: ['bdboard'],
  };
}

describe('createReclaimScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs reclaim on interval and records per-project results', async () => {
    const reclaim = vi.fn(async (rootPath: string) => ({
      exitCode: 0,
      stdout: rootPath === '/projects/a' ? 'reclaimed 2 issues' : 'reclaimed 0 issues',
      stderr: '',
    }));
    const reclaimer: LeaseReclaimer = { reclaim };
    const projects = [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')];

    const scheduler = createReclaimScheduler({
      reclaimer,
      listProjects: () => projects,
      config: {
        enabled: true,
        intervalMs: 1_000,
        olderThan: DEFAULT_RECLAIM_OLDER_THAN,
      },
    });

    scheduler.start();
    // start() kicks off an immediate cycle (no timer involved) — flush only
    // microtasks here so the interval timer's cycle is not counted yet.
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaim).toHaveBeenCalledTimes(2);
    expect(reclaim).toHaveBeenCalledWith('/projects/a', DEFAULT_RECLAIM_OLDER_THAN);

    const status = scheduler.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.intervalMs).toBe(1_000);
    expect(status.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: 'proj-a',
          reclaimedCount: 2,
          reclaimedCountUnknown: false,
          lastError: null,
        }),
        expect.objectContaining({
          projectId: 'proj-b',
          reclaimedCount: 0,
          reclaimedCountUnknown: false,
        }),
      ]),
    );

    reclaim.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reclaim).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('skips overlapping cycles while a run is in progress', async () => {
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const reclaim = vi.fn(async () => {
      await first;
      return { exitCode: 0, stdout: 'reclaimed 0 issues', stderr: '' };
    });
    const reclaimer: LeaseReclaimer = { reclaim };

    const scheduler = createReclaimScheduler({
      reclaimer,
      listProjects: () => [project('proj-a', '/projects/a')],
      config: { enabled: true, intervalMs: 100, olderThan: '10m' },
    });

    scheduler.start();
    await vi.runOnlyPendingTimersAsync();
    expect(reclaim).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(reclaim).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(100);
    expect(reclaim.mock.calls.length).toBeGreaterThanOrEqual(2);

    scheduler.stop();
  });

  it('logs and continues when reclaim fails for one project', async () => {
    const logError = vi.fn();
    const reclaimer: LeaseReclaimer = {
      reclaim: vi.fn(async (rootPath: string) => {
        if (rootPath === '/projects/b') {
          return { exitCode: 1, stdout: '', stderr: 'lock contention' };
        }
        return { exitCode: 0, stdout: 'reclaimed 1 issue', stderr: '' };
      }),
    };

    const scheduler = createReclaimScheduler({
      reclaimer,
      listProjects: () => [
        project('proj-a', '/projects/a'),
        project('proj-b', '/projects/b'),
      ],
      config: { enabled: true, intervalMs: DEFAULT_RECLAIM_INTERVAL_MS, olderThan: '10m' },
      logError,
    });

    scheduler.start();
    await vi.runOnlyPendingTimersAsync();

    const status = scheduler.getStatus();
    expect(status.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'proj-a', reclaimedCount: 1, lastError: null }),
        expect.objectContaining({
          projectId: 'proj-b',
          reclaimedCount: null,
          reclaimedCountUnknown: true,
          lastError: expect.stringContaining('exit=1'),
        }),
      ]),
    );
    expect(logError).toHaveBeenCalled();

    scheduler.stop();
  });

  it('does not start when disabled', async () => {
    const reclaim = vi.fn();
    const scheduler = createReclaimScheduler({
      reclaimer: { reclaim },
      listProjects: () => [project('proj-a', '/projects/a')],
      config: { enabled: false, intervalMs: 100, olderThan: '10m' },
    });

    scheduler.start();
    await vi.runOnlyPendingTimersAsync();
    expect(reclaim).not.toHaveBeenCalled();
    expect(scheduler.getStatus().enabled).toBe(false);
  });

  it('limits project reclaim concurrency to the configured maximum', async () => {
    const projects = Array.from({ length: 8 }, (_, index) =>
      project(`proj-${index}`, `/projects/${index}`),
    );

    let activeCount = 0;
    let maxObserved = 0;
    const resolvers: Array<() => void> = [];

    const reclaim = vi.fn((_rootPath: string) => {
      return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
        activeCount += 1;
        maxObserved = Math.max(maxObserved, activeCount);
        resolvers.push(() => {
          activeCount -= 1;
          resolve({ exitCode: 0, stdout: 'reclaimed 0 issues', stderr: '' });
        });
      });
    });

    const scheduler = createReclaimScheduler({
      reclaimer: { reclaim },
      listProjects: () => projects,
      config: { enabled: true, intervalMs: 1_000, olderThan: '10m' },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaim).toHaveBeenCalledTimes(3);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1);

    while (resolvers.length > 0) {
      resolvers.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(reclaim).toHaveBeenCalledTimes(8);
    expect(maxObserved).toBeLessThanOrEqual(3);

    scheduler.stop();
  });

  it('parses unknown reclaim output as count unknown', async () => {
    const reclaimer: LeaseReclaimer = {
      reclaim: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'all done',
        stderr: '',
      })),
    };

    const scheduler = createReclaimScheduler({
      reclaimer,
      listProjects: () => [project('proj-a', '/projects/a')],
      config: { enabled: true, intervalMs: 100, olderThan: '10m' },
    });

    scheduler.start();
    await vi.runOnlyPendingTimersAsync();

    expect(scheduler.getStatus().projects[0]).toMatchObject({
      reclaimedCount: null,
      reclaimedCountUnknown: true,
      rawSummary: 'all done',
    });

    scheduler.stop();
  });

  it('notifies the observer with the parsed count and ticket ids of each run', async () => {
    const reclaimer: LeaseReclaimer = {
      reclaim: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'Reclaimed 1 issue:\n  bdboard-a',
        stderr: '',
      })),
    };
    const observer = vi.fn();

    const scheduler = createReclaimScheduler({
      reclaimer,
      listProjects: () => [project('proj-a', '/projects/a')],
      config: { enabled: true, intervalMs: 100, olderThan: '10m' },
      observer,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-a',
        reclaimedCount: 1,
        ticketIds: ['bdboard-a'],
      }),
    );
    expect(observer.mock.calls[0]?.[0]?.at).toBeInstanceOf(Date);

    scheduler.stop();
  });

  it('does not notify the observer when the reclaim run fails', async () => {
    const reclaimer: LeaseReclaimer = {
      reclaim: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'boom',
      })),
    };
    const observer = vi.fn();

    const scheduler = createReclaimScheduler({
      reclaimer,
      listProjects: () => [project('proj-a', '/projects/a')],
      config: { enabled: true, intervalMs: 100, olderThan: '10m' },
      logError: () => {},
      observer,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(observer).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('keeps scanning when the observer throws', async () => {
    const reclaim = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'reclaimed 1 issue',
      stderr: '',
    }));
    const logError = vi.fn();

    const scheduler = createReclaimScheduler({
      reclaimer: { reclaim },
      listProjects: () => [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      config: { enabled: true, intervalMs: 100, olderThan: '10m' },
      logError,
      observer: () => {
        throw new Error('observer exploded');
      },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaim).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('Reclaim observer failed'),
    );
    // 観測の失敗は per-project の状態に影響しない
    expect(scheduler.getStatus().projects[0]).toMatchObject({
      reclaimedCount: 1,
      lastError: null,
    });

    scheduler.stop();
  });
});

describe('createReclaimScheduler の planner (bdboard-6aci)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function scheduler(
    reclaim: ReturnType<typeof vi.fn>,
    planner: (project: Project) => Promise<ReclaimPlan | null>,
  ) {
    return createReclaimScheduler({
      reclaimer: { reclaim } as unknown as LeaseReclaimer,
      listProjects: () => [project('proj-a', '/projects/a')],
      config: { enabled: true, intervalMs: 1_000, olderThan: '2h' },
      planner,
    });
  }

  it('narrows the reclaim to the planned ids', async () => {
    const reclaim = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'reclaimed 1 issue',
      stderr: '',
    }));

    const s = scheduler(reclaim, async () => ({
      reclaimTicketIds: ['bdboard-dead'],
      protectedTicketIds: ['bdboard-live'],
    }));
    s.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaim).toHaveBeenCalledWith('/projects/a', '2h', ['bdboard-dead']);
    expect(s.getStatus().projects[0]?.rawSummary).toContain('protected 1');
    s.stop();
  });

  // **これが 6aci の本体。** `--id` を1つも付けない reclaim は全件対象なので、
  // 「回収してよいものが無い」を bd 呼び出しで表現することはできない。
  it('does NOT call bd at all when every candidate is protected', async () => {
    const reclaim = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const s = scheduler(reclaim, async () => ({
      reclaimTicketIds: [],
      protectedTicketIds: ['bdboard-live'],
    }));
    s.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaim).not.toHaveBeenCalled();
    const status = s.getStatus().projects[0];
    expect(status?.reclaimedCount).toBe(0);
    expect(status?.rawSummary).toContain('protected 1');
    expect(status?.lastError).toBeNull();
    s.stop();
  });

  // 判断材料が無いときに全件回収へ落ちないこと。落ちると 2026-09-05 の事故に戻る。
  it('skips the project entirely when the planner returns null', async () => {
    const reclaim = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const s = scheduler(reclaim, async () => null);
    s.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaim).not.toHaveBeenCalled();
    expect(s.getStatus().projects[0]?.rawSummary).toContain('skipped');
    s.stop();
  });

  it('keeps the old whole-project behaviour when no planner is wired', async () => {
    const reclaim = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'reclaimed 0 issues',
      stderr: '',
    }));

    const s = createReclaimScheduler({
      reclaimer: { reclaim } as unknown as LeaseReclaimer,
      listProjects: () => [project('proj-a', '/projects/a')],
      config: { enabled: true, intervalMs: 1_000, olderThan: '2h' },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(reclaim).toHaveBeenCalledWith('/projects/a', '2h');
    s.stop();
  });
});

describe('parseReclaimDurationMs', () => {
  it('parses the bd duration forms the scheduler can be configured with', () => {
    expect(parseReclaimDurationMs('10m')).toBe(600_000);
    expect(parseReclaimDurationMs('2h')).toBe(7_200_000);
    expect(parseReclaimDurationMs('1h30m')).toBe(5_400_000);
    expect(parseReclaimDurationMs('90s')).toBe(90_000);
    // 前後の空白は env 由来でよく混ざるので許容する (値としては同じ)。
    expect(parseReclaimDurationMs('10m ')).toBe(600_000);
  });

  it('returns undefined for input it cannot fully account for', () => {
    // 部分一致で「検査できた」ことにすると、下の下限テストが黙って素通りする。
    expect(parseReclaimDurationMs('')).toBeUndefined();
    expect(parseReclaimDurationMs('2 hours')).toBeUndefined();
    expect(parseReclaimDurationMs('2d')).toBeUndefined();
    expect(parseReclaimDurationMs('abc')).toBeUndefined();
    expect(parseReclaimDurationMs('2h extra')).toBeUndefined();
    expect(parseReclaimDurationMs('x2h')).toBeUndefined();
  });
});

describe('DEFAULT_RECLAIM_OLDER_THAN の下限', () => {
  // bdboard-hybu の回帰ガード。DEFAULT_RECLAIM_OLDER_THAN を '10m' に戻すと落ちる。
  //
  // 2026-09-05 に生存セッションのチケット4件が作業中に回収された (claim から 15〜19 分後)。
  // 猶予窓は lease TTL の倍数ではなく「1チケットの実作業時間」を上回っている必要がある。
  // ここを緩めるのは、回収対象を生存証拠で絞る仕組み (bdboard-6aci) が入ってからにすること。
  it('は実作業時間を上回る (10m 相当へ戻すと落ちる)', () => {
    const ms = parseReclaimDurationMs(DEFAULT_RECLAIM_OLDER_THAN);
    expect(ms).toBeDefined();
    expect(ms as number).toBeGreaterThanOrEqual(MIN_SAFE_RECLAIM_OLDER_THAN_MS);
  });

  it('の下限そのものが、実測された被害時間 (19 分) より十分大きい', () => {
    const observedWorstCaseMs = 19 * 60_000;
    expect(MIN_SAFE_RECLAIM_OLDER_THAN_MS).toBeGreaterThan(observedWorstCaseMs * 2);
  });

  it('は README の env 表に載っている既定値と一致する', () => {
    // 既定を変えたのに README が 10m のまま、という乖離をここで落とす。
    const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));
    const row = readFileSync(readmePath, 'utf8')
      .split('\n')
      .find((line) => line.includes('BDBOARD_RECLAIM_OLDER_THAN'));
    expect(row).toBeDefined();
    expect(row as string).toContain(`\`${DEFAULT_RECLAIM_OLDER_THAN}\``);
  });
});
