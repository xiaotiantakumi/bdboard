import { fetchAgentRun } from '../../../api';
import { AGENT_RUN_POLL_INTERVAL_MS } from '../../agentRunShared';
import type { AgentRunTerminalOutcome, AgentRunTerminalResult } from './types';

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

// Exported (was module-private before the split): runNextUpTicketLoop in ./loop.ts also
// calls this directly (not just through waitForAgentRunTerminal), so it must cross the
// module boundary. Not part of the public barrel re-export (nextUpRunLoop.ts) surface.
export async function delayUnlessStopped(
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
