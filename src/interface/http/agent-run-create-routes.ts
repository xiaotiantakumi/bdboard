import { Hono } from 'hono';
import { z } from 'zod';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { WorktreeProvisioner } from '../../application/ports/worktree-provisioner.js';
import { buildRunPrompt } from '../../application/runner/build-run-prompt.js';
import type { AgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import type { RunStore } from '../../application/runner/run-store.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import {
  evaluateRunPreflight,
  type RunPreflightOutcome,
} from '../../domain/harness-run-preflight.js';
import {
  createReadinessContext,
  isBlocked,
  isDeferred,
} from '../../domain/readiness.js';
import { parseJsonBody } from './request-body.js';
import { findTicket } from './agent-run-shared.js';
import {
  buildDispatchFailureOutcome,
  buildRunId,
  fireAgentRunDispatch,
  PREFLIGHT_ERROR_MESSAGES,
  SPAWN_RUNNER_ID,
} from './agent-run-dispatch-outcome.js';
import { provisionRunOrFail } from './agent-run-provision.js';

/**
 * agent-run-routes.ts (旧672行) の分割 (bdboard-sso1.27) で POST /api/runs
 * (run の開始) をここへ切り出した (move only, 挙動変更ゼロ)。preflight →
 * canStart → readiness チェック → worktree provision → cwd ガード → claim →
 * dispatchRun の一連はこのルート専用の状態遷移で、他グループとは共有しない。
 * outcome の組み立てと fire-and-forget な dispatchRun 呼び出し自体は
 * agent-run-dispatch-outcome.ts へさらに切り出してある (200行上限に収めるため)。
 */

const postRunsBodySchema = z.object({
  ticketId: z.string().min(1),
  mode: z.literal('spawn').optional(),
});

export interface AgentRunCreateRoutesDeps {
  readonly cache: BoardCache;
  readonly registry: AgentRunnerRegistry;
  readonly runStore: RunStore;
  readonly worktreeProvisioner: WorktreeProvisioner;
  readonly normalizePath: (pathValue: string) => string;
  readonly getHarnessStatus: (repoRootPath: string) => Promise<ProjectHarnessStatus>;
  readonly isRemoteAgentRunAllowed: () => Promise<boolean>;
  readonly now: () => Date;
  readonly issueWriter: IssueWriterPort;
}

