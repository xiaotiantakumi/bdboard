import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import {
  checkHygiene,
  DEFAULT_HYGIENE_THRESHOLDS,
  formatLocalDateKey,
  pendingDecisionKey,
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

function blocksEdge(issueId: string, dependsOnId: string): DependencyEdge {
  return { issueId, dependsOnId, kind: 'blocks' };
}

function parentChildEdge(issueId: string, dependsOnId: string): DependencyEdge {
  return { issueId, dependsOnId, kind: 'parent-child' };
}

function dependencyCycleIssues(tickets: readonly Ticket[]) {
  return checkHygiene(tickets, { now: NOW }).filter(
    (issue) => issue.kind === 'dependency_cycle',
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
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          staleInProgressAfterMs: 3 * 24 * 60 * 60_000,
        },
      }).map((issue) => issue.kind),
    ).toEqual([]);

    expect(
      checkHygiene([ticket], {
        now: NOW,
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          staleInProgressAfterMs: 24 * 60 * 60_000,
        },
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

describe('checkHygiene dependency_cycle', () => {
  it('flags a two-ticket blocks cycle', () => {
    const ticketA = makeTicket({
      id: 'bdboard-cycle-a',
      dependencies: [blocksEdge('bdboard-cycle-a', 'bdboard-cycle-b')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-cycle-b',
      dependencies: [blocksEdge('bdboard-cycle-b', 'bdboard-cycle-a')],
    });

    const issues = dependencyCycleIssues([ticketA, ticketB]);
    expect(issues).toHaveLength(1);

    const issue = issues[0]!;
    expect(issue.kind).toBe('dependency_cycle');
    expect(issue.cycleTicketIds).toEqual(['bdboard-cycle-a', 'bdboard-cycle-b']);
    expect(issue.cycleEdges).toEqual([
      { issueId: 'bdboard-cycle-a', dependsOnId: 'bdboard-cycle-b' },
      { issueId: 'bdboard-cycle-b', dependsOnId: 'bdboard-cycle-a' },
    ]);
    expect(issue.ticketId).toBe('bdboard-cycle-a');
  });

  it('flags a three-ticket blocks cycle', () => {
    const ticketA = makeTicket({
      id: 'bdboard-cycle3-a',
      dependencies: [blocksEdge('bdboard-cycle3-a', 'bdboard-cycle3-c')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-cycle3-b',
      dependencies: [blocksEdge('bdboard-cycle3-b', 'bdboard-cycle3-a')],
    });
    const ticketC = makeTicket({
      id: 'bdboard-cycle3-c',
      dependencies: [blocksEdge('bdboard-cycle3-c', 'bdboard-cycle3-b')],
    });

    const issues = dependencyCycleIssues([ticketA, ticketB, ticketC]);
    expect(issues).toHaveLength(1);

    const issue = issues[0]!;
    expect(issue.cycleTicketIds).toEqual([
      'bdboard-cycle3-a',
      'bdboard-cycle3-b',
      'bdboard-cycle3-c',
    ]);
    expect(issue.cycleEdges).toEqual([
      { issueId: 'bdboard-cycle3-a', dependsOnId: 'bdboard-cycle3-c' },
      { issueId: 'bdboard-cycle3-b', dependsOnId: 'bdboard-cycle3-a' },
      { issueId: 'bdboard-cycle3-c', dependsOnId: 'bdboard-cycle3-b' },
    ]);
  });

  it('does not flag acyclic blocks chains or diamonds', () => {
    const blocker = makeTicket({ id: 'bdboard-chain-a' });
    const middle = makeTicket({
      id: 'bdboard-chain-b',
      dependencies: [blocksEdge('bdboard-chain-b', 'bdboard-chain-a')],
    });
    const leaf = makeTicket({
      id: 'bdboard-chain-c',
      dependencies: [blocksEdge('bdboard-chain-c', 'bdboard-chain-b')],
    });

    expect(dependencyCycleIssues([blocker, middle, leaf])).toEqual([]);

    const diamondTop = makeTicket({ id: 'bdboard-diamond-top' });
    const diamondLeft = makeTicket({
      id: 'bdboard-diamond-left',
      dependencies: [blocksEdge('bdboard-diamond-left', 'bdboard-diamond-top')],
    });
    const diamondRight = makeTicket({
      id: 'bdboard-diamond-right',
      dependencies: [blocksEdge('bdboard-diamond-right', 'bdboard-diamond-top')],
    });
    const diamondBottom = makeTicket({
      id: 'bdboard-diamond-bottom',
      dependencies: [
        blocksEdge('bdboard-diamond-bottom', 'bdboard-diamond-left'),
        blocksEdge('bdboard-diamond-bottom', 'bdboard-diamond-right'),
      ],
    });

    expect(
      dependencyCycleIssues([
        diamondTop,
        diamondLeft,
        diamondRight,
        diamondBottom,
      ]),
    ).toEqual([]);
  });

  it('does not flag parent-child-only cycles', () => {
    const ticketA = makeTicket({
      id: 'bdboard-pc-a',
      dependencies: [parentChildEdge('bdboard-pc-a', 'bdboard-pc-b')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-pc-b',
      dependencies: [parentChildEdge('bdboard-pc-b', 'bdboard-pc-a')],
    });

    expect(dependencyCycleIssues([ticketA, ticketB])).toEqual([]);
  });

  it('reports independent cycles separately', () => {
    const cycle1A = makeTicket({
      id: 'bdboard-dual-1a',
      dependencies: [blocksEdge('bdboard-dual-1a', 'bdboard-dual-1b')],
    });
    const cycle1B = makeTicket({
      id: 'bdboard-dual-1b',
      dependencies: [blocksEdge('bdboard-dual-1b', 'bdboard-dual-1a')],
    });
    const cycle2A = makeTicket({
      id: 'bdboard-dual-2a',
      dependencies: [blocksEdge('bdboard-dual-2a', 'bdboard-dual-2b')],
    });
    const cycle2B = makeTicket({
      id: 'bdboard-dual-2b',
      dependencies: [blocksEdge('bdboard-dual-2b', 'bdboard-dual-2a')],
    });

    const issues = dependencyCycleIssues([cycle1A, cycle1B, cycle2A, cycle2B]);
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.cycleTicketIds)).toEqual([
      ['bdboard-dual-1a', 'bdboard-dual-1b'],
      ['bdboard-dual-2a', 'bdboard-dual-2b'],
    ]);
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

describe('checkHygiene stale_pending_decision (bdboard-ijk1)', () => {
  const PENDING_MS = DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs;

  /** makeTicket の既定 projectId。 */
  const PROJECT = '/projects/bdboard';

  function keys(...ids: readonly string[]): Set<string> {
    return new Set(ids.map((id) => pendingDecisionKey(PROJECT, id)));
  }

  function pendingIssues(
    tickets: readonly Ticket[],
    pendingIds: readonly string[],
  ) {
    return checkHygiene(tickets, {
      now: NOW,
      pendingDecisionKeys: keys(...pendingIds),
    }).filter((issue) => issue.kind === 'stale_pending_decision');
  }

  it('flags a pending ticket that has not moved for the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - PENDING_MS),
    });

    const issues = pendingIssues([ticket], ['bdboard-waiting']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe('確認待ちのまま 3 日以上動きがありません');
    expect(issues[0]?.severity).toBe('warning');
  });

  it('stays quiet one millisecond before the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - PENDING_MS + 1),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])).toEqual([]);
  });

  it('reports the elapsed days rather than the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 16 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])[0]?.message).toBe(
      '確認待ちのまま 16 日以上動きがありません',
    );
  });

  it('ignores tickets that are not awaiting a human decision', () => {
    // 同じだけ放置されていても、human ラベルが無ければ確認待ちではない。
    const ticket = makeTicket({
      id: 'bdboard-quiet',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], [])).toEqual([]);
  });

  it('emits nothing when the caller passes no pending set at all', () => {
    // ドメインは Ticket からは確認待ちを判定できない。呼び出し側が集めて渡さない
    // 限り、この検知は黙っていなければならない (誤検知の方が害が大きい)。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    expect(
      checkHygiene([ticket], { now: NOW }).map((issue) => issue.kind),
    ).not.toContain('stale_pending_decision');
  });

  it('ignores closed tickets that still carry the human label', () => {
    // deriveLane も closed を done で上書きする (ラベル外し忘れの保険)。盤面で
    // done のカードを健全性だけが「確認待ちが放置」と言うのは矛盾になる。
    const ticket = makeTicket({
      id: 'bdboard-done',
      status: 'closed',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], ['bdboard-done'])).toEqual([]);
  });

  it('honours a custom threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
    });

    expect(
      checkHygiene([ticket], {
        now: NOW,
        pendingDecisionKeys: keys('bdboard-waiting'),
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          stalePendingDecisionAfterMs: 5 * 24 * 60 * 60_000,
        },
      }),
    ).toEqual([]);

    expect(
      checkHygiene([ticket], {
        now: NOW,
        pendingDecisionKeys: keys('bdboard-waiting'),
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          stalePendingDecisionAfterMs: 24 * 60 * 60_000,
        },
      }).map((issue) => issue.kind),
    ).toEqual(['stale_pending_decision']);
  });

  it('defaults to three days', () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs).toBe(
      3 * 24 * 60 * 60_000,
    );
  });

  it('sorts after unblocked_high_priority_idle and before merged_leftover', () => {
    // KIND_ORDER に足し忘れると indexOf が -1 になり、先頭へ回って並びが崩れる。
    const idle = makeTicket({
      id: 'bdboard-idle',
      status: 'open',
      priority: 0,
      dependencies: [blocksEdge('bdboard-idle', 'bdboard-donedep')],
    });
    const doneDep = makeTicket({ id: 'bdboard-donedep', status: 'closed' });
    const waiting = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - PENDING_MS),
    });

    const kinds = checkHygiene([idle, doneDep, waiting], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
    })
      .map((issue) => issue.kind)
      .filter(
        (kind) =>
          kind === 'unblocked_high_priority_idle' ||
          kind === 'stale_pending_decision',
      );

    expect(kinds).toEqual([
      'unblocked_high_priority_idle',
      'stale_pending_decision',
    ]);
  });

  it('floors a fractional elapsed span instead of rounding it up', () => {
    // 文言が「N 日以上」なので、切り上げ/四捨五入だと嘘になる (3.5日で「4日以上」)。
    // 既存のテストが 3.000日 / 16.000日 ちょうどしか見ていないと、
    // Math.floor -> Math.ceil の変異が生き残る (fable レビュー指摘)。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 3.5 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])[0]?.message).toBe(
      '確認待ちのまま 3 日以上動きがありません',
    );
  });

  it('stays quiet when updatedAt is not a usable date', () => {
    // 壊れた日付でガードを外すと NaN < threshold が false になって検知側へ抜け、
    // 「確認待ちのまま NaN 日以上動きがありません」を出してしまう。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date('not a date'),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])).toEqual([]);
  });

  it('does not borrow another project\'s pending decision for the same id', () => {
    // bd のIDはプロジェクト内でしか一意でない。盤面は
    // humanLabeledIdsFromCache を entry ごとに作る (get-board.ts) ので、
    // 確認待ち判定は常にプロジェクト内で閉じている。ここが projectId を見ないと、
    // 2プロジェクトが同時にスコープへ入った瞬間、盤面では通常レーンのカードに
    // 「確認待ちが放置されている」が付く。
    const stale = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
    const inA = makeTicket({
      id: 'bdboard-dup',
      projectId: '/projects/a',
      status: 'open',
      updatedAt: stale,
    });
    const inB = makeTicket({
      id: 'bdboard-dup',
      projectId: '/projects/b',
      status: 'open',
      updatedAt: stale,
    });

    const issues = checkHygiene([inA, inB], {
      now: NOW,
      pendingDecisionKeys: new Set([
        pendingDecisionKey('/projects/a', 'bdboard-dup'),
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues.map((issue) => issue.projectId)).toEqual(['/projects/a']);
  });

  it('replaces stale_in_progress rather than doubling up on it', () => {
    // deriveLane は human ラベルを in_progress より優先する
    // (src/domain/readiness.ts)。盤面が確認待ちに置いているカードに対して
    // 「長期 in_progress」も出すと、盤面に無いレーンの話をしたうえで
    // 同じ放置を2行叱ることになる。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'in_progress',
      startedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const kinds = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
    }).map((issue) => issue.kind);

    expect(kinds).toContain('stale_pending_decision');
    expect(kinds).not.toContain('stale_in_progress');
  });

  it('still reports stale_in_progress when the ticket is not awaiting a human', () => {
    // 上の除外が「in_progress の検知そのものを殺した」になっていないことの確認。
    const ticket = makeTicket({
      id: 'bdboard-working',
      status: 'in_progress',
      startedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const kinds = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-someone-else'),
    }).map((issue) => issue.kind);

    expect(kinds).toContain('stale_in_progress');
  });
});
