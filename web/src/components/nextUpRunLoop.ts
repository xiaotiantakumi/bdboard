import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAgentRun, postTicketComment, startTicketRun } from '../api';
import {
  AGENT_RUN_POLL_INTERVAL_MS,
  describeRunStartError,
} from './agentRunShared';

export type NextUpLoopPhase = 'idle' | 'running' | 'stopping';

export type NextUpLoopEndReason =
  | 'completed'
  | 'stopped'
  | 'poll_failed'
  | 'consecutive_failures';

export interface NextUpLoopProgress {
  currentTicketId: string | null;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  unknownCount: number;
  totalCount: number;
  lastFailureReason: string | null;
  endReason: NextUpLoopEndReason | null;
}

export interface NextUpRunLoopController {
  phase: NextUpLoopPhase;
  progress: NextUpLoopProgress;
  beginBatchRun: (ticketIds: readonly string[]) => void;
  stopBatchRun: () => void;
}

export const INITIAL_NEXT_UP_LOOP_PROGRESS: NextUpLoopProgress = {
  currentTicketId: null,
  completedCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  unknownCount: 0,
  totalCount: 0,
  lastFailureReason: null,
  endReason: null,
};

export type AgentRunTerminalOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'poll_failed'
  | 'stopped';

export interface AgentRunTerminalResult {
  outcome: AgentRunTerminalOutcome;
  lastPollError?: unknown;
}

/** Loop-side poll threshold — separate from TicketDetailPanel's AGENT_RUN_POLL_MAX_FAILURES. */
export const NEXT_UP_LOOP_POLL_MAX_FAILURES = 15;

/** 連続失敗の上限。これに達した時点でバッチを止める（verification.md の
 * 「2回連続で失敗したら記録して手を止める」と揃える）。
 * cancelled はカウンタを増減しないので、厳密には「直近 N 件が失敗」である。
 *
 * この値は利用者向けの文言にも出る。定数を埋め込めない箇所は以下だけなので、
 * 値を変えたらここも直すこと:
 * - docs/help-content.json の `agent-runs` セクション（「直近2件が失敗した場合は…」）
 * - web/src/components/nextUpRunLoop.test.ts の文言アサーション（意図的な固定値） */
export const NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES = 2;

/** 停止コメント投稿の待ち上限。これを超えたら投稿を諦めてループを畳む。
 * 上限が無いと、ハングした POST が runNextUpTicketLoop を resolve させず、
 * useNextUpRunLoopController の finally に到達しないため loopActiveRef が
 * true のまま張り付き、一括実行ボタンがリロードするまで復帰しない。 */
export const NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS = 10_000;

export function describeConsecutiveFailureStop(
  lastFailureReason: string | null,
): string {
  const suffix =
    lastFailureReason !== null && lastFailureReason.length > 0
      ? `（最後の失敗: ${lastFailureReason}）`
      : '';
  return `直近${NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES}件が失敗したためバッチを停止しました${suffix}`;
}

export function buildConsecutiveFailureComment(
  failedTicketIds: readonly string[],
  lastFailureReason: string | null,
): string {
  const ids = failedTicketIds.join(', ');
  const reasonLine =
    lastFailureReason !== null && lastFailureReason.length > 0
      ? `最後の失敗理由: ${lastFailureReason}`
      : // Loop callers always pass a non-empty lastFailureReason; fallback for standalone use.
        '最後の失敗理由: （不明）';
  return `[harness] bdboard の一括実行（Next Up）で直近${NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES}件が失敗したためバッチを停止しました。\n失敗したチケット: ${ids}\n${reasonLine}`;
}

export const NEXT_UP_LOOP_POLL_MAX_DELAY_MS = 30_000;

export function nextUpLoopPollDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return AGENT_RUN_POLL_INTERVAL_MS;
  }
  const delay =
    AGENT_RUN_POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(delay, NEXT_UP_LOOP_POLL_MAX_DELAY_MS);
}

export function describePollFailureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `実行状況を確認できませんでした（${message}）。バッチを停止しました。`;
}

