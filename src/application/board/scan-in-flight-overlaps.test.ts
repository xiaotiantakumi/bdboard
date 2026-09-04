import { describe, expect, it, vi } from 'vitest';
import type { InFlightWorktree } from '../../domain/in-flight-overlap.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { scanInFlightOverlaps } from './scan-in-flight-overlaps.js';

function worktree(ticketId: string, projectId = 'p1'): InFlightWorktree {
  return { projectId, ticketId, worktreePath: `/wt/${projectId}/${ticketId}` };
}

function createScanner(
  filesByPath: Readonly<Record<string, readonly string[] | Error>>,
): WorktreeScanner {
  return {
    scan: async () => ({ worktrees: [], bdBranches: [] }),
    listChangedFiles: async (worktreePath) => {
      const value = filesByPath[worktreePath];
      if (value instanceof Error) {
        throw value;
      }
      return value ?? [];
    },
  };
}

describe('scanInFlightOverlaps', () => {
  it('returns nothing without touching git when there are no worktrees', async () => {
    const listChangedFiles = vi.fn();
    const scanner: WorktreeScanner = {
      scan: async () => ({ worktrees: [], bdBranches: [] }),
      listChangedFiles,
    };

    expect(await scanInFlightOverlaps([], scanner)).toEqual([]);
    expect(listChangedFiles).not.toHaveBeenCalled();
  });

  it('pairs tickets that changed the same file', async () => {
    const scanner = createScanner({
      '/wt/p1/a': ['src/hygiene.ts', 'src/a.ts'],
      '/wt/p1/b': ['src/hygiene.ts', 'src/b.ts'],
      '/wt/p1/c': ['src/c.ts'],
    });

    const overlaps = await scanInFlightOverlaps(
      [worktree('a'), worktree('b'), worktree('c')],
      scanner,
    );

    expect(overlaps).toEqual([
      { projectId: 'p1', ticketIds: ['a', 'b'], files: ['src/hygiene.ts'] },
    ]);
  });

  it('skips a worktree whose git call failed and warns once', async () => {
    const scanner = createScanner({
      '/wt/p1/a': ['src/hygiene.ts'],
      '/wt/p1/b': new Error('no merge-base'),
      '/wt/p1/c': new Error('not a git repository'),
      '/wt/p1/d': ['src/hygiene.ts'],
    });
    const logWarn = vi.fn();

    const overlaps = await scanInFlightOverlaps(
      [worktree('a'), worktree('b'), worktree('c'), worktree('d')],
      scanner,
      { logWarn },
    );

    expect(overlaps).toEqual([
      { projectId: 'p1', ticketIds: ['a', 'd'], files: ['src/hygiene.ts'] },
    ]);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]![0]).toContain('2 of 4 failed');
  });

  it('does not warn when every worktree could be read', async () => {
    const logWarn = vi.fn();
    await scanInFlightOverlaps(
      [worktree('a')],
      createScanner({ '/wt/p1/a': ['src/a.ts'] }),
      { logWarn },
    );

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('never runs more than three worktree reads at once', async () => {
    let active = 0;
    let peak = 0;
    const scanner: WorktreeScanner = {
      scan: async () => ({ worktrees: [], bdBranches: [] }),
      listChangedFiles: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return [];
      },
    };

    await scanInFlightOverlaps(
      Array.from({ length: 12 }, (_, index) => worktree(`t${index}`)),
      scanner,
    );

    expect(peak).toBeLessThanOrEqual(3);
  });
});
