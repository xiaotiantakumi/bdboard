export interface WorktreeProvisionRequest {
  readonly repoRootPath: string;
  readonly ticketId: string;
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
        | 'no-base-ref';
      readonly message?: string;
    };

export interface WorktreeProvisioner {
  provision(req: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome>;
}
