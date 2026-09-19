import { describe, expect, it } from 'vitest';
import {
  checkNonTicketHarnessWorktrees,
  type NonTicketHarnessWorktreeLag,
} from './non-ticket-harness-worktree.js';
import { STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND } from './hygiene.js';

function lag(overrides: Partial<NonTicketHarnessWorktreeLag> = {}): NonTicketHarnessWorktreeLag {
  return {
    projectId: 'proj-a',
    worktreePath: '/repo/.claude/worktrees/mac-slow-diagnosis-7ddee1',
    branchName: 'feature/mac-slow-diagnosis-7ddee1',
    commitsBehind: STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND,
    baseRef: 'origin/main',
    ...overrides,
  };
}

describe('checkNonTicketHarnessWorktrees', () => {
  it('warns once commitsBehind reaches the shared threshold', () => {
    const warnings = checkNonTicketHarnessWorktrees([lag()]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      projectId: 'proj-a',
      worktreePath: '/repo/.claude/worktrees/mac-slow-diagnosis-7ddee1',
      branchName: 'feature/mac-slow-diagnosis-7ddee1',
      commitsBehind: STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND,
      baseRef: 'origin/main',
    });
    expect(warnings[0]?.message).toContain('feature/mac-slow-diagnosis-7ddee1');
    expect(warnings[0]?.message).toContain('origin/main');
    expect(warnings[0]?.message).toContain(
      `git -C ${lag().worktreePath} rebase origin/main`,
    );
  });

  it('stays silent below the threshold', () => {
    const warnings = checkNonTicketHarnessWorktrees([
      lag({ commitsBehind: STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND - 1 }),
    ]);

    expect(warnings).toEqual([]);
  });

  it('has no ticketId field at all (this is not a HygieneIssue)', () => {
    const [warning] = checkNonTicketHarnessWorktrees([lag()]);

    expect(warning).not.toHaveProperty('ticketId');
    expect(warning).not.toHaveProperty('cleanup');
  });

  it('sorts by projectId then worktreePath', () => {
    const warnings = checkNonTicketHarnessWorktrees([
      lag({ projectId: 'proj-b', worktreePath: '/repo-b/wt/1' }),
      lag({ projectId: 'proj-a', worktreePath: '/repo-a/wt/z' }),
      lag({ projectId: 'proj-a', worktreePath: '/repo-a/wt/a' }),
    ]);

    expect(warnings.map((w) => `${w.projectId}:${w.worktreePath}`)).toEqual([
      'proj-a:/repo-a/wt/a',
      'proj-a:/repo-a/wt/z',
      'proj-b:/repo-b/wt/1',
    ]);
  });

  it('returns nothing for an empty input', () => {
    expect(checkNonTicketHarnessWorktrees([])).toEqual([]);
  });
});
