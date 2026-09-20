import type { Context } from 'hono';
import type { RunStore } from '../../application/runner/run-store.js';
import type {
  WorktreeProvisionResult,
  WorktreeProvisioner,
} from '../../application/ports/worktree-provisioner.js';
import type { RunMode } from '../../domain/run.js';
import { validateProvisionedRunCwd } from '../../application/runner/validate-run-request.js';
import { buildDispatchFailureOutcome } from './agent-run-dispatch-outcome.js';

/**
 * agent-run-routes.ts (旧672行) の分割 (bdboard-sso1.27) で、POST /api/runs
 * (agent-run-create-routes.ts) の run 開始ハンドラから、worktree の provision と
 * その直後の cwd ガード (bdboard-pkr6.18 / provision→dispatch 境界の防御チェック)
 * をここへ切り出した (move only, 挙動変更ゼロ)。parseJsonBody (request-body.ts) と
 * 同じ「呼び出し側の Context を受け取り、失敗時は組み立て済みの Response を返す」
 * 規約に合わせてある。
 */

export interface AgentRunProvisionDeps {
  readonly worktreeProvisioner: WorktreeProvisioner;
  readonly runStore: RunStore;
  readonly normalizePath: (pathValue: string) => string;
  readonly now: () => Date;
}

export interface AgentRunProvisionRequest {
  readonly repoRootPath: string;
  readonly ticketId: string;
  readonly mainBranch: string;
  readonly cleanupEligibleTicketIds: readonly string[];
  readonly runId: string;
  readonly mode: RunMode;
  readonly startedAt: Date;
}

export type AgentRunProvisionOutcome =
  | { readonly ok: true; readonly runCwd: string; readonly provision: WorktreeProvisionResult }
  | { readonly ok: false; readonly response: Response };

export async function provisionRunOrFail(
  c: Context,
  deps: AgentRunProvisionDeps,
  request: AgentRunProvisionRequest,
): Promise<AgentRunProvisionOutcome> {
  const { repoRootPath, ticketId, mainBranch, cleanupEligibleTicketIds, runId, mode, startedAt } =
    request;

  let provision;
  try {
    provision = await deps.worktreeProvisioner.provision({
      repoRootPath,
      ticketId,
      // preflight が読んだ検証コントラクトの mainBranch (省略時 main)。worktree の起点と
      // マージ済み判定の両方をこれに合わせる — origin/main 決め打ちだと master 系
      // リポジトリで実行できない (bdboard-pkr6.18)。
      mainBranch,
      cleanupEligibleTicketIds,
      isTicketProtected: (candidateTicketId) =>
        deps.runStore.list().some(
          (record) =>
            record.ticketId === candidateTicketId
            && (record.status === 'running' || record.status === 'cancelling'),
        ),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.runStore.finish(
      runId,
      buildDispatchFailureOutcome(
        runId,
        ticketId,
        mode,
        startedAt,
        message,
        deps.now(),
      ),
    );
    return { ok: false, response: c.json({ error: message }, 500) };
  }

  if (!provision.ok) {
    const provisionError =
      provision.message ??
      (provision.reason === 'invalid-ticket-id'
        ? 'invalid ticket id'
        : 'worktree provision failed');
    deps.runStore.finish(
      runId,
      buildDispatchFailureOutcome(
        runId,
        ticketId,
        mode,
        startedAt,
        provisionError,
        deps.now(),
      ),
    );
    if (provision.reason === 'invalid-ticket-id') {
      return { ok: false, response: c.json({ error: provisionError }, 400) };
    }
    if (provision.reason === 'worktree-dirty') {
      // Carry `reason` like the sibling 409s above, so clients switch on a stable
      // token instead of pattern-matching the human-readable message.
      return {
        ok: false,
        response: c.json({ error: provisionError, reason: 'worktree-dirty' }, 409),
      };
    }
    if (provision.reason === 'worktree-branch-mismatch') {
      return {
        ok: false,
        response: c.json({ error: provisionError, reason: 'worktree-branch-mismatch' }, 409),
      };
    }
    if (provision.reason === 'worktree-limit-reached') {
      return {
        ok: false,
        response: c.json({ error: provisionError, reason: 'worktree-limit-reached' }, 409),
      };
    }
    return { ok: false, response: c.json({ error: provisionError }, 500) };
  }

  // Single source for the cwd this run uses: recorded on the run, checked by the
  // guard below, and handed to dispatchRun. Do not re-read provision.worktreePath
  // at those sites — routing all three through one variable is what makes the
  // guard's equality half meaningful: if a future change sources runCwd from the
  // request instead, the guard still compares it against provision.worktreePath
  // and stops the spawn, which is precisely the regression this guard exists for.
  const runCwd = provision.worktreePath;

  deps.runStore.updateCwd(runId, runCwd);

  // Defensive check at the provision→dispatch boundary. Under normal operation
  // this does not fire; it stops spawn when the provisioner returns a path
  // outside the managed `.claude/worktrees/<ticketId>` layout. The cwd is
  // recorded just above *before* this check on purpose: if the guard ever does
  // fire, the rejected path is the single most useful thing to have kept, and
  // the run is finished as failed anyway.
  const cwdValidationError = validateProvisionedRunCwd(
    runCwd,
    provision.worktreePath,
    ticketId,
    repoRootPath,
    deps.normalizePath,
  );
  if (cwdValidationError !== null) {
    const message = 'run cwd must be the managed worktree for this ticket';
    deps.runStore.finish(
      runId,
      buildDispatchFailureOutcome(
        runId,
        ticketId,
        mode,
        startedAt,
        message,
        deps.now(),
      ),
    );
    return { ok: false, response: c.json({ error: message }, 500) };
  }

  return { ok: true, runCwd, provision };
}
