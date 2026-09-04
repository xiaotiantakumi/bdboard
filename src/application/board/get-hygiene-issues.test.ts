import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from '../../domain/hygiene-thresholds.js';
import { pendingDecisionKey } from '../../domain/hygiene.js';
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
      pendingDecisions: [{ id: 'bdboard-waiting', kind: 'ticket', allowFreeform: true }],
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
    // 両方に居ると、確認待ちの集合を絞り込み前に集めた場合、A の確認待ちが
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
      pendingDecisions: [{ id: 'bdboard-dup', kind: 'ticket', allowFreeform: true }],
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

  it('keeps colliding ids apart when both projects are in scope', () => {
    // 上のテストは「衝突相手がスコープ外」の側しか守らない。HygienePanel は
    // 複数プロジェクト(や全件)を普通に要求するので、両方同時に入っている
    // こちらが実運用の形になる (fable レビュー指摘)。盤面は
    // humanLabeledIdsFromCache を entry ごとに作るため B は通常レーンに出るのに、
    // 健全性だけが B にも「確認待ちが放置されている」を出す、という食い違いを防ぐ。
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');
    const stale = new Date(NOW.getTime() - 10 * 24 * 60 * 60_000);

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-dup', projectId: a.id, updatedAt: stale })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
      pendingDecisions: [{ id: 'bdboard-dup', kind: 'ticket', allowFreeform: true }],
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-dup', projectId: b.id, updatedAt: stale })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
      // B 側は確認待ちではない。
    });

    const issues = getHygieneIssues(cache, NOW).filter(
      (issue) => issue.kind === 'stale_pending_decision',
    );

    expect(issues.map((issue) => issue.projectId)).toEqual([a.id]);
  });

  it('respects configured thresholds instead of defaults', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-stale',
          projectId: a.id,
          status: 'in_progress',
          startedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const strictThresholds = {
      ...DEFAULT_HYGIENE_THRESHOLDS,
      staleInProgressAfterMs: 24 * 60 * 60_000,
    };
    const relaxedThresholds = {
      ...DEFAULT_HYGIENE_THRESHOLDS,
      staleInProgressAfterMs: 3 * 24 * 60 * 60_000,
    };

    expect(
      getHygieneIssues(cache, NOW, { thresholds: strictThresholds }).map((issue) => issue.kind),
    ).toEqual(['stale_in_progress']);
    expect(
      getHygieneIssues(cache, NOW, { thresholds: relaxedThresholds }).map((issue) => issue.kind),
    ).toEqual([]);
  });

  it('passes closeEvidenceKeys through to checkHygiene', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const closedAt = new Date(NOW.getTime() - 60_000);

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-no-evidence',
          projectId: a.id,
          status: 'closed',
          closedAt,
          commentCount: 1,
        }),
        makeTicket({
          id: 'bdboard-with-evidence',
          projectId: a.id,
          status: 'closed',
          closedAt,
          commentCount: 2,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const withoutKeys = getHygieneIssues(cache, NOW).filter(
      (issue) => issue.kind === 'closed_without_evidence',
    );
    expect(withoutKeys.map((issue) => issue.ticketId).sort()).toEqual([
      'bdboard-no-evidence',
      'bdboard-with-evidence',
    ]);

    const evidenceKeys = new Set<string>([
      pendingDecisionKey(a.id, 'bdboard-with-evidence'),
    ]);
    const withKeys = getHygieneIssues(cache, NOW, { closeEvidenceKeys: evidenceKeys }).filter(
      (issue) => issue.kind === 'closed_without_evidence',
    );
    expect(withKeys.map((issue) => issue.ticketId)).toEqual(['bdboard-no-evidence']);
  });

  it('uses the specified timezone for overdue_defer deferUntil formatting', () => {
    const cache = createFakeBoardCache();
    const now = new Date('2026-08-10T00:00:00.000Z');
    const a = project('/a', '/projects/a', 'Alpha');
    const deferUntil = new Date('2026-08-09T15:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-boundary',
          projectId: a.id,
          status: 'deferred',
          deferUntil,
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    const utcIssue = getHygieneIssues(cache, now, { timeZone: 'UTC' }).find(
      (issue) => issue.kind === 'overdue_defer',
    );
    const tokyoIssue = getHygieneIssues(cache, now, { timeZone: 'Asia/Tokyo' }).find(
      (issue) => issue.kind === 'overdue_defer',
    );

    expect(utcIssue?.deferUntil).toBe('2026-08-09');
    expect(tokyoIssue?.deferUntil).toBe('2026-08-10');
  });
});