export function createAgentRunCreateRoutes(deps: AgentRunCreateRoutesDeps): Hono {
  const app = new Hono();

  app.post('/api/runs', async (c) => {
    const parsed = await parseJsonBody(c, postRunsBodySchema);
    if (!parsed.ok) {
      return parsed.response;
    }

    const mode = parsed.data.mode ?? 'spawn';
    if (mode !== 'spawn') {
      return c.json({ error: 'unsupported run mode' }, 400);
    }

    const { ticketId } = parsed.data;
    const resolved = findTicket(deps.cache, ticketId);
    if (resolved === undefined) {
      return c.json({ error: 'ticket not found' }, 404);
    }

    const { project, ticket, cleanupEligibleTicketIds } = resolved;

    // Preflight (bdboard-pkr6.11). run のプロンプトは「ハーネスの手順に従え」と
    // 言うだけなので、skill が無い / hook が未登録 / 検証コントラクトが無い
    // プロジェクトでは、従う手順も効くガードも合否の基準も存在しないまま
    // Claude CLI が走る。ここで止める。
    //
    // 位置は canStart より前 — 前提不足は設定の問題で、実行スロットを消費させる
    // 理由も、失敗 run を履歴に積む理由も無い。したがって拒否理由の優先順位は
    // ハーネス > too-many-runs > closed/blocked/deferred になる。
    // provision より前でもあるので、worktree は作られない。
    let preflight: RunPreflightOutcome;
    try {
      preflight = evaluateRunPreflight(await deps.getHarnessStatus(project.rootPath));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: `harness preflight failed: ${message}` }, 500);
    }

    if (!preflight.ok) {
      return c.json(
        {
          error: PREFLIGHT_ERROR_MESSAGES[preflight.reason],
          reason: preflight.reason,
          detail: preflight.detail,
          ...(preflight.reason === 'harness-hooks-missing'
            ? { missingHooks: preflight.missingHooks }
            : {}),
        },
        409,
      );
    }

    const canStart = deps.runStore.canStart(ticketId);
    if (!canStart.ok) {
      if (canStart.reason === 'already-running') {
        return c.json({ error: 'run already in progress', reason: 'already-running' }, 409);
      }
      return c.json({ error: 'too many concurrent runs', reason: 'too-many-runs' }, 429);
    }

    // readiness コンテキストの構築は全プロジェクト・全チケットを走査する。以前は拒否される
    // リクエストでも毎回構築していたため、リモートから安価に CPU を焼けた。同時実行スロットで
    // 弾かれるリクエストでは構築しないよう、canStart の後ろへ移した (bdboard-54be.1)。
    // canStart → start() の間に await を挟まない TOCTOU 対策は維持している（間に入れた
    // readiness 判定はすべて同期）。
    // 拒否理由の優先順位: スロット満杯時は blocked/deferred/closed より先に too-many-runs を返す。
    const now = deps.now();
    const ctx = createReadinessContext(
      deps.cache.listProjects().flatMap((entry) => entry.tickets),
    );

    if (ticket.status === 'closed') {
      return c.json({ error: 'ticket is closed', reason: 'closed' }, 409);
    }
    if (isBlocked(ticket, ctx)) {
      return c.json({ error: 'ticket is blocked', reason: 'blocked' }, 409);
    }
    if (isDeferred(ticket, now)) {
      return c.json({ error: 'ticket is deferred', reason: 'deferred' }, 409);
    }

    const startedAt = deps.now();
    const runId = buildRunId(ticketId, mode, startedAt);
    deps.runStore.start({
      id: runId,
      ticketId,
      runner: SPAWN_RUNNER_ID,
      mode,
      startedAt,
    });

    const provisionResult = await provisionRunOrFail(c, deps, {
      repoRootPath: project.rootPath,
      ticketId,
      mainBranch: preflight.mainBranch,
      cleanupEligibleTicketIds,
      runId,
      mode,
      startedAt,
    });
    if (!provisionResult.ok) {
      return provisionResult.response;
    }
    const { runCwd, provision } = provisionResult;

    // claim (bdboard-pkr6.26): worktree はここまでで用意済み。実際にプロセスを
    // spawn する前に claim を試み、失敗したら run を開始しない (409) — run 開始
    // そのものを排他ゲートにする。成功後は spawn 前失敗 (agent-run-dispatch-outcome.ts の
    // isPreSpawnFailure) でだけ unclaim して戻す。
    try {
      await deps.issueWriter.claim(project.rootPath, ticketId);
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
      return c.json({ error: message, reason: 'claim-failed' }, 409);
    }

    const prompt = buildRunPrompt({
      ticketId,
      ticketTitle: ticket.title,
      verify: preflight.verify,
      prFlow: preflight.prFlow,
      mainBranch: preflight.mainBranch,
    });
    const sink = {
      onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => {
        deps.runStore.appendChunk(runId, chunk);
      },
      signal: deps.runStore.getAbortSignal(runId),
    };

    fireAgentRunDispatch(
      deps,
      {
        ticketId,
        projectId: project.id,
        projectRootPath: project.rootPath,
        cwd: runCwd,
        mode,
        prompt,
      },
      runId,
      startedAt,
      sink,
    );

    return c.json(
      {
        runId,
        ticketId,
        status: 'pending',
        worktreePath: provision.worktreePath,
        branchName: provision.branchName,
        reused: provision.reused,
        // drift は止めない。更新が要ることだけ伝える (仕様1)。
        warnings: preflight.warnings,
      },
      202,
    );
  });

  return app;
}
