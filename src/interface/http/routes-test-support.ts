// bdboard-sso1.7: routes.test.ts の分割 (bdboard-sso1.1 のルートモジュール分割に追随)
// で複数のリソース別テストファイルから共有される、非テストのヘルパー/フィクスチャ置き場。
// 中身 (createDeps/createFakeBoardCache/seedCache/inFlightCache 等) は元の routes.test.ts
// から一字一句変更せず移動しただけ (move only)。export の付与とインデント調整のみ加えた。
import { vi, type Mock } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import { makeTicket } from '../../domain/test-support.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../../application/ports/board-cache-fakes.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import { createEventHub } from '../sse/event-hub.js';
import type { ApiDeps, ApiStatus } from './routes.js';

export const NOW = new Date('2026-06-01T12:00:00.000Z');

export const LOCAL_HOST = 'localhost:8787';

export const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};

export function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

export function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

export function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
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

export function seedCache(
  cache: BoardCache,
  items: readonly {
    readonly project: Project;
    readonly ticketId: string;
    readonly ticket?: Parameters<typeof makeTicket>[0];
  }[],
): void {
  for (const item of items) {
    cache.putProject({
      project: item.project,
      tickets: [
        makeTicket({
          id: item.ticketId,
          projectId: item.project.id,
          ...item.ticket,
        }),
      ],
      fingerprint: `fp-${item.project.id}`,
      fetchedAt: NOW,
    });
  }
}

export type RefreshMock = Mock<() => Promise<void>>;

export function createDeps(
  overrides: Partial<Omit<ApiDeps, 'refresh'>> & { refresh?: RefreshMock } = {},
): ApiDeps & { refresh: RefreshMock } {
  const cache = createFakeBoardCache();
  const events = createEventHub();
  const status: ApiStatus = {
    lastRefreshAt: NOW,
    errors: [],
    projectCount: 0,
  };
  const refresh: RefreshMock = overrides.refresh ?? vi.fn(async () => {});

  return {
    cache,
    applicationVersion: {
      getVersion: () => 'test-version',
    },
    now: () => NOW,
    getStatus: () => status,
    events,
    ...overrides,
    // Keep `refresh` after the spread so the declared Mock type is preserved.
    refresh,
  };
}

export function assertNoDates(value: unknown): void {
  if (value instanceof Date) {
    throw new Error('Found Date instance in JSON payload');
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoDates(item);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertNoDates((value as Record<string, unknown>)[key]);
    }
  }
}

export function inFlightScanner(
  filesByWorktree: Readonly<Record<string, readonly string[]>>,
): WorktreeScanner {
  return {
    scan: async () => ({
      worktrees: [
        { path: '/projects/a', branch: 'main', isMain: true },
        ...Object.keys(filesByWorktree).map((path) => ({
          path,
          branch: `bd/${path.slice(path.lastIndexOf('/') + 1)}`,
          isMain: false,
        })),
      ],
      bdBranches: Object.keys(filesByWorktree).map(
        (path) => `bd/${path.slice(path.lastIndexOf('/') + 1)}`,
      ),
      complete: true,
    }),
    listChangedFiles: async (worktreePath) => filesByWorktree[worktreePath] ?? [],
  };
}

export function inFlightCache() {
  const cache = createFakeBoardCache();
  const a = project('proj-a', '/projects/a');
  cache.putProject({
    project: a,
    tickets: [
      makeTicket({ id: 'bdboard-x', projectId: a.id, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-y', projectId: a.id, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-z', projectId: a.id, status: 'in_progress' }),
    ],
    fingerprint: 'fp-a',
    fetchedAt: NOW,
  });
  return { cache, projectId: a.id };
}

export const IN_FLIGHT_FILES = {
  '/projects/a/.claude/worktrees/bdboard-x': ['src/domain/hygiene.ts', 'src/x.ts'],
  '/projects/a/.claude/worktrees/bdboard-y': ['src/domain/hygiene.ts', 'src/y.ts'],
  '/projects/a/.claude/worktrees/bdboard-z': ['src/z.ts'],
} as const;
