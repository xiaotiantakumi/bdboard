import { describe, expect, it, vi } from 'vitest';
import type { InFlightWorktree } from '../../domain/in-flight-overlap.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { scanHarnessWorktreeLags } from './scan-harness-worktree-lags.js';

const worktrees: readonly InFlightWorktree[] = [
  { projectId: '/repo', ticketId: 'bdboard-a', worktreePath: '/repo/wt/a' },
  { projectId: '/repo', ticketId: 'bdboard-b', worktreePath: '/repo/wt/b' },
];

function scanner(overrides: Partial<WorktreeScanner> = {}): WorktreeScanner {
  return {
    scan: async () => ({ worktrees: [], bdBranches: [] }),
    listChangedFiles: async () => [],
    ...overrides,
  };
}

describe('scanHarnessWorktreeLags', () => {
  it('measures every worktree', async () => {
    const lags = await scanHarnessWorktreeLags(
      worktrees,
      scanner({
        countCommitsBehindDefaultBranch: async (path) => (path === '/repo/wt/a' ? 124 : 3),
      }),
    );

    expect([...lags].sort((x, y) => x.ticketId.localeCompare(y.ticketId))).toEqual([
      {
        projectId: '/repo',
        ticketId: 'bdboard-a',
        worktreePath: '/repo/wt/a',
        commitsBehind: 124,
      },
      {
        projectId: '/repo',
        ticketId: 'bdboard-b',
        worktreePath: '/repo/wt/b',
        commitsBehind: 3,
      },
    ]);
  });

  // 「測れない」を「遅れていない」と取り違えないこと。空配列なら kind は一切出ない。
  it('returns nothing when the scanner cannot measure lag at all', async () => {
    const lags = await scanHarnessWorktreeLags(worktrees, scanner());

    expect(lags).toEqual([]);
  });

  // 1 本壊れているだけで盤面から警告が丸ごと消えるほうが困る。
  it('drops only the worktrees it could not read, and warns once', async () => {
    const logWarn = vi.fn();

    const lags = await scanHarnessWorktreeLags(
      worktrees,
      scanner({
        countCommitsBehindDefaultBranch: async (path) => {
          if (path === '/repo/wt/a') {
            throw new Error('no origin/main');
          }
          return 60;
        },
      }),
      { logWarn },
    );

    expect(lags.map((entry) => entry.ticketId)).toEqual(['bdboard-b']);
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('gives up on a worktree that blows the deadline', async () => {
    const logWarn = vi.fn();

    const lags = await scanHarnessWorktreeLags(
      [worktrees[0]!],
      scanner({
        countCommitsBehindDefaultBranch: () => new Promise<number>(() => {}),
      }),
      { logWarn, worktreeDeadlineMs: 5 },
    );

    expect(lags).toEqual([]);
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('does not call the scanner when there are no in-flight worktrees', async () => {
    const countCommitsBehindDefaultBranch = vi.fn(async () => 0);

    const lags = await scanHarnessWorktreeLags(
      [],
      scanner({ countCommitsBehindDefaultBranch }),
    );

    expect(lags).toEqual([]);
    expect(countCommitsBehindDefaultBranch).not.toHaveBeenCalled();
  });
});
