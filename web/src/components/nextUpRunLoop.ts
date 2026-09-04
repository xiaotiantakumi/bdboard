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
