import type { GitWorktreeSnapshot } from '../../domain/git-worktree.js';

export interface WorktreeScanner {
  /** rootPath の git worktree / bd ブランチを読み取り専用で調べる。破壊的操作は行わない */
  scan(rootPath: string): Promise<GitWorktreeSnapshot>;
  /**
   * worktree が触っているファイル (merge-base 以降のコミット差分 + 未コミット差分 +
   * 未追跡ファイル) をリポジトリルート相対で返す。読み取り専用で、checkout / reset /
   * clean / stash のような書き込み系 git は一切実行しない。
   *
   * 取得できなかったときは **throw する**。呼び出し側 (scanInFlightOverlaps) が
   * その worktree だけ skip して警告ログを出す。
   */
  listChangedFiles(worktreePath: string): Promise<readonly string[]>;
}
