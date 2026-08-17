import type { GitWorktreeSnapshot } from '../../domain/git-worktree.js';

export interface WorktreeScanner {
  /** rootPath の git worktree / bd ブランチを読み取り専用で調べる。破壊的操作は行わない */
  scan(rootPath: string): Promise<GitWorktreeSnapshot>;
}
