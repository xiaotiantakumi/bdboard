import type { CommandRunner } from '../../../application/ports/command-runner.js';

export interface CleanupMergedOptions {
  readonly commandRunner: CommandRunner;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly lsofPath: string;
  readonly repoRootPath: string;
  readonly worktreeListOutput: string;
  /**
   * Closed tickets eligible for destructive cleanup. Always a set by the time
   * it reaches here: the request-level `undefined` is normalised to an empty
   * set at the call site, so "no filter supplied" means "nothing is eligible"
   * rather than "everything is eligible" (bdboard-54be.3).
   */
  readonly cleanupEligibleTicketIds: ReadonlySet<string>;
  readonly isTicketProtected: (ticketId: string) => boolean;
  /** Verify contract's main branch; merge evidence is checked against origin/<mainBranch>. */
  readonly mainBranch: string;
  readonly timeoutMs: number;
  readonly logWarn: (message: string) => void;
}

export type CleanupMergedResult =
  | {
      readonly ok: true;
      /** Number of ticket ids retaining a managed worktree, branch, or both. */
      readonly remainingManagedArtifacts: number;
      readonly retainedTicketIds: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly message: string };
