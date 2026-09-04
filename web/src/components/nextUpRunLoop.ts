import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAgentRun, startTicketRun } from '../api';
import {
  AGENT_RUN_POLL_INTERVAL_MS,
  describeRunStartError,
} from './agentRunShared';

export type NextUpLoopPhase = 'idle' | 'running' | 'stopping';

export interface NextUpLoopProgress {
  currentTicketId: string | null;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  unknownCount: number;
  totalCount: number;
  lastFailureReason: string | null;
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
}): Promise<NextUpLoopProgress> {
  const { ticketIds, isStopRequested, onProgress } = options;
  const progress: NextUpLoopProgress = {
    currentTicketId: null,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    unknownCount: 0,
    totalCount: ticketIds.length,
    lastFailureReason: null,
  };
  onProgress(progress);

  let preserveCurrentTicketId = false;

  for (const ticketId of ticketIds) {
    if (isStopRequested()) {
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
      progress.lastFailureReason = describeRunStartError(error);
      progress.currentTicketId = null;
      onProgress({ ...progress });
      if (await delayUnlessStopped(AGENT_RUN_POLL_INTERVAL_MS, isStopRequested)) {
        break;
      }
      continue;
    }

    const { outcome, lastPollError } = await waitForAgentRunTerminal(
      runId,
      isStopRequested,
    );

    if (outcome === 'stopped') {
      preserveCurrentTicketId = true;
      onProgress({ ...progress });
      break;
    }
    if (outcome === 'poll_failed') {
      progress.unknownCount += 1;
      progress.lastFailureReason = describePollFailureError(lastPollError);
      preserveCurrentTicketId = true;
      onProgress({ ...progress });
      break;
    }

    progress.currentTicketId = null;
    if (outcome === 'succeeded') {
      progress.completedCount += 1;
    } else if (outcome === 'cancelled') {
      progress.cancelledCount += 1;
    } else {
      progress.failedCount += 1;
    }
    onProgress({ ...progress });
  }

  if (!preserveCurrentTicketId) {
    progress.currentTicketId = null;
  }
  onProgress({ ...progress });
  return progress;
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
