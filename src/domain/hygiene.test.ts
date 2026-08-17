import { describe, expect, it } from 'vitest';
import {
  checkHygiene,
  DEFAULT_HYGIENE_THRESHOLDS,
  formatLocalDateKey,
} from './hygiene.js';
import type { LeftoverCandidate } from './git-worktree.js';
import { makeTicket } from './test-support.js';
import type { Ticket } from './ticket.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const THRESHOLD_MS = DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs;
const STALE_ANCHOR = new Date(NOW.getTime() - THRESHOLD_MS);
const ALMOST_STALE_ANCHOR = new Date(NOW.getTime() - THRESHOLD_MS + 1);

function issueKinds(tickets: readonly Ticket[]) {
  return checkHygiene(tickets, { now: NOW }).map((issue) => issue.kind);
}

function issuesFor(ticketId: string, tickets: readonly Ticket[]) {
  return checkHygiene(tickets, { now: NOW }).filter(
    (issue) => issue.ticketId === ticketId,
  );
}

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
): Date {
  return new Date(year, month - 1, day, hour);
}

describe('formatLocalDateKey', () => {
  it('formats a locally constructed date as YYYY-MM-DD', () => {
    expect(formatLocalDateKey(localDate(2026, 8, 10))).toBe('2026-08-10');
    expect(formatLocalDateKey(localDate(2026, 1, 5))).toBe('2026-01-05');
  });

  it('uses local timezone rather than UTC when the instant crosses a calendar day', () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      // `bd defer --until=2026-08-10` in JST is stored as 2026-08-09T15:00:00Z.
      expect(formatLocalDateKey(new Date('2026-08-09T15:00:00Z'))).toBe(
        '2026-08-10',
      );
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });
});

describe('checkHygiene overdue_defer', () => {
  it('flags deferred tickets whose defer_until is in the past', () => {
    const deferUntil = localDate(2026, 5, 20, 9); // NOW(2026-06-01T12:00:00Z)より過去
    const ticket = makeTicket({
      id: 'bdboard-overdue',
      status: 'deferred',
      deferUntil,
    });

    expect(issueKinds([ticket])).toEqual(['overdue_defer']);
    const issue = issuesFor('bdboard-overdue', [ticket])[0];
    expect(issue?.deferUntil).toBe('2026-05-20');
  });

  it('does not flag deferred tickets with future defer_until', () => {
    const ticket = makeTicket({
      id: 'bdboard-future',
      status: 'deferred',
      deferUntil: new Date(NOW.getTime() + 60_000),
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('does not flag when defer_until is unset', () => {
    const ticket = makeTicket({
      id: 'bdboard-no-defer',
      status: 'deferred',
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('does not flag non-deferred tickets even if defer_until is past', () => {
    const ticket = makeTicket({
      id: 'bdboard-open-past',
      status: 'open',
      deferUntil: new Date(NOW.getTime() - 60_000),
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('flags at exactly defer_until boundary', () => {
    const ticket = makeTicket({
      id: 'bdboard-exact',
      status: 'deferred',
      deferUntil: NOW,
    });

    expect(issueKinds([ticket])).toEqual(['overdue_defer']);
  });
});

describe('checkHygiene deferUntil field', () => {
  it('does not set deferUntil on non-overdue_defer kinds', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });
    const missingPriority = makeTicket({
      id: 'bdboard-missing',
      priority: undefined as unknown as Ticket['priority'],
    });

    const issues = checkHygiene([epic, child, missingPriority], { now: NOW });
    for (const issue of issues) {
      expect(issue.deferUntil).toBeUndefined();
    }
  });
});

describe('checkHygiene stale_epic', () => {
  it('flags an open parent when all direct children are closed', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });

    expect(issueKinds([epic, child])).toContain('stale_epic');
    expect(issuesFor('bdboard-epic', [epic, child])[0]?.kind).toBe('stale_epic');
  });

  it('does not flag when some children remain open', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });
    const done = makeTicket({
      id: 'bdboard-done',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });
    const open = makeTicket({
      id: 'bdboard-open',
      parentId: 'bdboard-epic',
      status: 'open',
    });

    expect(issuesFor('bdboard-epic', [epic, done, open])).toEqual([]);
  });

  it('does not flag parents with zero children', () => {
    const epic = makeTicket({ id: 'bdboard-epic', status: 'open' });

    expect(issuesFor('bdboard-epic', [epic])).toEqual([]);
  });

  it('does not flag closed parents even when all children are closed', () => {
    const epic = makeTicket({
      id: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });
    const child = makeTicket({
      id: 'bdboard-child',
      parentId: 'bdboard-epic',
      status: 'closed',
      closedAt: NOW,
    });

    expect(issuesFor('bdboard-epic', [epic, child])).toEqual([]);
  });
});

describe('checkHygiene stale_in_progress', () => {
  it('flags in_progress tickets older than the default threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-stale',
      status: 'in_progress',
      startedAt: STALE_ANCHOR,
      updatedAt: NOW,
    });

    expect(issueKinds([ticket])).toEqual(['stale_in_progress']);
  });

  it('is false one millisecond before the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-almost',
      status: 'in_progress',
      startedAt: ALMOST_STALE_ANCHOR,
      updatedAt: NOW,
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('uses updatedAt when startedAt is missing', () => {
    const ticket = makeTicket({
      id: 'bdboard-updated',
      status: 'in_progress',
      updatedAt: STALE_ANCHOR,
    });

    expect(issueKinds([ticket])).toEqual(['stale_in_progress']);
  });

  it('does not flag open tickets', () => {
    const ticket = makeTicket({
      id: 'bdboard-open',
      status: 'open',
      updatedAt: STALE_ANCHOR,
    });

    expect(issueKinds([ticket])).toEqual([]);
  });

  it('respects custom thresholds', () => {
    const ticket = makeTicket({
      id: 'bdboard-custom',
      status: 'in_progress',
      startedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
    });

    expect(
      checkHygiene([ticket], {
        now: NOW,
        thresholds: { staleInProgressAfterMs: 3 * 24 * 60 * 60_000, highPriorityMax: 1 },
      }).map((issue) => issue.kind),
    ).toEqual([]);

    expect(
      checkHygiene([ticket], {
        now: NOW,
        thresholds: { staleInProgressAfterMs: 24 * 60 * 60_000, highPriorityMax: 1 },
      }).map((issue) => issue.kind),
    ).toEqual(['stale_in_progress']);
  });

  it('defaults to seven days', () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs).toBe(
      7 * 24 * 60 * 60_000,
    );
  });
});

