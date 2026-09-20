import type { RunOutcome } from '../../application/ports/agent-runner.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import { dispatchRun } from '../../application/runner/dispatch-run.js';
import type { AgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import type { RunStore } from '../../application/runner/run-store.js';
import type { RunPreflightFailureReason } from '../../domain/harness-run-preflight.js';
import type { RunMode } from '../../domain/run.js';

/**
 * agent-run-routes.ts (旧672行) の分割 (bdboard-sso1.27) で、POST /api/runs
 * (agent-run-create-routes.ts) の run 開始ハンドラから、outcome の組み立てと
 * spawn 後の fire-and-forget な dispatchRun 呼び出しをここへ切り出した (move
 * only, 挙動変更ゼロ)。このルート専用のヘルパーで、他グループとは共有しない。
 */

export const SPAWN_RUNNER_ID = 'claude-spawn';

let runIdSequence = 0;

export function buildRunId(ticketId: string, mode: RunMode, startedAt: Date): string {
  runIdSequence += 1;
  return `${ticketId}:${mode}:${startedAt.toISOString()}:${runIdSequence}`;
}

export function buildDispatchFailureOutcome(
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

/**
 * dispatchRun の outcome が「実エージェントプロセスが一度も動き出さないまま失敗した」を
 * 示すかどうか (bdboard-pkr6.26)。RunFailureKind のうち `failed` だけが
 * 「dispatch ran but failed」(agent-runner.ts のコメント) — 残り4種
 * (invalid-request/unsupported/dispatch-disabled/runner-unavailable) は
 * claude-runner.ts の実装上いずれも実プロセスを spawn する前 (または spawn 自体が
 * 失敗した runner-unavailable) に確定する。前者は編集が残っている可能性があるため
 * claim を戻さず、後者だけ unclaim の対象にする。
 */
function isPreSpawnFailure(outcome: RunOutcome): boolean {
  // failureKind is optional on the type; no current runner produces ok:false
  // without one, but treat a hypothetical future gap as "unknown, might have
  // started" rather than "definitely pre-spawn" -- the safe default here is to
  // NOT roll back (matches the same-caution-as-'failed' stance below), since a
  // wrongly-dropped claim while edits exist is worse than a stale in_progress
  // ticket (which stale_in_progress hygiene already reclaims). (opus review,
  // bdboard-pkr6.26 PR #502)
  return !outcome.ok && outcome.failureKind !== undefined && outcome.failureKind !== 'failed';
}

/**
 * spawn 前失敗 (isPreSpawnFailure) のときだけ呼ばれる unclaim ロールバック
 * (bdboard-pkr6.26)。unclaim 自体の失敗はベストエフォートで警告ログに落とし、
 * fire-and-forget の dispatchRun チェーンを unhandled rejection にしない。
 */
async function rollbackClaimAfterPreSpawnFailure(
  issueWriter: IssueWriterPort,
  rootPath: string,
  ticketId: string,
  reason: string,
): Promise<void> {
  try {
    await issueWriter.unclaim(rootPath, ticketId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `bdboard: failed to unclaim ${ticketId} after pre-spawn run failure (${reason}): ${message}`,
    );
  }
}

/** preflight 失敗の英語ラベル。`reason` が機械可読側で、こちらは既存 409 と同じ体裁の `error`。 */
export const PREFLIGHT_ERROR_MESSAGES: Record<RunPreflightFailureReason, string> = {
  'harness-not-injected': 'harness pack is not injected',
  'harness-hooks-missing': 'harness hooks are not registered',
  'harness-contract-missing': 'harness verification contract is missing',
  'harness-contract-invalid': 'harness verification contract is invalid',
};

export interface FireAgentRunDispatchDeps {
  readonly registry: AgentRunnerRegistry;
  readonly runStore: RunStore;
  readonly now: () => Date;
  readonly issueWriter: IssueWriterPort;
}

export interface FireAgentRunDispatchRequest {
  readonly ticketId: string;
  readonly projectId: string;
  readonly projectRootPath: string;
  readonly cwd: string;
  readonly mode: RunMode;
  readonly prompt: string;
}

export interface AgentRunDispatchSink {
  readonly onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
  readonly signal: AbortSignal | undefined;
}

/**
 * claim 成功後、プロンプト・sink を渡して dispatchRun を fire-and-forget で起動する。
 * POST /api/runs ハンドラの `void dispatchRun(...).then().catch()` チェーンを
 * そのまま移した (move only, 挙動変更ゼロ)。
 */
export function fireAgentRunDispatch(
  deps: FireAgentRunDispatchDeps,
  request: FireAgentRunDispatchRequest,
  runId: string,
  startedAt: Date,
  sink: AgentRunDispatchSink,
): void {
  const { ticketId, projectId, projectRootPath, cwd, mode, prompt } = request;

  void dispatchRun(
    deps.registry,
    {
      ticketId,
      projectId,
      cwd,
      mode,
      prompt,
    },
    deps.now,
    sink,
  )
    .then(async (outcome) => {
      deps.runStore.finish(runId, outcome);
      if (isPreSpawnFailure(outcome)) {
        await rollbackClaimAfterPreSpawnFailure(
          deps.issueWriter,
          projectRootPath,
          ticketId,
          `dispatch outcome failureKind=${outcome.failureKind ?? 'unknown'}`,
        );
      }
    })
    .catch(async (error: unknown) => {
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
      // dispatchRun 自身の try/catch は各 runner.dispatch() 呼び出しを個別に
      // 包んでおり、runner-unavailable/failed 等は outcome として返る (上の
      // .then() 側)。ここに来るのはそれより手前 (registry.resolve() 等) の
      // 例外であり、実プロセスが spawn される前に確定している — 常に unclaim
      // してよい。
      await rollbackClaimAfterPreSpawnFailure(
        deps.issueWriter,
        projectRootPath,
        ticketId,
        'dispatchRun rejected before any runner dispatched',
      );
    });
}
