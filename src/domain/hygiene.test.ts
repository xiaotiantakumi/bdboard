import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import {
  checkHygiene,
  formatLocalDateKey,
  needsCloseEvidenceLookup,
  pendingDecisionKey,
} from './hygiene.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';
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

  it('formats using the specified IANA timezone regardless of host TZ', () => {
    const instant = new Date('2026-08-09T15:00:00Z');
    expect(formatLocalDateKey(instant, 'UTC')).toBe('2026-08-09');
    expect(formatLocalDateKey(instant, 'Asia/Tokyo')).toBe('2026-08-10');
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

    expect(
      issuesFor('bdboard-epic', [epic, child]).filter(
        (issue) => issue.kind === 'stale_epic',
      ),
    ).toEqual([]);
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

  it('defaults stale pending decision to three days', () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs).toBe(
      3 * 24 * 60 * 60_000,
    );
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

    const leftovers = issues.filter((issue) => issue.kind === 'merged_leftover');
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatchObject({
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

    const leftovers = issues.filter((issue) => issue.kind === 'merged_leftover');
    expect(leftovers[0]?.message).toBe('チケットは closed ですがブランチが残っています');
    expect(leftovers[0]?.cleanup).toEqual({
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

    const leftovers = issues.filter((issue) => issue.kind === 'merged_leftover');
    expect(leftovers[0]?.message).toBe('チケットは closed ですが worktree が残っています');
    expect(leftovers[0]?.cleanup).toEqual({
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

  it('uses the last comment instead of updatedAt when the comment is newer', () => {
    // bd の updated_at はコメントで動かない (bdboard-19db)。updatedAt だけを見ると、
    // コメントで議論が続いているチケットまで「放置」として出る。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date(NOW.getTime() - 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues).toEqual([]);
  });

  it('keeps flagging when the last comment is itself old enough', () => {
    // コメントを見るようにしたせいで検知が死んでいないことの確認。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date(NOW.getTime() - 5 * 24 * 60 * 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    // 日数はコメント側から数える。30日ではなく5日。
    expect(issues[0]?.message).toBe('確認待ちのまま 5 日以上動きがありません');
  });

  it('keeps updatedAt when it is the newer of the two', () => {
    // コメントのほうが古いのは普通にある (コメント後に優先度を変えた等)。
    // 決め打ちで置き換えると、逆に検知が早まる方向の誤りになる。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 4 * 24 * 60 * 60_000),
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date(NOW.getTime() - 20 * 24 * 60 * 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues[0]?.message).toBe('確認待ちのまま 4 日以上動きがありません');
  });

  it('falls back to updatedAt when the anchor is unusable or missing', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 9 * 24 * 60 * 60_000),
    });

    const withBadAnchor = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date('not a date')],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(withBadAnchor[0]?.message).toBe('確認待ちのまま 9 日以上動きがありません');
    expect(pendingIssues([ticket], ['bdboard-waiting'])[0]?.message).toBe(
      '確認待ちのまま 9 日以上動きがありません',
    );
  });

  it('does not let one project\'s comment anchor reach another project\'s ticket', () => {
    const stale = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
    const inA = makeTicket({ id: 'bdboard-dup', projectId: '/projects/a', updatedAt: stale });
    const inB = makeTicket({ id: 'bdboard-dup', projectId: '/projects/b', updatedAt: stale });

    const issues = checkHygiene([inA, inB], {
      now: NOW,
      pendingDecisionKeys: new Set([
        pendingDecisionKey('/projects/a', 'bdboard-dup'),
        pendingDecisionKey('/projects/b', 'bdboard-dup'),
      ]),
      // A にだけ新しいコメントがある。B は放置のまま出るべき。
      pendingCommentAnchors: new Map([
        [pendingDecisionKey('/projects/a', 'bdboard-dup'), new Date(NOW.getTime() - 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues.map((issue) => issue.projectId)).toEqual(['/projects/b']);
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

describe('checkHygiene in_flight_file_overlap', () => {
  const projectId = '/projects/bdboard';

  function overlap(
    ticketIds: readonly [string, string],
    files: readonly string[],
  ) {
    return { projectId, ticketIds, files } as const;
  }

  it('emits one info issue on each side of the pair', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [overlap(['bdboard-a', 'bdboard-b'], ['src/domain/hygiene.ts'])],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.ticketId)).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
    for (const issue of issues) {
      expect(issue.severity).toBe('info');
      expect(issue.projectId).toBe(projectId);
    }
    expect(issues[0]!.message).toBe(
      '着手中の 1 件と同じファイルを編集中: bdboard-b: src/domain/hygiene.ts',
    );
    expect(issues[0]!.overlaps).toEqual([
      { otherTicketId: 'bdboard-b', files: ['src/domain/hygiene.ts'] },
    ]);
    expect(issues[1]!.overlaps).toEqual([
      { otherTicketId: 'bdboard-a', files: ['src/domain/hygiene.ts'] },
    ]);
  });

  it('lists at most five files and counts the rest', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
    ];
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [overlap(['bdboard-a', 'bdboard-b'], files)],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    expect(issues[0]!.message).toBe(
      '着手中の 1 件と同じファイルを編集中: bdboard-b: a.ts, b.ts, c.ts, d.ts, e.ts (+2)',
    );
    // メッセージは丸めるが、構造化データ側は全件残す (詳細パネルが使う)
    expect(issues[0]!.overlaps?.[0]?.files).toEqual(files);
  });

  it('skips a side whose ticket is unknown or belongs to another project', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-c', projectId: '/projects/other', status: 'in_progress' }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [
        overlap(['bdboard-a', 'bdboard-missing'], ['src/a.ts']),
        overlap(['bdboard-a', 'bdboard-c'], ['src/b.ts']),
      ],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    // bdboard-a は 2 件と重なるが行は 1 本。相手が居ない/別プロジェクトの側は出ない
    expect(
      issues.map((issue) => [
        issue.ticketId,
        issue.overlaps?.map((peer) => peer.otherTicketId),
      ]),
    ).toEqual([['bdboard-a', ['bdboard-c', 'bdboard-missing']]]);
  });

  it('folds several peers of one ticket into a single row', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-c', projectId, status: 'in_progress' }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [
        overlap(['bdboard-a', 'bdboard-b'], ['src/a.ts', 'src/b.ts']),
        overlap(['bdboard-a', 'bdboard-c'], ['src/a.ts']),
      ],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    // 3 チケットで 2 ペア -> 行は 3 本 (a が 1 本にまとまる)。
    // 行キーが kind + ticketId で一意であることの担保でもある。
    expect(issues.map((issue) => issue.ticketId)).toEqual([
      'bdboard-a',
      'bdboard-b',
      'bdboard-c',
    ]);
    expect(issues[0]!.message).toBe(
      '着手中の 2 件と同じファイルを編集中: bdboard-b: src/a.ts, src/b.ts; bdboard-c: src/a.ts',
    );
    expect(issues[0]!.overlaps).toEqual([
      { otherTicketId: 'bdboard-b', files: ['src/a.ts', 'src/b.ts'] },
      { otherTicketId: 'bdboard-c', files: ['src/a.ts'] },
    ]);
  });

  it('emits nothing when inFlightOverlaps is omitted', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
    ];

    expect(
      checkHygiene(tickets, { now: NOW }).filter(
        (issue) => issue.kind === 'in_flight_file_overlap',
      ),
    ).toEqual([]);
  });

  it('sorts after every other kind', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({
        id: 'bdboard-b',
        projectId,
        status: 'in_progress',
      }),
    ];

    const kinds = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [overlap(['bdboard-a', 'bdboard-b'], ['src/a.ts'])],
    }).map((issue) => issue.kind);

    expect(kinds.indexOf('in_flight_file_overlap')).toBeGreaterThan(
      kinds.indexOf('stale_in_progress'),
    );
  });
});

