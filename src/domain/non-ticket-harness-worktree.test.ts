import { describe, expect, it } from 'vitest';
import type { NonTicketWorktree } from './git-worktree.js';
import {
  checkNonTicketHarnessWorktrees,
  filterNonTicketWorktreesWithLiveSession,
  type NonTicketHarnessWorktreeLag,
} from './non-ticket-harness-worktree.js';
import { STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND } from './hygiene.js';
import { makeSession } from './test-support.js';

function lag(overrides: Partial<NonTicketHarnessWorktreeLag> = {}): NonTicketHarnessWorktreeLag {
  return {
    projectId: 'proj-a',
    worktreePath: '/repo/.claude/worktrees/mac-slow-diagnosis-7ddee1',
    branchName: 'feature/mac-slow-diagnosis-7ddee1',
    commitsBehind: STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND,
    baseRef: 'origin/main',
    hasCommonAncestor: true,
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

  it('tells the reader to sort it out by hand instead of rebasing when there is no common ancestor (bdboard-0chq)', () => {
    const [warning] = checkNonTicketHarnessWorktrees([lag({ hasCommonAncestor: false })]);

    expect(warning?.message).toContain('共通の祖先が');
    expect(warning?.message).toContain('手で整理');
    expect(warning?.message).not.toMatch(/rebase origin\/main/);
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

function nonTicketWorktree(
  overrides: Partial<NonTicketWorktree> = {},
): NonTicketWorktree {
  return {
    projectId: 'proj-a',
    repoRootPath: '/repo',
    worktreePath: '/repo/.claude/worktrees/mac-slow-diagnosis-7ddee1',
    branchName: 'feature/mac-slow-diagnosis-7ddee1',
    ...overrides,
  };
}

describe('filterNonTicketWorktreesWithLiveSession', () => {
  it('keeps a worktree whose exact path matches a live session cwd', () => {
    const worktree = nonTicketWorktree();
    const session = makeSession({ cwd: worktree.worktreePath, alive: true });

    expect(filterNonTicketWorktreesWithLiveSession([worktree], [session])).toEqual([worktree]);
  });

  it('keeps a worktree when the live session cwd is nested inside it', () => {
    const worktree = nonTicketWorktree();
    const session = makeSession({ cwd: `${worktree.worktreePath}/web`, alive: true });

    expect(filterNonTicketWorktreesWithLiveSession([worktree], [session])).toEqual([worktree]);
  });

  it('drops a worktree when the only session there is not alive', () => {
    const worktree = nonTicketWorktree();
    const session = makeSession({ cwd: worktree.worktreePath, alive: false });

    expect(filterNonTicketWorktreesWithLiveSession([worktree], [session])).toEqual([]);
  });

  it('drops a worktree with no matching session cwd at all', () => {
    const worktree = nonTicketWorktree();
    const session = makeSession({ cwd: '/repo/.claude/worktrees/some-other', alive: true });

    expect(filterNonTicketWorktreesWithLiveSession([worktree], [session])).toEqual([]);
  });

  // 似た名前の兄弟ディレクトリ (worktreePath の文字列 prefix だが別ディレクトリ) を
  // 誤って「内側」と判定しないこと。
  it('does not treat a sibling directory with a shared string prefix as inside the worktree', () => {
    const worktree = nonTicketWorktree({
      worktreePath: '/repo/.claude/worktrees/mac-slow',
    });
    const session = makeSession({
      cwd: '/repo/.claude/worktrees/mac-slow-diagnosis-7ddee1',
      alive: true,
    });

    expect(filterNonTicketWorktreesWithLiveSession([worktree], [session])).toEqual([]);
  });

  it('returns nothing when there are no sessions at all', () => {
    expect(filterNonTicketWorktreesWithLiveSession([nonTicketWorktree()], [])).toEqual([]);
  });

  it('drops only the worktrees without a live session, keeping the rest', () => {
    const withSession = nonTicketWorktree({ worktreePath: '/repo/.claude/worktrees/a' });
    const abandoned = nonTicketWorktree({ worktreePath: '/repo/.claude/worktrees/b' });
    const session = makeSession({ cwd: withSession.worktreePath, alive: true });

    expect(
      filterNonTicketWorktreesWithLiveSession([withSession, abandoned], [session]),
    ).toEqual([withSession]);
  });
});
