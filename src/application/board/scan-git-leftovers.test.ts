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
          };
        }
        return {
          worktrees: [
            { path: '/projects/b', branch: 'main', isMain: true },
          ],
          bdBranches: ['bd/bdboard-b'],
        };
      },
    };

    const results = await scanGitLeftovers(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      scanner,
    );

    expect(results).toHaveLength(2);
    expect(results.find((entry) => entry.ticketId === 'bdboard-a')).toMatchObject({
      projectId: 'proj-a',
      repoRootPath: '/projects/a',
      branchName: 'bd/bdboard-a',
    });
    expect(results.find((entry) => entry.ticketId === 'bdboard-b')).toMatchObject({
      projectId: 'proj-b',
      repoRootPath: '/projects/b',
      worktreePath: null,
      branchName: 'bd/bdboard-b',
    });
  });

  it('skips projects whose scan rejects without failing the whole call', async () => {
    const scanner: WorktreeScanner = {
      scan: async (rootPath) => {
        if (rootPath === '/projects/b') {
          throw new Error('git read failed');
        }
        return {
          worktrees: [
            { path: '/projects/a', branch: 'main', isMain: true },
          ],
          bdBranches: ['bd/bdboard-a'],
        };
      },
    };

    const results = await scanGitLeftovers(
      [project('proj-a', '/projects/a'), project('proj-b', '/projects/b')],
      scanner,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ticketId).toBe('bdboard-a');
  });

  it('limits project scan concurrency to the configured maximum', async () => {
    const projects = Array.from({ length: 8 }, (_, index) =>
      project(`proj-${index}`, `/projects/${index}`),
    );

    let activeCount = 0;
    let maxObserved = 0;

    const scanner: WorktreeScanner = {
      scan: vi.fn(async () => {
        activeCount += 1;
        maxObserved = Math.max(maxObserved, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCount -= 1;
        return {
          worktrees: [{ path: '/projects/x', branch: 'main', isMain: true }],
          bdBranches: ['bd/bdboard-x'],
        };
      }),
    };

    const results = await scanGitLeftovers(projects, scanner);

    expect(results).toHaveLength(8);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1);
  });
});
