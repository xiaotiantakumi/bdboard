import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import type { HumanDecisionsPort } from '../ports/human-decisions.js';
import {
  BdError,
  type IssueRepository,
  type ProjectTickets,
} from '../ports/issue-repository.js';
import type { ProjectDiscovery } from '../ports/project-discovery.js';
import type { ProjectFingerprinter } from '../ports/project-fingerprinter.js';
import { refreshProjects } from './refresh-projects.js';

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
  readonly humanDecisions?: HumanDecisionsPort;
}

function createFakeDeps(options: {
  readonly projects: readonly Project[];
  readonly fingerprints?: Readonly<Record<string, string>>;
  readonly listTicketsImpl?: (
    project: Project,
  ) => Promise<ProjectTickets>;
  readonly fingerprintThrows?: Readonly<Record<string, unknown>>;
  readonly listTicketsThrows?: Readonly<Record<string, unknown>>;
  readonly humanDecisions?: HumanDecisionsPort;
  readonly now?: Date;
}): FakeRefreshDeps & {
  readonly listTicketsCalls: string[];
  readonly listPendingDecisionsCalls: string[];
} {
  const listTicketsCalls: string[] = [];
  const listPendingDecisionsCalls: string[] = [];
  const fingerprints = options.fingerprints ?? {};
  const now = options.now ?? new Date('2026-06-01T12:00:00.000Z');

  const discovery: ProjectDiscovery = {
    async discover(): Promise<readonly Project[]> {
      return options.projects;
    },
  };

  const fingerprinter: ProjectFingerprinter = {
    async fingerprint(p: Project): Promise<string> {
      if (options.fingerprintThrows?.[p.id] !== undefined) {
        throw options.fingerprintThrows[p.id];
      }
      return fingerprints[p.id] ?? `fp-${p.id}`;
    },
  };

  const repository: IssueRepository = {
    async listTickets(p: Project): Promise<ProjectTickets> {
      listTicketsCalls.push(p.id);
      if (options.listTicketsThrows?.[p.id] !== undefined) {
        throw options.listTicketsThrows[p.id];
      }
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

  const humanDecisions: HumanDecisionsPort | undefined =
    options.humanDecisions !== undefined
      ? {
          listPendingDecisions: async (rootPath: string) => {
            listPendingDecisionsCalls.push(rootPath);
            return options.humanDecisions!.listPendingDecisions(rootPath);
          },
          respond: options.humanDecisions.respond,
        }
      : undefined;

  return {
    discovery,
    repository,
    fingerprinter,
    cache: createFakeBoardCache(),
    now: () => now,
    ...(humanDecisions !== undefined ? { humanDecisions } : {}),
    listTicketsCalls,
    listPendingDecisionsCalls,
  };
}

describe('refreshProjects', () => {
  it('reuses cache when fingerprint matches and does not call listTickets', async () => {
    const p = project('/a', '/projects/a');
    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-stable' },
    });

    deps.cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: p.id })],
      fingerprint: 'fp-stable',
      fetchedAt: deps.now(),
    });

    const result = await refreshProjects(deps);

    expect(deps.listTicketsCalls).toHaveLength(0);
    expect(result.reused).toEqual([p.id]);
    expect(result.refreshed).toEqual([]);
    expect(deps.cache.getProject(p.id)?.tickets[0]?.id).toBe('bdboard-old');
  });

  it('refreshes cache when fingerprint changes', async () => {
    const p = project('/a', '/projects/a');
    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-new' },
      listTicketsImpl: async (projectItem) => ({
        project: { ...projectItem, prefixes: ['bdboard'] },
        tickets: [makeTicket({ id: 'bdboard-new', projectId: projectItem.id })],
      }),
    });

    deps.cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: p.id })],
      fingerprint: 'fp-old',
      fetchedAt: deps.now(),
    });

    const result = await refreshProjects(deps);

    expect(deps.listTicketsCalls).toEqual([p.id]);
    expect(result.refreshed).toEqual([p.id]);
    expect(result.reused).toEqual([]);
    expect(deps.cache.getProject(p.id)?.fingerprint).toBe('fp-new');
    expect(deps.cache.getProject(p.id)?.tickets[0]?.id).toBe('bdboard-new');
  });

  it('calls listTickets when force is true even if fingerprint matches', async () => {
    const p = project('/a', '/projects/a');
    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-stable' },
    });

    deps.cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: p.id })],
      fingerprint: 'fp-stable',
      fetchedAt: deps.now(),
    });

    const result = await refreshProjects(deps, { force: true });

    expect(deps.listTicketsCalls).toEqual([p.id]);
    expect(result.refreshed).toEqual([p.id]);
    expect(result.reused).toEqual([]);
  });

  it('refreshes all projects on first run with empty cache', async () => {
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const deps = createFakeDeps({ projects: [a, b] });

    const result = await refreshProjects(deps);

    expect(deps.listTicketsCalls.sort(compareStrings)).toEqual([a.id, b.id]);
    expect(result.refreshed).toEqual([a.id, b.id]);
    expect(result.reused).toEqual([]);
  });

  it('continues other projects when one throws BdError', async () => {
    const a = project('/a', '/projects/a');
    const b = project('/b', '/projects/b');
    const deps = createFakeDeps({
      projects: [a, b],
      listTicketsThrows: { [a.id]: new BdError('lock-contention', a.id, 'locked') },
    });

    const result = await refreshProjects(deps);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe('lock-contention');
    expect(result.errors[0]?.projectId).toBe(a.id);
    expect(result.refreshed).toEqual([b.id]);
    expect(result.reused).toEqual([]);
  });

  it('keeps existing cache for a project that failed to refresh', async () => {
    const p = project('/a', '/projects/a');
    const staleTicket = makeTicket({ id: 'bdboard-stale', projectId: p.id });
    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-new' },
      listTicketsThrows: { [p.id]: new Error('boom') },
    });

    deps.cache.putProject({
      project: p,
      tickets: [staleTicket],
      fingerprint: 'fp-old',
      fetchedAt: deps.now(),
    });

    const result = await refreshProjects(deps);

    expect(result.errors).toHaveLength(1);
    expect(result.refreshed).toEqual([]);
    expect(result.reused).toEqual([]);
    expect(deps.cache.getProject(p.id)?.tickets[0]?.id).toBe('bdboard-stale');
    expect(deps.cache.getProject(p.id)?.fingerprint).toBe('fp-old');
  });

  it('removes projects missing from discovery and clears cache entries', async () => {
    const kept = project('/kept', '/projects/kept');
    const removed = project('/gone', '/projects/gone');
    const deps = createFakeDeps({ projects: [kept] });

    deps.cache.putProject({
      project: removed,
      tickets: [makeTicket({ id: 'bdboard-gone', projectId: removed.id })],
      fingerprint: 'fp-gone',
      fetchedAt: deps.now(),
    });

    const result = await refreshProjects(deps);

    expect(result.removed).toEqual([removed.id]);
    expect(deps.cache.getProject(removed.id)).toBeUndefined();
    expect(deps.cache.getProject(kept.id)).toBeDefined();
  });

  it('stores listTickets project with filled prefixes in cache', async () => {
    const p = project('/a', '/projects/a', []);
    const deps = createFakeDeps({
      projects: [p],
      listTicketsImpl: async (projectItem) => ({
        project: { ...projectItem, prefixes: ['alpha', 'beta'] },
        tickets: [makeTicket({ id: 'bdboard-1', projectId: projectItem.id })],
      }),
    });

    await refreshProjects(deps);

    expect(deps.cache.getProject(p.id)?.project.prefixes).toEqual(['alpha', 'beta']);
  });

  it('returns refreshed, reused, and removed arrays in ascending order', async () => {
    const z = project('/z', '/projects/z');
    const a = project('/a', '/projects/a');
    const m = project('/m', '/projects/m');
    const gone = project('/gone', '/projects/gone');
    const deps = createFakeDeps({
      projects: [z, a, m],
      fingerprints: {
        [a.id]: 'fp-a',
        [m.id]: 'fp-m',
        [z.id]: 'fp-z',
      },
    });

    deps.cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id })],
      fingerprint: 'fp-a',
      fetchedAt: deps.now(),
    });
    deps.cache.putProject({
      project: gone,
      tickets: [makeTicket({ id: 'bdboard-gone', projectId: gone.id })],
      fingerprint: 'fp-gone',
      fetchedAt: deps.now(),
    });

    const result = await refreshProjects(deps);

    expect(result.reused).toEqual([a.id]);
    expect(result.refreshed).toEqual([m.id, z.id]);
    expect(result.removed).toEqual([gone.id]);
  });

  it('fetches pending decisions on fingerprint change and stores them in cache', async () => {
    const p = project('/a', '/projects/a');
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: async (_rootPath: string) => {
        return [{ id: 'bdboard-human', question: 'Q?', allowFreeform: true }];
      },
      respond: async () => {},
    };

    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-new' },
      humanDecisions,
    });

    deps.cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: p.id })],
      fingerprint: 'fp-old',
      fetchedAt: deps.now(),
    });

    const result = await refreshProjects(deps);

    expect(deps.listPendingDecisionsCalls).toEqual(['/projects/a']);
    expect(result.refreshed).toEqual([p.id]);
    expect(deps.cache.getProject(p.id)?.pendingDecisions).toEqual([
      { id: 'bdboard-human', question: 'Q?', allowFreeform: true },
    ]);
  });

  it('does not fetch pending decisions when fingerprint is unchanged (reused)', async () => {
    const p = project('/a', '/projects/a');
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: async () => [{ id: 'bdboard-human', allowFreeform: true }],
      respond: async () => {},
    };
    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-stable' },
      humanDecisions,
    });

    deps.cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: p.id })],
      fingerprint: 'fp-stable',
      fetchedAt: deps.now(),
      pendingDecisions: [{ id: 'bdboard-cached', allowFreeform: true }],
    });

    const result = await refreshProjects(deps);

    expect(deps.listPendingDecisionsCalls).toHaveLength(0);
    expect(result.reused).toEqual([p.id]);
    expect(deps.cache.getProject(p.id)?.pendingDecisions).toEqual([
      { id: 'bdboard-cached', allowFreeform: true },
    ]);
  });

  it('keeps cached pending decisions when listPendingDecisions throws', async () => {
    const p = project('/a', '/projects/a');
    const humanDecisions: HumanDecisionsPort = {
      listPendingDecisions: async () => {
        throw new BdError('unknown', p.id, 'boom');
      },
      respond: async () => {},
    };
    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-new' },
      humanDecisions,
    });

    deps.cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: p.id })],
      fingerprint: 'fp-old',
      fetchedAt: deps.now(),
      pendingDecisions: [{ id: 'bdboard-cached', allowFreeform: true }],
    });

    const result = await refreshProjects(deps);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.projectId).toBe(p.id);
    expect(result.refreshed).toEqual([p.id]);
    expect(deps.cache.getProject(p.id)?.pendingDecisions).toEqual([
      { id: 'bdboard-cached', allowFreeform: true },
    ]);
  });

  it('works without humanDecisions configured', async () => {
    const p = project('/a', '/projects/a');
    const deps = createFakeDeps({
      projects: [p],
      fingerprints: { [p.id]: 'fp-new' },
    });

    deps.cache.putProject({
      project: p,
      tickets: [makeTicket({ id: 'bdboard-old', projectId: p.id })],
      fingerprint: 'fp-old',
      fetchedAt: deps.now(),
      pendingDecisions: [{ id: 'bdboard-cached', allowFreeform: true }],
    });

    const result = await refreshProjects(deps);

    expect(result.refreshed).toEqual([p.id]);
    expect(deps.cache.getProject(p.id)?.pendingDecisions).toEqual([
      { id: 'bdboard-cached', allowFreeform: true },
    ]);
  });
});
