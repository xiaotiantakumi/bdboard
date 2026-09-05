import { compareStrings } from './compare.js';

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
  /**
   * git を最後まで読めたか。`false` なら **空 = 存在しない、ではない**。
   *
   * Hygiene 側 (scan-git-leftovers / scan-in-flight-overlaps) は「読めた範囲で残骸を
   * 出す」ので不完全でも困らないが、reclaim 側 (plan-project-reclaim) にとっては
   * 「worktree が無い」と「worktree を確認できなかった」の取り違えがそのまま
   * 生存セッションのチケット強奪になる (bdboard-6aci)。読めなかったことを
   * スナップショット自身に持たせて、消費側が自分の許容度で分岐できるようにする。
   */
  readonly complete: boolean;
}

export const BD_BRANCH_PREFIX = 'bd/';

/**
 * 管理下 worktree のレイアウト: `<repoRoot>/.claude/worktrees/<ticketId>`。
 * provisioner (worktree を作る側) と validateProvisionedRunCwd (spawn 直前に
 * 形を検証する側) が同じ形を二重定義していたので domain に集約した。
 * `path.join` は win32 でも '/' を区切りとして正規化するので、この 1 本で両対応。
 */
export const WORKTREES_DIR = '.claude/worktrees';

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

  return [...byTicketId.values()].sort((a, b) => compareStrings(a.ticketId, b.ticketId));
}
