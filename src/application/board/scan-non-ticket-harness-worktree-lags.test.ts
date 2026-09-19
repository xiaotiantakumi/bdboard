import { describe, expect, it, vi } from 'vitest';
import type { NonTicketWorktree } from '../../domain/git-worktree.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { scanNonTicketHarnessWorktreeLags } from './scan-non-ticket-harness-worktree-lags.js';

function worktree(projectId: string, worktreePath: string, branchName: string): NonTicketWorktree {
  return { projectId, repoRootPath: '/repo', worktreePath, branchName };
}

const worktrees: readonly NonTicketWorktree[] = [
  worktree('/repo', '/repo/wt/a', 'feature/a'),
  worktree('/repo', '/repo/wt/b', 'feature/b'),
];

function scanner(overrides: Partial<WorktreeScanner> = {}): WorktreeScanner {
  return {
    scan: async () => ({ worktrees: [], bdBranches: [], complete: true }),
    listChangedFiles: async () => [],
    ...overrides,
  };
}

describe('scanNonTicketHarnessWorktreeLags', () => {
  it('measures every worktree', async () => {
    const lags = await scanNonTicketHarnessWorktreeLags(
      worktrees,
      scanner({
        countHarnessCommitsBehindDefaultBranch: async (path) => ({
          commitsBehind: path === '/repo/wt/a' ? 124 : 3,
          baseRef: 'origin/main',
        }),
      }),
    );

    expect(
      [...lags].sort((x, y) => x.worktreePath.localeCompare(y.worktreePath)),
    ).toEqual([
      {
        projectId: '/repo',
        worktreePath: '/repo/wt/a',
        branchName: 'feature/a',
        commitsBehind: 124,
        baseRef: 'origin/main',
      },
      {
        projectId: '/repo',
        worktreePath: '/repo/wt/b',
        branchName: 'feature/b',
        commitsBehind: 3,
        baseRef: 'origin/main',
      },
    ]);
  });

  // 「測れない」を「遅れていない」と取り違えないこと。空配列なら警告は一切出ない。
  it('returns nothing when the scanner cannot measure lag at all', async () => {
    const lags = await scanNonTicketHarnessWorktreeLags(worktrees, scanner());

    expect(lags).toEqual([]);
  });

  // 1 本壊れているだけで盤面から警告が丸ごと消えるほうが困る。
  it('drops only the worktrees it could not read, and warns once', async () => {
    const logWarn = vi.fn();

    const lags = await scanNonTicketHarnessWorktreeLags(
      worktrees,
      scanner({
        countHarnessCommitsBehindDefaultBranch: async (path) => {
          if (path === '/repo/wt/a') {
            throw new Error('no origin/main');
          }
          return { commitsBehind: 60, baseRef: 'origin/main' };
        },
      }),
      { logWarn },
    );

    expect(lags.map((entry) => entry.worktreePath)).toEqual(['/repo/wt/b']);
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('gives up on a worktree that blows the deadline', async () => {
    const logWarn = vi.fn();

    const lags = await scanNonTicketHarnessWorktreeLags(
      [worktrees[0]!],
      scanner({
        countHarnessCommitsBehindDefaultBranch: () => new Promise<never>(() => {}),
      }),
      { logWarn, worktreeDeadlineMs: 5 },
    );

    expect(lags).toEqual([]);
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('passes each project contract mainBranch and propagates the measured ref', async () => {
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async (_path, options) => ({
      commitsBehind: 9,
      baseRef: `origin/${options?.mainBranch ?? 'main'}`,
    }));
    const projectWorktrees = [
      worktree('/repo', '/repo/wt/a', 'feature/a'),
      worktree('/other', '/other/wt/b', 'feature/b'),
    ];

    const lags = await scanNonTicketHarnessWorktreeLags(
      projectWorktrees,
      scanner({ countHarnessCommitsBehindDefaultBranch }),
      { resolveMainBranch: (projectId) => (projectId === '/other' ? 'master' : 'main') },
    );

    expect(countHarnessCommitsBehindDefaultBranch).toHaveBeenCalledWith('/repo/wt/a', {
      mainBranch: 'main',
    });
    expect(countHarnessCommitsBehindDefaultBranch).toHaveBeenCalledWith('/other/wt/b', {
      mainBranch: 'master',
    });
    expect(lags).toContainEqual(
      expect.objectContaining({ projectId: '/other', baseRef: 'origin/master' }),
    );
  });

  it('does not call the scanner when there are no non-ticket worktrees', async () => {
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async () => ({
      commitsBehind: 0,
      baseRef: 'origin/main',
    }));

    const lags = await scanNonTicketHarnessWorktreeLags(
      [],
      scanner({ countHarnessCommitsBehindDefaultBranch }),
    );

    expect(lags).toEqual([]);
    expect(countHarnessCommitsBehindDefaultBranch).not.toHaveBeenCalled();
  });
});
