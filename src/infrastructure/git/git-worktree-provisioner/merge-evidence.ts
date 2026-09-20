import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { runGit } from './git-command.js';

export type BranchMergeEvidence =
  | { readonly kind: 'ancestor' }
  | { readonly kind: 'merged-pr'; readonly verifiedHeadOid: string };

export async function isBranchMerged(
  commandRunner: CommandRunner,
  gitPath: string,
  ghPath: string,
  repoRootPath: string,
  branchName: string,
  mainBranch: string,
  timeoutMs: number,
): Promise<BranchMergeEvidence | null> {
  const fullBranchRef = `refs/heads/${branchName}`;
  const baseRef = `origin/${mainBranch}`;
  const ancestor = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['merge-base', '--is-ancestor', fullBranchRef, baseRef],
    timeoutMs,
  );
  if (ancestor.exitCode === 0) {
    return { kind: 'ancestor' };
  }

  // This repository requires squash merges, so the branch tip is normally not
  // an ancestor of origin/<mainBranch>. A merged PR is sufficient only when its recorded
  // head oid still equals the local branch tip; a reused branch with newer,
  // unmerged commits must not be mistaken for the older merged PR.
  const localHead = await runGit(
    commandRunner,
    gitPath,
    repoRootPath,
    ['rev-parse', '--verify', fullBranchRef],
    timeoutMs,
  );
  if (localHead.exitCode !== 0 || localHead.stdout.trim() === '') {
    return null;
  }

  const mergedPrs = await commandRunner.run(
    ghPath,
    [
      'pr',
      'list',
      '--head',
      branchName,
      '--state',
      'merged',
      '--limit',
      '100',
      '--json',
      'baseRefName,headRefOid,mergeCommit',
    ],
    { cwd: repoRootPath, timeoutMs },
  );
  if (mergedPrs.exitCode !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(mergedPrs.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const expectedHead = localHead.stdout.trim();
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const candidate = item as {
        readonly baseRefName?: unknown;
        readonly headRefOid?: unknown;
        readonly mergeCommit?: { readonly oid?: unknown } | null;
      };
      if (
        candidate.baseRefName !== mainBranch
        || candidate.headRefOid !== expectedHead
        || typeof candidate.mergeCommit?.oid !== 'string'
      ) {
        continue;
      }
      const mergeLanded = await runGit(
        commandRunner,
        gitPath,
        repoRootPath,
        ['merge-base', '--is-ancestor', candidate.mergeCommit.oid, baseRef],
        timeoutMs,
      );
      if (mergeLanded.exitCode === 0) {
        return { kind: 'merged-pr', verifiedHeadOid: expectedHead };
      }
    }
    return null;
  } catch {
    return null;
  }
}
