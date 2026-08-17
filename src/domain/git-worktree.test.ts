import { describe, expect, it } from 'vitest';
import {
  collectLeftoverCandidates,
  type GitWorktreeSnapshot,
} from './git-worktree.js';

const PROJECT_ID = 'proj-a';
const REPO_ROOT = '/Users/example/repo';

describe('collectLeftoverCandidates', () => {
  it('ignores the main worktree', () => {
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: REPO_ROOT,
          branch: 'main',
          isMain: true,
        },
        {
          path: `${REPO_ROOT}/.claude/worktrees/bdboard-3tw.94`,
          branch: 'bd/bdboard-3tw.94',
          isMain: false,
        },
      ],
      bdBranches: ['bd/bdboard-3tw.94'],
    };

    const candidates = collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ticketId).toBe('bdboard-3tw.94');
  });

  it('never proposes removing the main checkout even when it sits on a bd/ branch (false positive prevention)', () => {
    // メインチェックアウトが bd/<id> ブランチに乗っていると、isMain を無視した場合
    // 「git worktree remove <メインチェックアウト>」を提案してしまう。ブランチ側だけを
    // 候補にし、worktreePath は必ず null のままにする。
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: REPO_ROOT,
          branch: 'bd/bdboard-3tw.96',
          isMain: true,
        },
      ],
      bdBranches: ['bd/bdboard-3tw.96'],
    };

    const candidates = collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot);

    expect(candidates).toEqual([
      {
        projectId: PROJECT_ID,
        repoRootPath: REPO_ROOT,
        ticketId: 'bdboard-3tw.96',
        worktreePath: null,
        branchName: 'bd/bdboard-3tw.96',
      },
    ]);
    expect(candidates.some((candidate) => candidate.worktreePath === REPO_ROOT)).toBe(
      false,
    );
  });

  it('merges worktree and branch for the same bd ticket into one candidate', () => {
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: `${REPO_ROOT}/.claude/worktrees/bdboard-3tw.96`,
          branch: 'bd/bdboard-3tw.96',
          isMain: false,
        },
      ],
      bdBranches: ['bd/bdboard-3tw.96'],
    };

    const candidates = collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot);

    expect(candidates).toEqual([
      {
        projectId: PROJECT_ID,
        repoRootPath: REPO_ROOT,
        ticketId: 'bdboard-3tw.96',
        worktreePath: `${REPO_ROOT}/.claude/worktrees/bdboard-3tw.96`,
        branchName: 'bd/bdboard-3tw.96',
      },
    ]);
  });

  it('returns branch-only candidates with null worktreePath', () => {
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: REPO_ROOT,
          branch: 'main',
          isMain: true,
        },
      ],
      bdBranches: ['bd/bdboard-orphan'],
    };

    const candidates = collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot);

    expect(candidates).toEqual([
      {
        projectId: PROJECT_ID,
        repoRootPath: REPO_ROOT,
        ticketId: 'bdboard-orphan',
        worktreePath: null,
        branchName: 'bd/bdboard-orphan',
      },
    ]);
  });

  it('uses path basename as ticketId for detached worktrees', () => {
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: REPO_ROOT,
          branch: 'main',
          isMain: true,
        },
        {
          path: '/Users/example/my repo/detached one',
          branch: null,
          isMain: false,
        },
      ],
      bdBranches: [],
    };

    const candidates = collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot);

    expect(candidates).toEqual([
      {
        projectId: PROJECT_ID,
        repoRootPath: REPO_ROOT,
        ticketId: 'detached one',
        worktreePath: '/Users/example/my repo/detached one',
        branchName: null,
      },
    ]);
  });

  it('does not include spike/* branch worktrees', () => {
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: REPO_ROOT,
          branch: 'main',
          isMain: true,
        },
        {
          path: `${REPO_ROOT}/.claude/worktrees/spike-test`,
          branch: 'spike/foo',
          isMain: false,
        },
      ],
      bdBranches: [],
    };

    expect(collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot)).toEqual([]);
  });

  it('preserves worktree paths that contain spaces', () => {
    const spacedPath = '/Users/example/my repo/bdboard-3tw.96';
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: REPO_ROOT,
          branch: 'main',
          isMain: true,
        },
        {
          path: spacedPath,
          branch: 'bd/bdboard-3tw.96',
          isMain: false,
        },
      ],
      bdBranches: [],
    };

    const candidates = collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot);

    expect(candidates[0]?.worktreePath).toBe(spacedPath);
    expect(candidates[0]?.ticketId).toBe('bdboard-3tw.96');
  });

  it('keeps dotted ticket ids intact', () => {
    const snapshot: GitWorktreeSnapshot = {
      worktrees: [
        {
          path: REPO_ROOT,
          branch: 'main',
          isMain: true,
        },
        {
          path: `${REPO_ROOT}/.claude/worktrees/bdboard-3tw.96`,
          branch: 'bd/bdboard-3tw.96',
          isMain: false,
        },
      ],
      bdBranches: ['bd/bdboard-3tw.96'],
    };

    const candidates = collectLeftoverCandidates(PROJECT_ID, REPO_ROOT, snapshot);

    expect(candidates[0]?.ticketId).toBe('bdboard-3tw.96');
    expect(candidates[0]?.branchName).toBe('bd/bdboard-3tw.96');
  });
});