describe('checkHygiene missing_priority', () => {
  it('flags tickets with undefined priority at runtime', () => {
    const ticket = {
      ...makeTicket({ id: 'bdboard-missing' }),
      priority: undefined as unknown as Ticket['priority'],
    } satisfies Ticket;

    expect(issueKinds([ticket])).toEqual(['missing_priority']);
  });

  it('flags tickets with invalid priority values', () => {
    const ticket = {
      ...makeTicket({ id: 'bdboard-invalid' }),
      priority: 9 as Ticket['priority'],
    } satisfies Ticket;

    expect(issueKinds([ticket])).toEqual(['missing_priority']);
  });

  it('does not flag valid priorities', () => {
    const ticket = makeTicket({ id: 'bdboard-ok', priority: 2 });

    expect(issueKinds([ticket])).toEqual([]);
  });
});

describe('checkHygiene unblocked_high_priority_idle', () => {
  it('flags ready high-priority tickets whose blockers are all closed', () => {
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'closed',
      closedAt: NOW,
    });
    const ticket = makeTicket({
      id: 'bdboard-ready',
      status: 'open',
      priority: 0,
      dependencies: [
        { issueId: 'bdboard-ready', dependsOnId: 'bdboard-blocker', kind: 'blocks' },
      ],
    });

    expect(issueKinds([blocker, ticket])).toContain('unblocked_high_priority_idle');
  });

  it('does not flag when an open blocker remains', () => {
    const blocker = makeTicket({ id: 'bdboard-blocker', status: 'open' });
    const ticket = makeTicket({
      id: 'bdboard-blocked',
      status: 'open',
      priority: 0,
      dependencies: [
        { issueId: 'bdboard-blocked', dependsOnId: 'bdboard-blocker', kind: 'blocks' },
      ],
    });

    expect(issuesFor('bdboard-blocked', [blocker, ticket])).toEqual([]);
  });

  it('does not flag low-priority tickets', () => {
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'closed',
      closedAt: NOW,
    });
    const ticket = makeTicket({
      id: 'bdboard-low',
      status: 'open',
      priority: 2,
      dependencies: [
        { issueId: 'bdboard-low', dependsOnId: 'bdboard-blocker', kind: 'blocks' },
      ],
    });

    expect(issuesFor('bdboard-low', [blocker, ticket])).toEqual([]);
  });

  it('does not flag tickets without blocking dependencies', () => {
    const ticket = makeTicket({
      id: 'bdboard-plain',
      status: 'open',
      priority: 0,
    });

    expect(issuesFor('bdboard-plain', [ticket])).toEqual([]);
  });

  it('does not flag in_progress tickets', () => {
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'closed',
      closedAt: NOW,
    });
    const ticket = makeTicket({
      id: 'bdboard-working',
      status: 'in_progress',
      priority: 0,
      updatedAt: NOW,
      startedAt: NOW,
      dependencies: [
        {
          issueId: 'bdboard-working',
          dependsOnId: 'bdboard-blocker',
          kind: 'blocks',
        },
      ],
    });

    expect(
      issuesFor('bdboard-working', [blocker, ticket]).filter(
        (issue) => issue.kind === 'unblocked_high_priority_idle',
      ),
    ).toEqual([]);
  });
});

