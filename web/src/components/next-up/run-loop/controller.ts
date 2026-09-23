import { useCallback, useEffect, useRef, useState } from 'react';
import { INITIAL_NEXT_UP_LOOP_PROGRESS } from './progress';
import { runNextUpTicketLoop } from './loop';
import type {
  NextUpLoopPhase,
  NextUpLoopProgress,
  NextUpRunLoopController,
  NextUpRunLoopControllerOptions,
} from './types';

export function useNextUpRunLoopController(
  options: NextUpRunLoopControllerOptions = {},
): NextUpRunLoopController {
  const { onTicketRunsChanged } = options;
  // beginBatchRun は依存無しで安定させているので、最新のリスナーは ref 経由で読む。
  const onTicketRunsChangedRef = useRef(onTicketRunsChanged);
  onTicketRunsChangedRef.current = onTicketRunsChanged;
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
          onTicketRunsChanged: (ticketId) => {
            onTicketRunsChangedRef.current?.(ticketId);
          },
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
