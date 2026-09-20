import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { IssueRepository, ProjectTickets } from '../ports/issue-repository.js';
import type { ProjectDiscovery } from '../ports/project-discovery.js';
import type { ProjectFingerprinter } from '../ports/project-fingerprinter.js';
import { createBoardNotificationPublisher } from './board-notification-transitions.js';
import { createRefreshRunner } from './refresh-runner.js';
import type { WatchedProjectsSync } from './sync-watched-projects.js';

function project(id: string): Project {
  return { id, name: id, rootPath: `/repo/${id}`, prefixes: [id], aliasPaths: [] };
}

function createFakeCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();
  return {
    entries,
    getProject: (id) => entries.get(id),
    putProject: (entry) => entries.set(entry.project.id, entry),
    listProjects: () =>
      [...entries.values()].sort((a, b) => compareStrings(a.project.rootPath, b.project.rootPath)),
    deleteProject: (id) => entries.delete(id),
    clear: () => entries.clear(),
    getTranscriptOffset: () => undefined,
    setTranscriptOffset: () => {},
    addSessionUsage: () => {},
    getSessionUsage: () => [],
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close: () => {},
  };
}

/** discovery が空を返す既定の deps。1プロジェクトを "refreshed" にしたいテストだけ上書きする。 */
function createBaseDeps(overrides: {
  readonly projects?: readonly Project[];
  readonly ticketsByProjectId?: Readonly<Record<string, ProjectTickets>>;
} = {}) {
  const cache = createFakeCache();
  const projects = overrides.projects ?? [];

  const discovery: ProjectDiscovery = { discover: async () => projects };
  const fingerprinter: ProjectFingerprinter = {
    fingerprint: async (p) => `fp-${p.id}`,
  };
  const repository: IssueRepository = {
    listTickets: async (p) => ({ project: p, tickets: [] }),
    listAll: async (ps) => ({
      results: ps.map(
        (p) => overrides.ticketsByProjectId?.[p.id] ?? { project: p, tickets: [] },
      ),
      errors: [],
    }),
  };

  return { cache, discovery, fingerprinter, repository };
}

describe('createRefreshRunner (bdboard-sso1.9 move only)', () => {
  it('runs refreshProjects, reports the result via onResult, and skips board.changed when nothing changed', async () => {
    const { cache, discovery, fingerprinter, repository } = createBaseDeps();
    const onResult = vi.fn();
    const publishBoardChanged = vi.fn();
    const publishNotification = vi.fn();
    const runner = createRefreshRunner({
      cache,
      discovery,
      fingerprinter,
      repository,
      now: () => new Date('2026-01-01T00:00:00Z'),
      boardNotificationPublisher: createBoardNotificationPublisher(),
      publishBoardChanged,
      publishNotification,
      getWatchedProjectsSync: () => undefined,
      onResult,
    });

    await runner.run(true);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[0]).toEqual({
      refreshed: [],
      reused: [],
      removed: [],
      errors: [],
    });
    expect(publishBoardChanged).not.toHaveBeenCalled();
  });

  it('publishes board.changed when a project was actually refreshed', async () => {
    const { cache, discovery, fingerprinter, repository } = createBaseDeps({
      projects: [project('bdboard')],
    });
    const publishBoardChanged = vi.fn();
    const runner = createRefreshRunner({
      cache,
      discovery,
      fingerprinter,
      repository,
      now: () => new Date('2026-01-01T00:00:00Z'),
      boardNotificationPublisher: createBoardNotificationPublisher(),
      publishBoardChanged,
      publishNotification: vi.fn(),
      getWatchedProjectsSync: () => undefined,
      onResult: vi.fn(),
    });

    await runner.run(true);

    expect(publishBoardChanged).toHaveBeenCalledWith({
      refreshed: ['bdboard'],
      reused: [],
      removed: [],
    });
  });

  it('calls sync() on the watcher returned by getWatchedProjectsSync(), read lazily at call time', async () => {
    const { cache, discovery, fingerprinter, repository } = createBaseDeps();
    const sync = vi.fn(async () => true);
    let watcher: WatchedProjectsSync | undefined;
    const runner = createRefreshRunner({
      cache,
      discovery,
      fingerprinter,
      repository,
      now: () => new Date('2026-01-01T00:00:00Z'),
      boardNotificationPublisher: createBoardNotificationPublisher(),
      publishBoardChanged: vi.fn(),
      publishNotification: vi.fn(),
      getWatchedProjectsSync: () => watcher,
      onResult: vi.fn(),
    });

    // Not yet created when run() is defined (mirrors main.ts's late-bound closure).
    await runner.run();
    expect(sync).not.toHaveBeenCalled();

    watcher = { sync };
    await runner.run();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('swallows a watcher sync() rejection via onWatcherSyncError without failing run()', async () => {
    const { cache, discovery, fingerprinter, repository } = createBaseDeps();
    const onWatcherSyncError = vi.fn();
    const runner = createRefreshRunner({
      cache,
      discovery,
      fingerprinter,
      repository,
      now: () => new Date('2026-01-01T00:00:00Z'),
      boardNotificationPublisher: createBoardNotificationPublisher(),
      publishBoardChanged: vi.fn(),
      publishNotification: vi.fn(),
      getWatchedProjectsSync: () => ({
        sync: async () => {
          throw new Error('watch boom');
        },
      }),
      onResult: vi.fn(),
      onWatcherSyncError,
    });

    await expect(runner.run()).resolves.toBeUndefined();
    expect(onWatcherSyncError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('coalesces a run() request that arrives while one is already in flight, resolving the waiter after the merged cycle', async () => {
    const { cache, fingerprinter, repository } = createBaseDeps();
    const pendingResolvers: Array<() => void> = [];
    const gatedDiscovery: ProjectDiscovery = {
      discover: () =>
        new Promise((resolve) => {
          pendingResolvers.push(() => resolve([]));
        }),
    };
    const onResult = vi.fn();
    const runner = createRefreshRunner({
      cache,
      discovery: gatedDiscovery,
      fingerprinter,
      repository,
      now: () => new Date('2026-01-01T00:00:00Z'),
      boardNotificationPublisher: createBoardNotificationPublisher(),
      publishBoardChanged: vi.fn(),
      publishNotification: vi.fn(),
      getWatchedProjectsSync: () => undefined,
      onResult,
    });

    const first = runner.run(true);
    // Wait a tick so the first call is definitely inside refreshProjects (discovery gated).
    await Promise.resolve();
    const second = runner.run(true, ['only-me']);

    // Resolve cycle 1 (the initial request); this unblocks the inner loop, which then
    // sees the coalesced request from `second` and starts cycle 2, calling discover()
    // again (gated the same way) before either promise settles.
    expect(pendingResolvers).toHaveLength(1);
    pendingResolvers[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingResolvers).toHaveLength(2);
    pendingResolvers[1]?.();

    await first;
    await second;

    // First cycle (the initial request) + a second cycle for the coalesced request
    // that arrived mid-flight.
    expect(onResult).toHaveBeenCalledTimes(2);
  });
});
