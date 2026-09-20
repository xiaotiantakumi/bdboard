import fs from 'node:fs';
import path from 'node:path';
import { BD_BRANCH_PREFIX, WORKTREES_DIR } from '../../../domain/git-worktree.js';
import { isTicketId } from '../../../domain/ticket-id.js';

export interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
}

export function parseWorktreePaths(output: string): readonly string[] {
  const paths: string[] = [];

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length));
    }
  }

  return paths;
}

export function parseWorktreeEntries(output: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];

  for (const block of output.split(/\n\s*\n/)) {
    let worktreePath: string | undefined;
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (worktreePath !== undefined) {
      entries.push({ path: worktreePath, branch });
    }
  }

  return entries;
}

/** Normalize paths for comparison (e.g. /tmp vs /private/tmp on macOS). */
export function normalizePathForComparison(pathValue: string): string {
  try {
    return fs.realpathSync.native(pathValue);
  } catch {
    return pathValue;
  }
}

export function findExistingWorktreePath(
  existingPaths: readonly string[],
  worktreePath: string,
): string | undefined {
  const normalizedTarget = normalizePathForComparison(worktreePath);

  for (const candidate of existingPaths) {
    if (normalizePathForComparison(candidate) === normalizedTarget) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * ticket id は worktree パス・ブランチ名だけでなく、claude CLI の
 * `Edit(//<worktree>/**)` パーミッションルールへ無エスケープで補間される
 * (claude-runner.ts の buildWorktreeEditTool)。')' を含む id はルールの形を変え、
 * '**' を含む id は他チケットの worktree にマッチしうる。denylist では
 * 「まだ気づいていないメタ文字」を取りこぼすので allowlist で通す (bdboard-54be.1 M-5)。
 */
const TICKET_ID_FOR_WORKTREE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateTicketIdForWorktree(ticketId: string): boolean {
  if (!isTicketId(ticketId)) {
    return false;
  }

  if (ticketId.includes('..')) {
    return false;
  }

  return TICKET_ID_FOR_WORKTREE.test(ticketId);
}

export function buildPaths(repoRootPath: string, ticketId: string): {
  worktreePath: string;
  branchName: string;
} {
  const worktreePath = path.join(repoRootPath, WORKTREES_DIR, ticketId);
  const branchName = `${BD_BRANCH_PREFIX}${ticketId}`;

  return { worktreePath, branchName };
}

export function managedTicketId(repoRootPath: string, worktreePath: string): string | undefined {
  const managedRoot = normalizePathForComparison(path.join(repoRootPath, WORKTREES_DIR));
  const normalizedPath = normalizePathForComparison(worktreePath);
  if (path.dirname(normalizedPath) !== managedRoot) {
    return undefined;
  }

  const ticketId = path.basename(normalizedPath);
  return validateTicketIdForWorktree(ticketId) ? ticketId : undefined;
}
