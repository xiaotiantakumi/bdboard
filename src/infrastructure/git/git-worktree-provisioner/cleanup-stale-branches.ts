import { BD_BRANCH_PREFIX } from '../../../domain/git-worktree.js';
import { runGit } from './git-command.js';
import { isBranchMerged } from './merge-evidence.js';
import { validateTicketIdForWorktree } from './paths.js';
import type { CleanupMergedOptions } from './cleanup-types.js';

/**
 * Recover branch-only leftovers from a prior partial cleanup. Never touch a
 * branch still checked out anywhere. Direct ancestors use branch -d as a
 * second merged guard; squash-merged branches use update-ref's old-OID CAS so
 * a branch that advances after the GitHub proof is collected is preserved.
 *
 * `retainedTicketIds` is mutated in place (same contract as the caller's own
 * worktree-entry loop) so both loops share one running tally.
 */
export async function cleanupStaleMergedBranches(
  options: CleanupMergedOptions,
  checkedOutBranches: ReadonlySet<string>,
  retainedTicketIds: Set<string>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const {
    commandRunner,
    gitPath,
    ghPath,
    repoRootPath,
    cleanupEligibleTicketIds,
    isTicketProtected,
    mainBranch,
    timeoutMs,
    logWarn,
  } = options;

  const branchList = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/heads/${BD_BRANCH_PREFIX}`],
    timeoutMs,
  );
  if (branchList.exitCode !== 0) {
    return {
      ok: false,
      message: branchList.stderr || 'git branch list failed',
    };
  }

  for (const branchName of branchList.stdout.split('\n').filter(Boolean)) {
      if (!branchName.startsWith(BD_BRANCH_PREFIX) || checkedOutBranches.has(branchName)) {
        continue;
      }
      const ticketId = branchName.slice(BD_BRANCH_PREFIX.length);
      if (!validateTicketIdForWorktree(ticketId)) {
        continue;
      }
      retainedTicketIds.add(ticketId);
      if (
        !cleanupEligibleTicketIds.has(ticketId)
        || isTicketProtected(ticketId)
      ) {
        continue;
      }
      const mergeEvidence = await isBranchMerged(
        commandRunner,
        gitPath,
        ghPath,
        repoRootPath,
        branchName,
        mainBranch,
        timeoutMs,
      );
      if (mergeEvidence === null) {
        continue;
      }
      if (isTicketProtected(ticketId)) {
        continue;
      }
      const deleteBranch = mergeEvidence.kind === 'ancestor'
        ? await runGit(
          commandRunner,
          gitPath,
          repoRootPath,
          ['branch', '-d', branchName],
          timeoutMs,
        )
        : await runGit(
          commandRunner,
          gitPath,
          repoRootPath,
          [
            'update-ref',
            '-d',
            `refs/heads/${branchName}`,
            mergeEvidence.verifiedHeadOid,
          ],
          timeoutMs,
        );
      if (deleteBranch.exitCode !== 0) {
        logWarn(
          `[agent-run cleanup] could not delete merged branch ${branchName}: ${deleteBranch.stderr || 'git branch -d failed'}`,
        );
      } else {
        retainedTicketIds.delete(ticketId);
      }
  }

  return { ok: true };
}
