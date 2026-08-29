import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { getHygieneIssues } from './get-hygiene-issues.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function project(id: string, rootPath: string, name?: string): Project {
  return {
    id,
    name: name ?? id,
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

describe('getHygieneIssues', () => {
  it('aggregates hygiene issues across projects', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-overdue',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date(NOW.getTime() - 1),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-missing',
          projectId: b.id,
          priority: undefined as never,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const issues = getHygieneIssues(cache, NOW);
    expect(issues.map((issue) => issue.kind).sort()).toEqual([
      'missing_priority',
      'overdue_defer',
    ]);
  });

  it('filters by projectIds and recalculates from remaining tickets', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-overdue',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date(NOW.getTime() - 1),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-missing',
          projectId: b.id,
          priority: undefined as never,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const filtered = getHygieneIssues(cache, NOW, { projectIds: [a.id] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe('overdue_defer');
    expect(filtered[0]?.projectId).toBe(a.id);
  });

  it('returns no issues when projectIds is an empty array', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-overdue',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date(NOW.getTime() - 1),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    expect(getHygieneIssues(cache, NOW, { projectIds: [] })).toEqual([]);
  });
  // bdboard-ijk1: 確認待ちは ticket.status ではなくキャッシュ上の
  // pendingDecisions 由来なので、ドメインではなくここが唯一の受け渡し口になる。
  it('feeds cached pending decisions into the stale_pending_decision check', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const stale = new Date(NOW.getTime() - 10 * 24 * 60 * 60_000);

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-waiting', projectId: a.id, updatedAt: stale }),
        makeTicket({ id: 'bdboard-quiet', projectId: a.id, updatedAt: stale }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [{ id: 'bdboard-waiting', allowFreeform: true }],
    });

    const issues = getHygieneIssues(cache, NOW).filter(
      (issue) => issue.kind === 'stale_pending_decision',
    );
    // 同じだけ放置されていても、確認待ちなのは片方だけ。
    expect(issues.map((issue) => issue.ticketId)).toEqual(['bdboard-waiting']);
  });

  it('emits no stale_pending_decision when the cache holds none', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-waiting',
          projectId: a.id,
          updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    expect(
      getHygieneIssues(cache, NOW).map((issue) => issue.kind),
    ).not.toContain('stale_pending_decision');
  });

  it('does not treat an out-of-scope pending decision as this project\'s', () => {
    // プロジェクトは prefix を共有しうる (どちらも 'bdboard')。同じIDのチケットが
    // 両方に居ると、pendingDecisionIds を絞り込み前に集めた場合、A の確認待ちが
    // B の同名チケットに化けて誤検知になる。集合を絞り込み後の entries から
    // 作っているのはそのため。
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');
    const stale = new Date(NOW.getTime() - 10 * 24 * 60 * 60_000);

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-dup', projectId: a.id, updatedAt: stale })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [{ id: 'bdboard-dup', allowFreeform: true }],
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-dup', projectId: b.id, updatedAt: stale })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
      // B 側は確認待ちではない。
    });

    const issues = getHygieneIssues(cache, NOW, { projectIds: [b.id] }).filter(
      (issue) => issue.kind === 'stale_pending_decision',
    );
    expect(issues).toEqual([]);
  });
});