export function isAgentRunTerminal(
  status: string,
): status is Exclude<AgentRunTerminalOutcome, 'poll_failed' | 'stopped'> {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function delayUnlessStopped(
  ms: number,
  isStopRequested: () => boolean,
): Promise<boolean> {
  if (isStopRequested()) {
    return true;
  }
  await delay(ms);
  return isStopRequested();
}

export async function waitForAgentRunTerminal(
  runId: string,
  isStopRequested: () => boolean,
): Promise<AgentRunTerminalResult> {
  let consecutiveFailures = 0;

  while (true) {
    if (isStopRequested()) {
      return { outcome: 'stopped' };
    }

    try {
      const detail = await fetchAgentRun(runId);
      consecutiveFailures = 0;
      if (isAgentRunTerminal(detail.status)) {
        return { outcome: detail.status };
      }
    } catch (pollError) {
      console.error('Failed to poll agent run', pollError);
      consecutiveFailures += 1;
      if (consecutiveFailures >= NEXT_UP_LOOP_POLL_MAX_FAILURES) {
        return { outcome: 'poll_failed', lastPollError: pollError };
      }
    }

    const pollDelayMs = nextUpLoopPollDelayMs(consecutiveFailures);
    if (await delayUnlessStopped(pollDelayMs, isStopRequested)) {
      return { outcome: 'stopped' };
    }
  }
}

export async function runNextUpTicketLoop(options: {
  ticketIds: readonly string[];
  isStopRequested: () => boolean;
  onProgress: (progress: NextUpLoopProgress) => void;
  postComment?: (ticketId: string, text: string) => Promise<void>;
}): Promise<NextUpLoopProgress> {
  const {
    ticketIds,
    isStopRequested,
    onProgress,
    postComment = postTicketComment,
  } = options;
  const progress: NextUpLoopProgress = {
    currentTicketId: null,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    unknownCount: 0,
    totalCount: ticketIds.length,
    lastFailureReason: null,
    endReason: null,
  };
  // Every emission is a fresh copy. `progress` below is a single mutable
  // accumulator that the loop keeps writing to, so handing the object itself to
  // a subscriber would put a live pointer into React state and let later
  // iterations rewrite a value the caller already received (bdboard-54be.6).
  onProgress({ ...progress });

  let preserveCurrentTicketId = false;
  let endReason: NextUpLoopEndReason = 'completed';
  let consecutiveFailureCount = 0;
  const consecutiveFailedTicketIds: string[] = [];

  const resetConsecutiveFailures = (): void => {
    consecutiveFailureCount = 0;
    consecutiveFailedTicketIds.length = 0;
    // lastFailureReason は意図的に残す (pkr6.12 の m6.2 却下 / pkr6.17 の議長裁定)。
    // 失敗文言にはチケット ID が入っているので、fail → success で完走したバッチでも
    // 「どのチケットがなぜ失敗したか」を最後まで読めるようにしておく。
  };

  const tryStopOnConsecutiveFailures = async (
    ticketId: string,
    failureReason: string,
  ): Promise<boolean> => {
    consecutiveFailureCount += 1;
    consecutiveFailedTicketIds.push(ticketId);

    if (consecutiveFailureCount < NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES) {
      progress.lastFailureReason = failureReason;
      return false;
    }

    progress.lastFailureReason = describeConsecutiveFailureStop(failureReason);
    progress.currentTicketId = null;
    endReason = 'consecutive_failures';
    // Emit before posting the comment: postTicketComment/fetchJson has no timeout and no
    // AbortSignal, so a hung POST would otherwise delay this final emission by up to
    // NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS.
    onProgress({ ...progress });
    try {
      // Bound the wait with Promise.race rather than an AbortSignal: postComment is an
      // injected (ticketId, text) => Promise<void>, and threading a signal would mean
      // changing that contract plus postTicketComment/fetchJson, neither of which takes one.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `comment post timed out after ${NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS}ms`,
            ),
          );
        }, NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS);
      });
      try {
        await Promise.race([
          postComment(
            ticketId,
            buildConsecutiveFailureComment(
              consecutiveFailedTicketIds,
              failureReason,
            ),
          ),
          timeout,
        ]);
      } finally {
        clearTimeout(timeoutHandle);
      }
    } catch (commentError) {
      // Batch stop must not depend on comment delivery — progress/endReason is the contract,
      // and the stop was already emitted above. Surface the delivery failure in
      // lastFailureReason so the final emission tells the user the ticket has no comment.
      // Timeouts merge here too — same user-visible outcome as a rejected post.
      console.error('Failed to post consecutive-failure comment', commentError);
      progress.lastFailureReason = `${progress.lastFailureReason ?? ''}（チケットへのコメント投稿に失敗しました）`;
    }
    return true;
  };

  for (const ticketId of ticketIds) {
    if (isStopRequested()) {
      endReason = 'stopped';
      break;
    }

    progress.currentTicketId = ticketId;
    onProgress({ ...progress });

    let runId: string;
    try {
      const response = await startTicketRun(ticketId);
      runId = response.runId;
    } catch (error) {
      progress.failedCount += 1;
      const failureReason = describeRunStartError(error);
      progress.currentTicketId = null;
      if (await tryStopOnConsecutiveFailures(ticketId, failureReason)) {
        break;
      }
      onProgress({ ...progress });
      if (await delayUnlessStopped(AGENT_RUN_POLL_INTERVAL_MS, isStopRequested)) {
        endReason = 'stopped';
        break;
      }
      continue;
    }

    const { outcome, lastPollError } = await waitForAgentRunTerminal(
      runId,
      isStopRequested,
    );

    if (outcome === 'stopped') {
      endReason = 'stopped';
      preserveCurrentTicketId = true;
      onProgress({ ...progress });
      break;
    }
    if (outcome === 'poll_failed') {
      endReason = 'poll_failed';
      progress.unknownCount += 1;
      progress.lastFailureReason = describePollFailureError(lastPollError);
      preserveCurrentTicketId = true;
      onProgress({ ...progress });
      break;
    }

    progress.currentTicketId = null;
    if (outcome === 'succeeded') {
      progress.completedCount += 1;
      resetConsecutiveFailures();
      onProgress({ ...progress });
    } else if (outcome === 'cancelled') {
      progress.cancelledCount += 1;
      // Manual cancellation is not a harness failure signal — leave the streak counter unchanged.
      onProgress({ ...progress });
    } else {
      progress.failedCount += 1;
      const failureReason = `エージェント実行が失敗しました（${ticketId}）`;
      if (await tryStopOnConsecutiveFailures(ticketId, failureReason)) {
        break;
      }
      onProgress({ ...progress });
    }
  }

  if (!preserveCurrentTicketId) {
    progress.currentTicketId = null;
  }
  progress.endReason = endReason;
  onProgress({ ...progress });
  // Copy for the same reason as the emissions above. No current caller stores
  // this value, but it is the exported return type, so leaking the accumulator
  // here would reintroduce the hazard the moment one does.
  return { ...progress };
}

