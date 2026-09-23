import { describe, expect, it } from 'vitest';
import { checkHygiene } from './hygiene.js';
import { NOW } from './hygiene-test-support.js';
import type { LeftoverCandidate } from './git-worktree.js';
import { makeTicket } from './test-support.js';

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
