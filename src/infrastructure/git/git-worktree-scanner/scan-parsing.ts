import { compareStrings } from '../../../domain/compare.js';
import { BD_BRANCH_PREFIX, type GitWorktreeEntry } from '../../../domain/git-worktree.js';

export function parseWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  const blocks = output.split('\n\n');
  let isFirst = true;

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) {
      continue;
    }

    let worktreePath: string | null = null;
    let branch: string | null = null;
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      } else if (line === 'bare') {
        isBare = true;
      }
    }

    // bare リポジトリのブロックも「先頭 = メイン」の枠を消費する。ここで isFirst を
    // 落とさずに continue すると、bare クローン + linked worktree 構成のときに最初の
    // linked worktree が isMain 扱いになり、本物の残骸を取りこぼす。
    const isMain = isFirst;
    isFirst = false;

    if (isBare || worktreePath === null) {
      continue;
    }

    entries.push({
      path: worktreePath,
      branch,
      isMain,
    });
  }

  return entries;
}

export function parseBdBranches(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith(BD_BRANCH_PREFIX))
    .sort(compareStrings);
}