export function useNextUpRunLoopController(): NextUpRunLoopController {
  const [phase, setPhase] = useState<NextUpLoopPhase>('idle');
  const [progress, setProgress] = useState<NextUpLoopProgress>(
    INITIAL_NEXT_UP_LOOP_PROGRESS,
  );
  const stopRequestedRef = useRef(false);
  const loopActiveRef = useRef(false);
  const loopRunIdRef = useRef(0);

  const beginBatchRun = useCallback((ticketIds: readonly string[]) => {
    if (ticketIds.length === 0 || loopActiveRef.current) {
      return;
    }

    const runId = loopRunIdRef.current + 1;
    loopRunIdRef.current = runId;
    stopRequestedRef.current = false;
    loopActiveRef.current = true;
    setPhase('running');
    setProgress({
      ...INITIAL_NEXT_UP_LOOP_PROGRESS,
      totalCount: ticketIds.length,
    });

    void (async () => {
      try {
        await runNextUpTicketLoop({
          ticketIds,
          isStopRequested: () => stopRequestedRef.current,
          onProgress: (nextProgress) => {
            // Generation guard (bdboard-54be.4 M3 / 54be.2 R10): drop progress from a
            // loop whose runId was invalidated. loopRunIdRef advances only when (1)
            // beginBatchRun starts a new batch after the previous loop finished, or
            // (2) useEffect cleanup runs on controller unmount while a loop is in flight.
            // (1) cannot produce a late onProgress — runNextUpTicketLoop resolves only
            //     after its synchronous onProgress calls complete, and beginBatchRun
            //     refuses to start while loopActiveRef is still true.
            // (2) can call onProgress after invalidation, but the closure's setProgress
            //     targets an unmounted hook instance; React 18 treats that as a silent
            //     no-op, so removing this guard is not observable in integration tests.
            // Kept as defence-in-depth if a future render path shares state across remounts.
            if (loopRunIdRef.current !== runId) {
              return;
            }
            setProgress(nextProgress);
          },
        });
      } finally {
        if (loopRunIdRef.current === runId) {
          stopRequestedRef.current = false;
          loopActiveRef.current = false;
          setPhase('idle');
        }
      }
    })();
  }, []);

  const stopBatchRun = useCallback(() => {
    // The ref, rather than rendered `phase`, is the source of truth. A stop
    // click can race the final queued idle render; consulting state here can
    // leave the UI stuck in `stopping` after the loop has already exited.
    if (!loopActiveRef.current) {
      return;
    }
    // This flag reaches waitForAgentRunTerminal, so stop means both "do not
    // advance" and "stop waiting". The server-side run itself is untouched.
    stopRequestedRef.current = true;
    setPhase('stopping');
  }, []);

  useEffect(() => {
    return () => {
      // The controller is owned by App, not NextUpView. Consequently a view
      // switch does not run this cleanup; only leaving the whole app ends the
      // client-side loop and invalidates late progress from its generation.
      stopRequestedRef.current = true;
      loopRunIdRef.current += 1;
      loopActiveRef.current = false;
    };
  }, []);

  return { phase, progress, beginBatchRun, stopBatchRun };
}
