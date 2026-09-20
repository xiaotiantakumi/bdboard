import type { CommandRunner } from '../../../application/ports/command-runner.js';
import type {
  WorktreeProvisionOutcome,
  WorktreeProvisionRequest,
} from '../../../application/ports/worktree-provisioner.js';
import { DEFAULT_MAIN_BRANCH, isSafeMainBranchName } from '../../../domain/harness-contract.js';
import { runGit } from './git-command.js';
import { formatWorktreeBranchMismatchMessage } from './messages.js';
import { buildPaths, findExistingWorktreePath, parseWorktreePaths, validateTicketIdForWorktree } from './paths.js';
import { resolveBaseRef } from './base-ref.js';
import { cleanupMergedManagedArtifacts } from './cleanup.js';

export interface ProvisionDeps {
  readonly commandRunner: CommandRunner;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly lsofPath: string;
  readonly timeoutMs: number;
  readonly maxManagedWorktrees: number;
  readonly logWarn: (message: string) => void;
}

export async function provisionTicketWorktree(
  deps: ProvisionDeps,
  req: WorktreeProvisionRequest,
): Promise<WorktreeProvisionOutcome> {
  const { commandRunner, gitPath, ghPath, lsofPath, timeoutMs, maxManagedWorktrees, logWarn } = deps;
  const { repoRootPath, ticketId } = req;
  const mainBranch = req.mainBranch ?? DEFAULT_MAIN_BRANCH;

  if (!validateTicketIdForWorktree(ticketId)) {
    return { ok: false, reason: 'invalid-ticket-id' };
  }

  // Checked before any git call: nothing may be fetched, cleaned up, or
  // created on the strength of a branch name git could read as an option.
  // Contract parsing already rejects these (so preflight answers 409 first);
  // this is the second guard at the point the value reaches git argv.
  if (!isSafeMainBranchName(mainBranch)) {
    return {
      ok: false,
      reason: 'no-base-ref',
      message: 'invalid main branch name in the verify contract',
    };
  }

  const { worktreePath, branchName } = buildPaths(repoRootPath, ticketId);

  const listResult = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['worktree', 'list', '--porcelain'],
    timeoutMs,
  );

  if (listResult.exitCode !== 0) {
    return {
      ok: false,
      reason: 'git-failed',
      message: listResult.stderr || 'git worktree list failed',
    };
  }

  const existingPaths = parseWorktreePaths(listResult.stdout);
  const existingWorktreePath = findExistingWorktreePath(existingPaths, worktreePath);
  if (existingWorktreePath !== undefined) {
    const statusResult = await runGit(
      commandRunner,
      gitPath,
      existingWorktreePath,
      ['status', '--porcelain'],
      timeoutMs,
    );

    if (statusResult.exitCode !== 0) {
      return {
        ok: false,
        reason: 'git-failed',
        message: statusResult.stderr || 'git status failed',
      };
    }

    if (statusResult.stdout.trim() !== '') {
      return {
        ok: false,
        reason: 'worktree-dirty',
        message: `${existingWorktreePath}: uncommitted changes prevent agent run`,
      };
    }

    // `.claude/worktrees/<ticket-id>` は CLAUDE.md の人間用 worktree と同じパス。
    // 人間が checkout main したり別ブランチで作業した worktree をそのまま再利用すると、
    // エージェントは想定外のブランチ上で編集を始める。API/UI は計算値 bd/<ticketId> を
    // 表示するだけなので、実 HEAD のブランチ名を検証しないと運用者が気づけない。
    const headBranchResult = await runGit(
      commandRunner,
      gitPath,
      existingWorktreePath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      timeoutMs,
    );

    if (headBranchResult.exitCode !== 0) {
      return {
        ok: false,
        reason: 'git-failed',
        message: headBranchResult.stderr || 'git rev-parse failed',
      };
    }

    const actualBranch = headBranchResult.stdout.trim();
    if (actualBranch !== branchName) {
      return {
        ok: false,
        reason: 'worktree-branch-mismatch',
        message: formatWorktreeBranchMismatchMessage(
          existingWorktreePath,
          actualBranch,
          branchName,
        ),
      };
    }

    return {
      ok: true,
      worktreePath: existingWorktreePath,
      // 再利用成功時は計算値ではなく rev-parse の実測値を正とする（一致しているが検証済み）。
      branchName: actualBranch,
      reused: true,
    };
  }

  const baseRefResult = await resolveBaseRef(
    commandRunner,
    gitPath,
    repoRootPath,
    mainBranch,
    timeoutMs,
  );

  if ('ok' in baseRefResult) {
    return baseRefResult;
  }

  const { baseRef, baseRefFresh } = baseRefResult;

  const cleanupResult = await cleanupMergedManagedArtifacts({
    commandRunner,
    gitPath,
    ghPath,
    lsofPath,
    repoRootPath,
    worktreeListOutput: listResult.stdout,
    // A stale remote-tracking ref is sufficient to provision offline, but
    // never sufficient evidence for a destructive cleanup after a failed
    // fetch (origin/<mainBranch> may have been force-updated remotely).
    cleanupEligibleTicketIds: baseRefFresh
      ? new Set(req.cleanupEligibleTicketIds ?? [])
      : new Set(),
    isTicketProtected: req.isTicketProtected ?? (() => false),
    mainBranch,
    timeoutMs,
    logWarn,
  });
  if (!cleanupResult.ok) {
    return {
      ok: false,
      reason: 'git-failed',
      message: cleanupResult.message,
    };
  }
  if (
    cleanupResult.remainingManagedArtifacts >= maxManagedWorktrees
    && !cleanupResult.retainedTicketIds.has(ticketId)
  ) {
    return {
      ok: false,
      reason: 'worktree-limit-reached',
      message:
        `agent-run worktree limit reached (${maxManagedWorktrees}); `
        + 'finish, merge, or manually remove an existing worktree before retrying',
    };
  }

  const createWithBranch = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['worktree', 'add', '-b', branchName, worktreePath, baseRef],
    timeoutMs,
  );

  if (createWithBranch.exitCode === 0) {
    return {
      ok: true,
      worktreePath,
      branchName,
      reused: false,
    };
  }

  const createExistingBranch = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['worktree', 'add', worktreePath, branchName],
    timeoutMs,
  );

  if (createExistingBranch.exitCode === 0) {
    return {
      ok: true,
      worktreePath,
      branchName,
      reused: false,
    };
  }

  return {
    ok: false,
    reason: 'git-failed',
    message:
      createExistingBranch.stderr ||
      createWithBranch.stderr ||
      'git worktree add failed',
  };
}
