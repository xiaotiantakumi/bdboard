import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { LeaseReclaimer } from '../ports/lease-reclaimer.js';
import {
  createReclaimScheduler,
  DEFAULT_RECLAIM_INTERVAL_MS,
  DEFAULT_RECLAIM_OLDER_THAN,
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