describe('checkHygiene closed_without_evidence', () => {
  const WINDOW_MS = DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs;

  /** makeTicket の既定 projectId。 */
  const PROJECT = '/projects/bdboard';

  function evidenceKeys(...ids: readonly string[]): Set<string> {
    return new Set(ids.map((id) => pendingDecisionKey(PROJECT, id)));
  }

  function closedWithoutEvidenceIssues(
    tickets: readonly Ticket[],
    options: {
      readonly closeEvidenceKeys?: ReadonlySet<string>;
      readonly closeEvidenceUnknownKeys?: ReadonlySet<string>;
      readonly closeEvidenceAvailable?: boolean;
      readonly thresholds?: typeof DEFAULT_HYGIENE_THRESHOLDS;
    } = {},
  ) {
    return checkHygiene(tickets, {
      now: NOW,
      closeEvidenceKeys: options.closeEvidenceKeys,
      closeEvidenceUnknownKeys: options.closeEvidenceUnknownKeys,
      closeEvidenceAvailable: options.closeEvidenceAvailable,
      thresholds: options.thresholds,
    }).filter((issue) => issue.kind === 'closed_without_evidence');
  }

  it('flags recently closed tickets with no PR or verification record', () => {
    const ticket = makeTicket({
      id: 'bdboard-no-evidence',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });

    const issues = closedWithoutEvidenceIssues([ticket]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'closed_without_evidence',
      ticketId: 'bdboard-no-evidence',
      severity: 'info',
      message:
        'close 済みだが PR/検証の記録がない（close-template.md の書式でコメントを残す）',
    });
  });

  it('does not flag when closeEvidenceKeys contains the ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-with-comment',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });

    expect(
      closedWithoutEvidenceIssues([ticket], {
        closeEvidenceKeys: evidenceKeys('bdboard-with-comment'),
      }),
    ).toEqual([]);
  });

  it('does not flag when closeReason contains a PR number reference', () => {
    const ticket = makeTicket({
      id: 'bdboard-reason',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'Merged via #123',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag epic, gate, or gt:slot tickets', () => {
    const epic = makeTicket({
      id: 'bdboard-epic',
      issueType: 'epic',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });
    const gate = makeTicket({
      id: 'bdboard-gate',
      issueType: 'gate',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });
    const slot = makeTicket({
      id: 'bdboard-slot',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      labels: ['gt:slot'],
    });

    expect(closedWithoutEvidenceIssues([epic, gate, slot])).toEqual([]);
  });

  it('does not flag when closedAt is outside the window', () => {
    const ticket = makeTicket({
      id: 'bdboard-old',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS - 1),
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeReason mentions merge', () => {
    const ticket = makeTicket({
      id: 'bdboard-merge',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'Squash merge completed',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeReason contains マージ', () => {
    const ticket = makeTicket({
      id: 'bdboard-ja-merge',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'main にマージ済み',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeReason contains PR as a word', () => {
    const ticket = makeTicket({
      id: 'bdboard-pr',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'Closed after PR review',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('flags when closeReason only mentions PR inside another word', () => {
    const ticket = makeTicket({
      id: 'bdboard-prep',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      closeReason: 'preparation complete',
    });

    expect(closedWithoutEvidenceIssues([ticket])).toHaveLength(1);
  });

  it('does not flag when closedAt is missing or invalid', () => {
    const noClosedAt = makeTicket({
      id: 'bdboard-no-date',
      status: 'closed',
    });
    const invalidClosedAt = makeTicket({
      id: 'bdboard-bad-date',
      status: 'closed',
      closedAt: new Date('not a date'),
    });

    expect(closedWithoutEvidenceIssues([noClosedAt, invalidClosedAt])).toEqual([]);
  });

  it('flags at exactly the window boundary', () => {
    const ticket = makeTicket({
      id: 'bdboard-boundary',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS),
    });

    expect(closedWithoutEvidenceIssues([ticket])).toHaveLength(1);
  });

  it('stays quiet one millisecond after the window', () => {
    const ticket = makeTicket({
      id: 'bdboard-just-outside',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS - 1),
    });

    expect(closedWithoutEvidenceIssues([ticket])).toEqual([]);
  });

  it('does not flag when closeEvidenceUnknownKeys contains the ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-unknown',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    expect(
      closedWithoutEvidenceIssues([ticket], {
        closeEvidenceUnknownKeys: evidenceKeys('bdboard-unknown'),
      }),
    ).toEqual([]);
  });

  it('does not flag when both unknown and evidence keys contain the ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-both',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    const keys = evidenceKeys('bdboard-both');
    expect(
      closedWithoutEvidenceIssues([ticket], {
        closeEvidenceKeys: keys,
        closeEvidenceUnknownKeys: keys,
      }),
    ).toEqual([]);
  });

  it('does not flag when closeEvidenceAvailable is false (m6)', () => {
    const ticket = makeTicket({
      id: 'bdboard-unavailable',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });

    expect(
      closedWithoutEvidenceIssues([ticket], { closeEvidenceAvailable: false }),
    ).toEqual([]);
  });
});

describe('needsCloseEvidenceLookup', () => {
  const WINDOW_MS = DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs;

  function lookup(
    ticket: Ticket,
    now: Date = NOW,
    windowMs: number = WINDOW_MS,
  ): boolean {
    return needsCloseEvidenceLookup(ticket, now, windowMs);
  }

  it('returns true for a closed ticket within window with comments and no closeReason evidence', () => {
    const ticket = makeTicket({
      id: 'bdboard-lookup',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    expect(lookup(ticket)).toBe(true);
  });

  it('returns false when status is not closed', () => {
    const ticket = makeTicket({
      id: 'bdboard-open',
      status: 'open',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });

    expect(lookup(ticket)).toBe(false);
  });

  it('returns false when closedAt is outside the window', () => {
    const ticket = makeTicket({
      id: 'bdboard-old',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - WINDOW_MS - 1),
      commentCount: 1,
    });

    expect(lookup(ticket)).toBe(false);
  });

  it('returns false when commentCount is zero', () => {
    const ticket = makeTicket({
      id: 'bdboard-no-comments',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 0,
    });

    expect(lookup(ticket)).toBe(false);
  });

  it('returns false for epic, gate, or gt:slot tickets', () => {
    const epic = makeTicket({
      id: 'bdboard-epic',
      issueType: 'epic',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });
    const gate = makeTicket({
      id: 'bdboard-gate',
      issueType: 'gate',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
    });
    const slot = makeTicket({
      id: 'bdboard-slot',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
      labels: ['gt:slot'],
    });

    expect(lookup(epic)).toBe(false);
    expect(lookup(gate)).toBe(false);
    expect(lookup(slot)).toBe(false);
  });

  it('returns false when closeReason contains a PR number reference', () => {
    const ticket = makeTicket({
      id: 'bdboard-reason',
      status: 'closed',
      closedAt: new Date(NOW.getTime() - 2 * 86_400_000),
      commentCount: 1,
      closeReason: 'Merged via #123',
    });

    expect(lookup(ticket)).toBe(false);
  });
});
