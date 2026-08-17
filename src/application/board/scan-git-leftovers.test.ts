import { describe, expect, it } from 'vitest';
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
});
