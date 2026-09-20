import { BD_BRANCH_PREFIX } from '../../../domain/git-worktree.js';
import { runGit } from './git-command.js';
import { inspectWorktreeUse } from './worktree-use.js';
import { isBranchMerged } from './merge-evidence.js';
import { managedTicketId, parseWorktreeEntries } from './paths.js';
import { cleanupStaleMergedBranches } from './cleanup-stale-branches.js';
import type { CleanupMergedOptions, CleanupMergedResult } from './cleanup-types.js';

export async function cleanupMergedManagedArtifacts(
  options: CleanupMergedOptions,
): Promise<CleanupMergedResult> {
  // Run completion is not a cleanup boundary. A successful agent leaves
  // uncommitted edits for a human to verify and turn into a PR, while a failed
  // run may leave evidence needed for diagnosis. Cleanup is therefore
  // opportunistic, immediately before another managed worktree would be added,
  // and limited to artifacts already merged into origin/<mainBranch>.
  const {
    commandRunner,
    gitPath,
    ghPath,
    lsofPath,
    repoRootPath,
    worktreeListOutput,
    cleanupEligibleTicketIds,
    isTicketProtected,
    mainBranch,
    timeoutMs,
    logWarn,
  } = options;
  const entries = parseWorktreeEntries(worktreeListOutput);
  const checkedOutBranches = new Set(
    entries.flatMap((entry) => (entry.branch === null ? [] : [entry.branch])),
  );
  const retainedTicketIds = new Set<string>();

  for (const entry of entries) {
    const ticketId = managedTicketId(repoRootPath, entry.path);
    if (ticketId === undefined) {
      continue;
    }

    retainedTicketIds.add(ticketId);
    if (
      entry.branch !== `${BD_BRANCH_PREFIX}${ticketId}`
      || !cleanupEligibleTicketIds.has(ticketId)
      || isTicketProtected(ticketId)
    ) {
      continue;
    }

    const status = await runGit(
      commandRunner,
      gitPath,
      entry.path,
      ['status', '--porcelain'],
      timeoutMs,
    );
    if (status.exitCode !== 0 || status.stdout.trim() !== '') {
      continue;
    }

    const mergeEvidence = await isBranchMerged(
      commandRunner,
      gitPath,
      ghPath,
      repoRootPath,
      entry.branch,
      mainBranch,
      timeoutMs,
    );
    if (mergeEvidence === null) {
      continue;
    }

    const useStatus = await inspectWorktreeUse(
      commandRunner,
      lsofPath,
      entry.path,
      timeoutMs,
    );
    if (useStatus !== 'idle') {
      if (useStatus === 'unknown') {
        logWarn(
          `[agent-run cleanup] lsof failed for ${entry.path}; leaving it untouched`,
        );
      }
      continue;
    }

    // A run can start while git/lsof commands above are awaited. Re-read the
    // active-run state at the destructive boundary instead of trusting a
    // request-start snapshot.
    if (isTicketProtected(ticketId)) {
      continue;
    }

    const remove = await runGit(
      commandRunner,
      gitPath,
      repoRootPath,
      ['worktree', 'remove', entry.path],
      timeoutMs,
    );
    if (remove.exitCode !== 0) {
      logWarn(
        `[agent-run cleanup] could not remove worktree ${entry.path}: ${remove.stderr || 'git worktree remove failed'}`,
      );
      continue;
    }

    checkedOutBranches.delete(entry.branch);
    const deleteBranch = mergeEvidence.kind === 'ancestor'
      ? await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        ['branch', '-d', entry.branch],
        timeoutMs,
      )
      : await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        [
          'update-ref',
          '-d',
          `refs/heads/${entry.branch}`,
          mergeEvidence.verifiedHeadOid,
        ],
        timeoutMs,
      );
    if (deleteBranch.exitCode !== 0) {
      logWarn(
        `[agent-run cleanup] removed worktree but could not delete branch ${entry.branch}: ${deleteBranch.stderr || 'git branch -d failed'}`,
      );
    } else {
      retainedTicketIds.delete(ticketId);
    }
  }

  const staleBranchResult = await cleanupStaleMergedBranches(
    options,
    checkedOutBranches,
    retainedTicketIds,
  );
  if (!staleBranchResult.ok) {
    return {
      ok: false,
      message: staleBranchResult.message,
    };
  }

  return {
    ok: true,
    remainingManagedArtifacts: retainedTicketIds.size,
    retainedTicketIds,
  };
}
