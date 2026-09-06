import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { scanGitLeftovers } from './scan-git-leftovers.js';

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

describe('scanGitLeftovers', () => {
  it('collects leftover candidates from multiple projects', async () => {
    const scanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: async (rootPath) => {
        if (rootPath === '/projects/a') {
          return {
            worktrees: [
              { path: '/projects/a', branch: 'main', isMain: true },
              {
                path: '/projects/a/.claude/worktrees/bdboard-a',
                branch: 'bd/bdboard-a',
                isMain: false,
              },
            ],
            bdBranches: ['bd/bdboard-a'],
            complete: true,
          };
        }
        return {
          worktrees: [
            { path: '/projects/b', branch: 'main', isMain: true },
          ],
          bdBranches: ['bd/bdboard-b'],
          complete: true,
        };
      },
    };

    const { candidates, complete } = await scanGitLeftovers(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      scanner,
    );

    expect(complete).toBe(true);
    expect(candidates).toHaveLength(2);
    expect(candidates.find((entry) => entry.ticketId === 'bdboard-a')).toMatchObject({
      projectId: 'proj-a',
      repoRootPath: '/projects/a',
      branchName: 'bd/bdboard-a',
    });
    expect(candidates.find((entry) => entry.ticketId === 'bdboard-b')).toMatchObject({
      projectId: 'proj-b',
      repoRootPath: '/projects/b',
      worktreePath: null,
      branchName: 'bd/bdboard-b',
    });
  });

  it('skips projects whose scan rejects without failing the whole call', async () => {
    const scanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: async (rootPath) => {
        if (rootPath === '/projects/b') {
          throw new Error('git read failed');
        }
        return {
          worktrees: [
            { path: '/projects/a', branch: 'main', isMain: true },
          ],
          bdBranches: ['bd/bdboard-a'],
          complete: true,
        };
      },
    };

    const { candidates, complete } = await scanGitLeftovers(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      scanner,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ticketId).toBe('bdboard-a');
    // M2 (bdboard-t3ct): 一部でも取得失敗があれば complete は false になる。
    expect(complete).toBe(false);
  });

  it('limits project scan concurrency to the configured maximum', async () => {
    const projects = Array.from({ length: 8 }, (_, index) =>
      project(`proj-${index}`, `/projects/${index}`),
    );

    let activeCount = 0;
    let maxObserved = 0;

    const scanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: vi.fn(async () => {
        activeCount += 1;
        maxObserved = Math.max(maxObserved, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCount -= 1;
        return {
          worktrees: [{ path: '/projects/x', branch: 'main', isMain: true }],
          bdBranches: ['bd/bdboard-x'],
          complete: true,
        };
      }),
    };

    const { candidates } = await scanGitLeftovers(projects, scanner);

    expect(candidates).toHaveLength(8);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1);
  });

  it('logs a warning when some projects fail but continues with the rest', async () => {
    const scanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: async (rootPath) => {
        if (rootPath === '/projects/b') {
          throw new Error('git read failed');
        }
        return {
          worktrees: [
            { path: '/projects/a', branch: 'main', isMain: true },
          ],
          bdBranches: ['bd/bdboard-a'],
          complete: true,
        };
      },
    };

    const logWarn = vi.fn();
    const { candidates } = await scanGitLeftovers(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      scanner,
      { logWarn },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ticketId).toBe('bdboard-a');
    expect(logWarn).toHaveBeenCalledTimes(1);
    const message = logWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain('1 of 2 failed');
    expect(message).toContain('proj-b');
    expect(message).toContain('git read failed');
  });

  // M2 (bdboard-t3ct): git-worktree-scanner.ts はコマンド失敗を throw せず
  // complete:false に畳むので、throw していなくても不完全なスキャンはある。
  it('reports complete: false when a scan resolves without throwing but is itself incomplete', async () => {
    const scanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: async () => ({
        worktrees: [],
        bdBranches: [],
        complete: false,
      }),
    };

    const { candidates, complete } = await scanGitLeftovers(
      [project('proj-a', '/projects/a')],
      scanner,
    );

    expect(candidates).toHaveLength(0);
    expect(complete).toBe(false);
  });

  // m4 (bdboard-t3ct): 警告文の本体 ("[hygiene] ...") は決め打ちにせず、
  // 呼び出し元の画面に合わせて差し替えられる。
  it('lets the caller customize the failure message instead of the hard-coded [hygiene] text', async () => {
    const scanner: WorktreeScanner = {
      listChangedFiles: async () => [],
      scan: async () => {
        throw new Error('git read failed');
      },
    };

    const logWarn = vi.fn();
    await scanGitLeftovers([project('proj-a', '/projects/a')], scanner, {
      logWarn,
      describeFailure: (failures, totalCount) =>
        `[harness-kpi] custom message (${failures.length}/${totalCount})`,
    });

    expect(logWarn).toHaveBeenCalledWith('[harness-kpi] custom message (1/1)');
  });
});
