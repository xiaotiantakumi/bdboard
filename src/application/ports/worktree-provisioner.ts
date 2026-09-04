export interface WorktreeProvisionRequest {
  readonly repoRootPath: string;
  readonly ticketId: string;
  /**
   * Closed tickets eligible for destructive cleanup. Omitting this protects
   * everything: an absent filter must never widen what may be deleted, because
   * the caller that forgot it is exactly the caller that did not think about
   * which worktrees are safe to remove. Fail-closed (bdboard-54be.3).
   */
  readonly cleanupEligibleTicketIds?: readonly string[];
  /** Read immediately before deletion so a newly-started run cannot be missed. */
  readonly isTicketProtected?: (ticketId: string) => boolean;
}

/** Successful provision: worktree path, branch name, and whether an existing worktree was reused. */
export interface WorktreeProvisionResult {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly reused: boolean;
}

/**
 * Discriminated union so invalid ticket ids and git failures return without throwing.
 * Callers can branch on `ok` instead of catching exceptions at the HTTP boundary.
 */
export type WorktreeProvisionOutcome =
  | ({ readonly ok: true } & WorktreeProvisionResult)
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-ticket-id'
        | 'git-failed'
        | 'worktree-dirty'
        | 'worktree-branch-mismatch'
        | 'worktree-limit-reached'
        | 'no-base-ref';
      readonly message?: string;
    };

export interface WorktreeProvisioner {
  provision(req: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome>;
}
