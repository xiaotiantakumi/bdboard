/** Stable affixes for worktree-branch-mismatch messages (Web UI extracts branch names from these). */
export const WORKTREE_BRANCH_MISMATCH_ON_BRANCH = ': on branch ';
export const WORKTREE_BRANCH_MISMATCH_EXPECTED = ', expected ';

export function formatWorktreeBranchMismatchMessage(
  worktreePath: string,
  actualBranch: string,
  expectedBranch: string,
): string {
  return `${worktreePath}${WORKTREE_BRANCH_MISMATCH_ON_BRANCH}${actualBranch}${WORKTREE_BRANCH_MISMATCH_EXPECTED}${expectedBranch}`;
}
