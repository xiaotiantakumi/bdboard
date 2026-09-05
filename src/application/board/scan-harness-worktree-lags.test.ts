import { describe, expect, it, vi } from 'vitest';
import type { InFlightWorktree } from '../../domain/in-flight-overlap.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { scanHarnessWorktreeLags } from './scan-harness-worktree-lags.js';

function worktree(ticketId: string, worktreePath: string): InFlightWorktree {
  return { projectId: '/repo', ticketId, worktreePath };
}

const worktrees: readonly InFlightWorktree[] = [
  { projectId: '/repo', ticketId: 'bdboard-a', worktreePath: '/repo/wt/a' },
  { projectId: '/repo', ticketId: 'bdboard-b', worktreePath: '/repo/wt/b' },
];

function scanner(overrides: Partial<WorktreeScanner> = {}): WorktreeScanner {
  return {
    scan: async () => ({ worktrees: [], bdBranches: [], complete: true }),
    listChangedFiles: async () => [],
    ...overrides,
  };
}

describe('scanHarnessWorktreeLags', () => {
  it('measures every worktree', async () => {
    const lags = await scanHarnessWorktreeLags(
      worktrees,
      scanner({
        countHarnessCommitsBehindDefaultBranch: async (path) => (path === '/repo/wt/a' ? 124 : 3),
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
        countHarnessCommitsBehindDefaultBranch: async (path) => {
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
        countHarnessCommitsBehindDefaultBranch: () => new Promise<number>(() => {}),
      }),
      { logWarn, worktreeDeadlineMs: 5 },
    );

    expect(lags).toEqual([]);
    expect(logWarn).toHaveBeenCalledOnce();
  });

  // このガードを消すと `undefined(...)` の TypeError が worktree ごとの try/catch に
  // 吸われて failures 扱いになり、**やはり空配列が返る**。戻り値だけを見ていると
  // ガードの有無を区別できないので、警告が出ていないことまで見る。
  it('measures nothing (and warns about nothing) when the scanner cannot measure lag', async () => {
    const logWarn = vi.fn();

    const lags = await scanHarnessWorktreeLags(
      [worktree('bdboard-a', '/repo/wt/a')],
      scanner({}),
      { logWarn },
    );

    expect(lags).toEqual([]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('only measures the worktrees shouldMeasure selects', async () => {
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async () => 9);

    const lags = await scanHarnessWorktreeLags(
      [worktree('bdboard-a', '/repo/wt/a'), worktree('bdboard-b', '/repo/wt/b')],
      scanner({ countHarnessCommitsBehindDefaultBranch }),
      { shouldMeasure: (w) => w.ticketId === 'bdboard-b' },
    );

    expect(lags.map((l) => l.ticketId)).toEqual(['bdboard-b']);
    expect(countHarnessCommitsBehindDefaultBranch).toHaveBeenCalledTimes(1);
    expect(countHarnessCommitsBehindDefaultBranch).toHaveBeenCalledWith('/repo/wt/b');
  });

  it('does not call the scanner when there are no in-flight worktrees', async () => {
    const countHarnessCommitsBehindDefaultBranch = vi.fn(async () => 0);

    const lags = await scanHarnessWorktreeLags(
      [],
      scanner({ countHarnessCommitsBehindDefaultBranch }),
    );

    expect(lags).toEqual([]);
    expect(countHarnessCommitsBehindDefaultBranch).not.toHaveBeenCalled();
  });
});
