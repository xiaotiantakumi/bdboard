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
});
