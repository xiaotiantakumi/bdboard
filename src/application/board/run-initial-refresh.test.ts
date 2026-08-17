import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import {
  BdError,
  type IssueRepository,
  type ProjectTickets,
} from '../ports/issue-repository.js';
import type { ProjectDiscovery } from '../ports/project-discovery.js';
import type { ProjectFingerprinter } from '../ports/project-fingerprinter.js';
import { runInitialRefresh } from './run-initial-refresh.js';

function project(
  id: string,
  rootPath: string,
  prefixes: readonly string[] = [],
): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes,
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

interface FakeRefreshDeps {
  readonly discovery: ProjectDiscovery;
  readonly repository: IssueRepository;
  readonly fingerprinter: ProjectFingerprinter;
  readonly cache: BoardCache & { readonly entries: Map<string, CachedProject> };
  readonly now: () => Date;
}

function createFakeDeps(options: {
  readonly projects: readonly Project[];
  readonly fingerprints?: Readonly<Record<string, string>>;
  readonly listTicketsImpl?: (
    project: Project,
  ) => Promise<ProjectTickets>;
  readonly now?: Date;
}): FakeRefreshDeps & { readonly listTicketsCalls: string[] } {
  const listTicketsCalls: string[] = [];
  const fingerprints = options.fingerprints ?? {};
  const now = options.now ?? new Date('2026-06-01T12:00:00.000Z');

  const discovery: ProjectDiscovery = {
    async discover(): Promise<readonly Project[]> {
      return options.projects;
    },
  };

  const fingerprinter: ProjectFingerprinter = {
    async fingerprint(p: Project): Promise<string> {
      return fingerprints[p.id] ?? `fp-${p.id}`;
    },
  };

  const repository: IssueRepository = {
    async listTickets(p: Project): Promise<ProjectTickets> {
      listTicketsCalls.push(p.id);
      if (options.listTicketsImpl !== undefined) {
        return options.listTicketsImpl(p);
      }
      return {
        project: { ...p, prefixes: ['bdboard'] },
        tickets: [makeTicket({ id: 'bdboard-1', projectId: p.id })],
      };
    },
    async listAll(): Promise<{
      readonly results: readonly ProjectTickets[];
      readonly errors: readonly BdError[];
    }> {
      return { results: [], errors: [] };
    },
  };

  return {
    discovery,
    repository,
    fingerprinter,
    cache: createFakeBoardCache(),
    now: () => now,
    listTicketsCalls,
  };
}

describe('runInitialRefresh', () => {
  it('does not force: reuses cache and never calls listTickets when fingerprints match', async () => {
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const deps = createFakeDeps({
      projects: [a, b],
      fingerprints: {
        [a.id]: 'fp-a',
        [b.id]: 'fp-b',
      },
    });

    deps.cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id })],
      fingerprint: 'fp-a',
      fetchedAt: deps.now(),
    });
    deps.cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id })],
      fingerprint: 'fp-b',
      fetchedAt: deps.now(),
    });

    const result = await runInitialRefresh(deps);

    expect(deps.listTicketsCalls).toHaveLength(0);
    expect(result.reused).toEqual([a.id, b.id]);
    expect(result.refreshed).toEqual([]);
  });

  it('still refreshes a project whose fingerprint changed', async () => {
    const unchanged = project('/unchanged', '/projects/unchanged');
    const changed = project('/changed', '/projects/changed');
    const deps = createFakeDeps({
      projects: [unchanged, changed],
      fingerprints: {
        [unchanged.id]: 'fp-unchanged',
        [changed.id]: 'fp-new',
      },
      listTicketsImpl: async (projectItem) => ({
        project: { ...projectItem, prefixes: ['bdboard'] },
        tickets: [makeTicket({ id: 'bdboard-new', projectId: projectItem.id })],
      }),
    });

    deps.cache.putProject({
      project: unchanged,
      tickets: [makeTicket({ id: 'bdboard-unchanged', projectId: unchanged.id })],
      fingerprint: 'fp-unchanged',
      fetchedAt: deps.now(),
    });
    deps.cache.putProject({
      project: changed,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: changed.id })],
      fingerprint: 'fp-old',
      fetchedAt: deps.now(),
    });

    const result = await runInitialRefresh(deps);

    expect(deps.listTicketsCalls).toEqual([changed.id]);
    expect(result.refreshed).toEqual([changed.id]);
    expect(result.reused).toEqual([unchanged.id]);
    expect(deps.cache.getProject(changed.id)?.fingerprint).toBe('fp-new');
    expect(deps.cache.getProject(changed.id)?.tickets[0]?.id).toBe('bdboard-new');
  });
});
