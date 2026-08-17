export interface GitWorktreeEntry {
  /** worktree の絶対パス */
  readonly path: string;
  /** refs/heads/ を除いた短縮ブランチ名。detached なら null */
  readonly branch: string | null;
  /** git worktree list --porcelain の先頭エントリ = メインチェックアウト */
  readonly isMain: boolean;
}

export interface GitWorktreeSnapshot {
  readonly worktrees: readonly GitWorktreeEntry[];
  /** `bd/` プレフィックス込みのローカルブランチ名。例 'bd/bdboard-3tw.96' */
  readonly bdBranches: readonly string[];
}

export const BD_BRANCH_PREFIX = 'bd/';

/** 'bd/foo' -> 'foo' / それ以外 -> null */
export function bdBranchTicketId(branch: string): string | null {
  if (branch.startsWith(BD_BRANCH_PREFIX)) {
    return branch.slice(BD_BRANCH_PREFIX.length);
  }
  return null;
}

/** closed 判定はまだしない。「残骸かもしれない」候補。 */
export interface LeftoverCandidate {
  readonly projectId: string;
  /** 掃除コマンドの `git -C <ここ>` に使うリポジトリルート */
  readonly repoRootPath: string;
  readonly ticketId: string;
  readonly worktreePath: string | null;
  readonly branchName: string | null;
}

function pathBasename(filePath: string): string {
  let trimmed = filePath;
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) {
    return trimmed;
  }
  return trimmed.slice(lastSlash + 1);
}

function upsertCandidate(
  map: Map<string, LeftoverCandidate>,
  projectId: string,
  repoRootPath: string,
  ticketId: string,
  patch: { readonly worktreePath?: string; readonly branchName?: string },
): void {
  const existing = map.get(ticketId);
  if (existing !== undefined) {
    map.set(ticketId, {
      ...existing,
      ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
      ...(patch.branchName !== undefined ? { branchName: patch.branchName } : {}),
    });
    return;
  }

  map.set(ticketId, {
    projectId,
    repoRootPath,
    ticketId,
    worktreePath: patch.worktreePath ?? null,
    branchName: patch.branchName ?? null,
  });
}

export function collectLeftoverCandidates(
  projectId: string,
  repoRootPath: string,
  snapshot: GitWorktreeSnapshot,
): readonly LeftoverCandidate[] {
  const byTicketId = new Map<string, LeftoverCandidate>();

  for (const worktree of snapshot.worktrees) {
    if (worktree.isMain) {
      continue;
    }

    if (worktree.branch !== null) {
      if (!worktree.branch.startsWith(BD_BRANCH_PREFIX)) {
        continue;
      }

      const ticketId = bdBranchTicketId(worktree.branch);
      if (ticketId === null) {
        continue;
      }

      upsertCandidate(byTicketId, projectId, repoRootPath, ticketId, {
        worktreePath: worktree.path,
        branchName: worktree.branch,
      });
      continue;
    }

    const ticketId = pathBasename(worktree.path);
    if (ticketId.length === 0) {
      continue;
    }

    upsertCandidate(byTicketId, projectId, repoRootPath, ticketId, {
      worktreePath: worktree.path,
    });
  }

  for (const branch of snapshot.bdBranches) {
    const ticketId = bdBranchTicketId(branch);
    if (ticketId === null) {
      continue;
    }

    upsertCandidate(byTicketId, projectId, repoRootPath, ticketId, {
      branchName: branch,
    });
  }

  return [...byTicketId.values()].sort((a, b) => a.ticketId.localeCompare(b.ticketId));
}