describe('checkHygiene aggregation', () => {
  it('returns deterministic sorted issues across projects', () => {
    const a = makeTicket({
      id: 'bdboard-a',
      projectId: '/a',
      status: 'deferred',
      deferUntil: new Date(NOW.getTime() - 1),
    });
    const b = makeTicket({
      id: 'bdboard-b',
      projectId: '/b',
      priority: undefined as unknown as Ticket['priority'],
    });

    const first = checkHygiene([b, a], { now: NOW });
    const second = checkHygiene([a, b], { now: NOW });
    expect(second).toEqual(first);
  });
});

describe('checkHygiene merged_leftover', () => {
  const repoRoot = '/projects/bdboard';
  const worktreePath = `${repoRoot}/.claude/worktrees/bdboard-merged`;
  const branchName = 'bd/bdboard-merged';

  function leftoverCandidate(
    overrides: Partial<LeftoverCandidate> = {},
  ): LeftoverCandidate {
    return {
      projectId: repoRoot,
      repoRootPath: repoRoot,
      ticketId: 'bdboard-merged',
      worktreePath,
      branchName,
      ...overrides,
    };
  }

  it('flags closed tickets with leftover worktree and branch', () => {
    const ticket = makeTicket({
      id: 'bdboard-merged',
      projectId: repoRoot,
      status: 'closed',
      closedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [leftoverCandidate()],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'merged_leftover',
      ticketId: 'bdboard-merged',
      projectId: repoRoot,
      severity: 'warning',
      message: 'チケットは closed ですが worktree とブランチが残っています',
      cleanup: {
        repoRootPath: repoRoot,
        worktreePath,
        branchName,
      },
    });
  });

  it('does not flag open ticket worktrees (false positive prevention)', () => {
    const ticket = makeTicket({
      id: 'bdboard-merged',
      projectId: repoRoot,
      status: 'open',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [leftoverCandidate()],
    });

    expect(issues.filter((issue) => issue.kind === 'merged_leftover')).toEqual([]);
  });

  it('does not flag in_progress ticket worktrees (false positive prevention for active work)', () => {
    const ticket = makeTicket({
      id: 'bdboard-merged',
      projectId: repoRoot,
      status: 'in_progress',
      startedAt: NOW,
      updatedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [leftoverCandidate()],
    });

    expect(issues.filter((issue) => issue.kind === 'merged_leftover')).toEqual([]);
  });

  it('ignores candidates whose ticket id is unknown', () => {
    const issues = checkHygiene([], {
      now: NOW,
      leftoverCandidates: [leftoverCandidate({ ticketId: 'bdboard-unknown' })],
    });

    expect(issues).toEqual([]);
  });

  it('emits no merged_leftover when leftoverCandidates is omitted', () => {
    const ticket = makeTicket({
      id: 'bdboard-merged',
      projectId: repoRoot,
      status: 'closed',
      closedAt: NOW,
    });

    const issues = checkHygiene([ticket], { now: NOW });

    expect(issues.filter((issue) => issue.kind === 'merged_leftover')).toEqual([]);
  });

  it('uses branch-only message and cleanup when worktree is absent', () => {
    const ticket = makeTicket({
      id: 'bdboard-merged',
      projectId: repoRoot,
      status: 'closed',
      closedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [
        leftoverCandidate({ worktreePath: null, branchName: 'bd/bdboard-merged' }),
      ],
    });

    expect(issues[0]?.message).toBe('チケットは closed ですがブランチが残っています');
    expect(issues[0]?.cleanup).toEqual({
      repoRootPath: repoRoot,
      worktreePath: null,
      branchName: 'bd/bdboard-merged',
    });
  });

  it('uses worktree-only message and cleanup when branch is absent', () => {
    const ticket = makeTicket({
      id: 'bdboard-merged',
      projectId: repoRoot,
      status: 'closed',
      closedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [
        leftoverCandidate({ worktreePath, branchName: null }),
      ],
    });

    expect(issues[0]?.message).toBe('チケットは closed ですが worktree が残っています');
    expect(issues[0]?.cleanup).toEqual({
      repoRootPath: repoRoot,
      worktreePath,
      branchName: null,
    });
  });
});
