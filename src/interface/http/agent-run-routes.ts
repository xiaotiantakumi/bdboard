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
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import {
  evaluateRunPreflight,
  type RunPreflightFailureReason,
  type RunPreflightOutcome,
} from '../../domain/harness-run-preflight.js';
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
  /**
   * spawn 直前の cwd ガードで使うパス正規化。composition root (src/main.ts) が
   * infrastructure の `normalizePathForComparison` (realpath) を注入する。
   * interface 層から infrastructure を直 import できない (check:boundaries の
   * `interface-no-infrastructure`) ので依存として受け取る。
   * 必須依存にしてあるのは、省略できると symlink 越しのプロジェクトで再利用 worktree が
   * 弾かれる不具合 (major-1) に黙って戻れてしまうため。正規化不要な呼び出し元は
   * 恒等関数を明示的に渡すこと。
   */
  readonly normalizePath: (pathValue: string) => string;
  /**
   * リポジトリ根のハーネス状態を読む application 層の use case
   * (`readProjectHarnessStatus`)。preflight (bdboard-pkr6.11) の入力で、
   * interface 層から infrastructure を直接触らないために注入で受ける。
   * 判定に使うのは **worktree ではなくリポジトリ根**の `.claude/`。
   */
  readonly getHarnessStatus: (repoRootPath: string) => Promise<ProjectHarnessStatus>;
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

/** preflight 失敗の英語ラベル。`reason` が機械可読側で、こちらは既存 409 と同じ体裁の `error`。 */
const PREFLIGHT_ERROR_MESSAGES: Record<RunPreflightFailureReason, string> = {
  'harness-not-injected': 'harness pack is not injected',
  'harness-hooks-missing': 'harness hooks are not registered',
  'harness-contract-missing': 'harness verification contract is missing',
  'harness-contract-invalid': 'harness verification contract is invalid',
};

/**
 * run 完了後に人が回す検証コマンドの提示 (bdboard-pkr6.11 仕様4)。
 *
 * 出すのは `succeeded` のときだけ。実行中は意味が無く (毎回のポーリングで
 * `.claude/` を読み直す理由も無い)、`failed` / `cancelled` で「次に実行:
 * npm run verify」を出すのは、編集が中断・破棄されているかもしれない状態で
 * 検証を促す誤った導線になる。ハーネス状態が読めない/前提を満たさなく
 * なっている場合も黙って省く: ここは導線であって、ログ表示を巻き添えに
 * 失敗させる価値は無い。
 */
async function resolveRunNextStep(
  deps: AgentRunRoutesDeps,
  record: RunStoreRecord,
): Promise<{ verify: string; worktreePath: string } | undefined> {
  if (record.status !== 'succeeded' || record.cwd === '') {
    return undefined;
  }

  const resolved = findTicket(deps.cache, record.ticketId);
  if (resolved === undefined) {
    return undefined;
  }

  try {
    const preflight = evaluateRunPreflight(
      await deps.getHarnessStatus(resolved.project.rootPath),
    );
    if (!preflight.ok) {
      return undefined;
    }
    return { verify: preflight.verify, worktreePath: record.cwd };
  } catch {
    return undefined;
  }
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
      project.rootPath,
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
      return c.json({ error: message }, 500);
    }

    const prompt = buildRunPrompt({
      ticketId,
      ticketTitle: ticket.title,
      verify: preflight.verify,
      prFlow: preflight.prFlow,
    });
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
        cwd: runCwd,
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
        // drift は止めない。更新が要ることだけ伝える (仕様1)。
        warnings: preflight.warnings,
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

  app.get('/api/runs/:runId', async (c) => {
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
    // nextStep は worktree の絶対パスを含むので、cwd と同じくローカル限定にする。
    const nextStep = local ? await resolveRunNextStep(deps, record) : undefined;
    return c.json({
      ...toRunSummaryDto(record),
      cwd: local ? record.cwd : undefined,
      log: local ? tailLogByBytes(record.log, tailBytes) : '',
      logRestricted: local ? undefined : true,
      nextStep,
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
