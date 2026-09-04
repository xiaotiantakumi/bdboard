import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import type { RunOutcome } from '../../application/ports/agent-runner.js';
import type { WorktreeProvisioner } from '../../application/ports/worktree-provisioner.js';
import { buildRunPrompt } from '../../application/runner/build-run-prompt.js';
import { dispatchRun } from '../../application/runner/dispatch-run.js';
import { validateProvisionedRunCwd } from '../../application/runner/validate-run-request.js';
import type { AgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import type { RunStore, RunStoreRecord } from '../../application/runner/run-store.js';
import type { RunMode } from '../../domain/run.js';
import {
  createReadinessContext,
  isBlocked,
  isDeferred,
} from '../../domain/readiness.js';
import type { Ticket } from '../../domain/ticket.js';
import {
  createAgentRunRateLimitMiddleware,
  createChatRateLimiter,
  DEFAULT_AGENT_RUN_RATE_LIMIT_PER_DAY,
  DEFAULT_AGENT_RUN_RATE_LIMIT_PER_MINUTE,
} from './agent-run-rate-limit.js';
import { createAgentRunGuardMiddleware } from './agent-run-guard.js';
import { isLocalBasicAuthRequest } from './local-request.js';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import { parseJsonBody } from './request-body.js';
import type { WriteGuardDeps } from './write-guard.js';

/** postRunsBodySchema は ticketId と mode だけなので 4KB で十分すぎる。 */
export const AGENT_RUN_BODY_MAX_BYTES = 4 * 1024;

const SPAWN_RUNNER_ID = 'claude-spawn';
const DEFAULT_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;

const postRunsBodySchema = z.object({
  ticketId: z.string().min(1),
  mode: z.literal('spawn').optional(),
});

export interface AgentRunRoutesDeps {
  readonly cache: BoardCache;
  readonly registry: AgentRunnerRegistry;
  readonly runStore: RunStore;
  readonly worktreeProvisioner: WorktreeProvisioner;
  readonly writeAccess?: WriteGuardDeps;
  readonly isRemoteAgentRunAllowed: () => Promise<boolean>;
  readonly now: () => Date;
  readonly rateLimit?: {
    readonly perMinute?: number;
    readonly perDay?: number;
  };
}

export interface RunSummaryDto {
  readonly id: string;
  readonly ticketId: string;
  readonly runner: string;
  readonly mode: RunMode;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

interface ResolvedTicket {
  readonly project: CachedProject['project'];
  readonly ticket: Ticket;
  readonly cleanupEligibleTicketIds: readonly string[];
}

let runIdSequence = 0;

function buildRunId(ticketId: string, mode: RunMode, startedAt: Date): string {
  runIdSequence += 1;
  return `${ticketId}:${mode}:${startedAt.toISOString()}:${runIdSequence}`;
}

function tailLogByBytes(log: string, tailBytes: number): string {
  if (utf8ByteLength(log) <= tailBytes) {
    return log;
  }

  const bytes = new TextEncoder().encode(log);
  const tail = bytes.slice(bytes.length - tailBytes);

  for (let offset = 0; offset < tail.length; offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(tail.slice(offset));
    } catch {
      // skip a broken leading byte from slicing mid-codepoint
    }
  }

  return '';
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function toRunSummaryDto(record: RunStoreRecord): RunSummaryDto {
  return {
    id: record.id,
    ticketId: record.ticketId,
    runner: record.runner,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString(),
    exitCode: record.exitCode,
    error: record.error,
  };
}

function findTicket(cache: BoardCache, ticketId: string): ResolvedTicket | undefined {
  for (const entry of cache.listProjects()) {
    const ticket = entry.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) {
      return {
        project: entry.project,
        ticket,
        cleanupEligibleTicketIds: entry.tickets
          .filter((candidate) => candidate.status === 'closed')
          .map((candidate) => candidate.id),
      };
    }
  }
  return undefined;
}

function buildDispatchFailureOutcome(
  runId: string,
  ticketId: string,
  mode: RunMode,
  startedAt: Date,
  error: string,
  finishedAt: Date,
): RunOutcome {
  return {
    ok: false,
    failureKind: 'failed',
    error,
    run: {
      id: runId,
      ticketId,
      runner: SPAWN_RUNNER_ID,
      mode,
      status: 'failed',
      startedAt,
      finishedAt,
    },
  };
}

export function createAgentRunRoutes(deps: AgentRunRoutesDeps): Hono {
  const app = new Hono();

  // Hono の app.route('/', sub) はサブアプリの '*' を親の '/*' として再登録するため、
  // '*' で登録すると main.ts でこのマウントより後に登録される全ハンドラ
  // (tunnel / update-check / ai-quota / chat / serveStatic / SPA フォールバック) に
  // ガードが漏れる。実測でリモートからボードが全損した。自分の持ちパスにだけ
  // スコープすること。コレクションとワイルドカードの両方を登録するのは
  // main.ts / chat-routes.ts と同じ作法 (掛け忘れ防止)。
  const agentRunGuard = createAgentRunGuardMiddleware({
    writeAccess: deps.writeAccess,
    isRemoteAgentRunAllowed: deps.isRemoteAgentRunAllowed,
  });
  for (const pattern of ['/api/runs', '/api/runs/*']) {
    app.use(pattern, agentRunGuard);
  }

  const limiter = createChatRateLimiter({
    now: deps.now,
    perMinute:
      deps.rateLimit?.perMinute ?? DEFAULT_AGENT_RUN_RATE_LIMIT_PER_MINUTE,
    perDay: deps.rateLimit?.perDay ?? DEFAULT_AGENT_RUN_RATE_LIMIT_PER_DAY,
  });
  const rateLimit = createAgentRunRateLimitMiddleware(limiter);
  const agentRunBodyLimit = bodyLimit({
    maxSize: AGENT_RUN_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  });

  // Hono の app.use('/api/runs', mw) は /api/runs 完全一致のみ。/api/runs/:runId や
  // /api/runs/:runId/cancel には掛けない — 前者は GET のログ取得、後者は子プロセスを
  // 増やさない安価な操作。ガードより後に置き、未認可リクエストがレート枠を消費しないようにする。
  app.use('/api/runs', agentRunBodyLimit);
  app.use('/api/runs', rateLimit);

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

    let provision;
    try {
      provision = await deps.worktreeProvisioner.provision({
        repoRootPath: project.rootPath,
        ticketId,
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
      return c.json({ error: message }, 500);
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
        return c.json({ error: provisionError }, 400);
      }
      if (provision.reason === 'worktree-dirty') {
        // Carry `reason` like the sibling 409s above, so clients switch on a stable
        // token instead of pattern-matching the human-readable message.
        return c.json({ error: provisionError, reason: 'worktree-dirty' }, 409);
      }
      if (provision.reason === 'worktree-branch-mismatch') {
        return c.json({ error: provisionError, reason: 'worktree-branch-mismatch' }, 409);
      }
      if (provision.reason === 'worktree-limit-reached') {
        return c.json({ error: provisionError, reason: 'worktree-limit-reached' }, 409);
      }
      return c.json({ error: provisionError }, 500);
    }

    deps.runStore.updateCwd(runId, provision.worktreePath);

    // Defensive check at the provision→dispatch boundary. Under normal operation
    // this does not fire; it stops spawn when the provisioner returns a path
    // outside the managed `.claude/worktrees/<ticketId>` layout. The cwd is
    // recorded just above *before* this check on purpose: if the guard ever does
    // fire, the rejected path is the single most useful thing to have kept, and
    // the run is finished as failed anyway.
    //
    // The first two arguments are deliberately the same value today: cwd is
    // currently *derived* from provision.worktreePath, so the equality half of
    // the check is trivially true here. Do not collapse the signature — the
    // equality check is what catches a future change that sources cwd from the
    // request instead, which is precisely the regression this guard exists for.
    const cwdValidationError = validateProvisionedRunCwd(
      provision.worktreePath,
      provision.worktreePath,
      ticketId,
      project.rootPath,
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
      return c.json({ error: message }, 500);
    }

    const prompt = buildRunPrompt({ ticketId, ticketTitle: ticket.title });
    const sink = {
      onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => {
        deps.runStore.appendChunk(runId, chunk);
      },
      signal: deps.runStore.getAbortSignal(runId),
    };

    void dispatchRun(
      deps.registry,
      {
        ticketId,
        projectId: project.id,
        cwd: provision.worktreePath,
        mode,
        prompt,
      },
      deps.now,
      sink,
    )
      .then((outcome) => {
        deps.runStore.finish(runId, outcome);
      })
      .catch((error: unknown) => {
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
      });

    return c.json(
      {
        runId,
        ticketId,
        status: 'pending',
        worktreePath: provision.worktreePath,
        branchName: provision.branchName,
        reused: provision.reused,
      },
      202,
    );
  });

  app.get('/api/runs', (c) => {
    const ticketId = c.req.query('ticketId');
    const records = deps.runStore.list(
      ticketId !== undefined && ticketId !== '' ? { ticketId } : undefined,
    );

    const runs = [...records]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map(toRunSummaryDto);

    return c.json({ runs });
  });

  app.get('/api/runs/:runId', (c) => {
    const runId = c.req.param('runId');
    const record = deps.runStore.get(runId);
    if (record === undefined) {
      return c.json({ error: 'run not found' }, 404);
    }

    const tailBytes = parseClampedIntQueryParam(c.req.query('tailBytes'), {
      min: 1,
      max: MAX_TAIL_BYTES,
      defaultValue: DEFAULT_TAIL_BYTES,
    });

    // Read/Glob/Grep はログに任意ファイルの内容を載せうる。ログをリモートへ返すと
    // それが exfiltration チャネルになるので、ログ本文と cwd はローカルアクセス限定にする
    // (bdboard-54be.1 M-1)。リモートからは状態 (running/succeeded/failed) は見える。
    const local = isLocalBasicAuthRequest(c);
    return c.json({
      ...toRunSummaryDto(record),
      cwd: local ? record.cwd : undefined,
      log: local ? tailLogByBytes(record.log, tailBytes) : '',
      logRestricted: local ? undefined : true,
    });
  });

  app.post('/api/runs/:runId/cancel', (c) => {
    const runId = c.req.param('runId');
    const record = deps.runStore.get(runId);
    if (record === undefined) {
      // Unknown run ids are 404 so clients can distinguish stale ids from finished runs.
      return c.json({ error: 'run not found' }, 404);
    }

    if (record.status !== 'running') {
      return c.json({ error: 'run is not running' }, 409);
    }

    const cancelled = deps.runStore.cancel(runId);
    return c.json({ runId, status: cancelled?.status ?? 'cancelling' }, 202);
  });

  return app;
}
