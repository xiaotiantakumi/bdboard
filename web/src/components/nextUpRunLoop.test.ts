import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunDetailDto } from '../api';
import { fetchAgentRun, startTicketRun } from '../api';
import { AGENT_RUN_POLL_INTERVAL_MS } from './agentRunShared';
import {
  NEXT_UP_LOOP_POLL_MAX_DELAY_MS,
  NEXT_UP_LOOP_POLL_MAX_FAILURES,
  nextUpLoopPollDelayMs,
  runNextUpTicketLoop,
  type NextUpLoopProgress,
  waitForAgentRunTerminal,
} from './nextUpRunLoop';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    startTicketRun: vi.fn(),
    fetchAgentRun: vi.fn(),
  };
});

const mockFetchAgentRun = vi.mocked(fetchAgentRun);
const mockStartTicketRun = vi.mocked(startTicketRun);

function makeRunDetail(
  runId: string,
  ticketId: string,
  status: AgentRunDetailDto['status'],
): AgentRunDetailDto {
  return {
    id: runId,
    ticketId,
    runner: 'claude',
    mode: 'spawn',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    cwd: `/tmp/worktrees/${ticketId}`,
    log: '',
  };
}

async function advanceAfterPollFailure(
  consecutiveFailures: number,
): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(nextUpLoopPollDelayMs(consecutiveFailures));
}

async function advanceThroughPollFailures(
  failureCount: number,
): Promise<void> {
  for (let failures = 1; failures <= failureCount; failures += 1) {
    await advanceAfterPollFailure(failures);
  }
}

async function finishLoopWithTimers(
  loopPromise: Promise<unknown>,
  maxTicks = NEXT_UP_LOOP_POLL_MAX_FAILURES * 4,
): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const raced = await Promise.race([
      loopPromise.then(() => 'done' as const),
      vi
        .advanceTimersByTimeAsync(NEXT_UP_LOOP_POLL_MAX_DELAY_MS)
        .then(() => 'tick' as const),
    ]);
    if (raced === 'done') {
      return;
    }
  }
  throw new Error('loop did not finish within timer budget');
}

describe('nextUpRunLoop', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStartTicketRun.mockImplementation(async (ticketId) => ({
      runId: `run-${ticketId}`,
      ticketId,
      status: 'pending',
      worktreePath: `/tmp/worktrees/${ticketId}`,
      branchName: `bd/${ticketId}`,
      reused: false,
    }));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('waitForAgentRunTerminal', () => {
    it('resets the failure counter after N-1 failures then a successful poll', async () => {
      const pollError = new Error('transient poll error');
      let callCount = 0;
      const maxFailures = NEXT_UP_LOOP_POLL_MAX_FAILURES;

      mockFetchAgentRun.mockImplementation(async () => {
        callCount += 1;
        if (callCount <= maxFailures - 1) {
          throw pollError;
        }
        if (callCount === maxFailures) {
          return makeRunDetail('run-1', 'ticket-1', 'running');
        }
        if (callCount <= maxFailures + (maxFailures - 1)) {
          throw pollError;
        }
        return makeRunDetail('run-1', 'ticket-1', 'succeeded');
      });

      const resultPromise = waitForAgentRunTerminal('run-1', () => false);
      await Promise.resolve();
      await advanceThroughPollFailures(maxFailures - 1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(nextUpLoopPollDelayMs(0));
      await advanceThroughPollFailures(maxFailures - 1);
      await Promise.resolve();

      const result = await resultPromise;
      expect(result.outcome).toBe('succeeded');
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(
        maxFailures + (maxFailures - 1) + 1,
      );
    });

    it('returns poll_failed after N consecutive failures and not before', async () => {
      const pollError = new Error('persistent poll error');
      let callCount = 0;
      let reachedNMinus1: (() => void) | undefined;
      const atNMinus1 = new Promise<void>((resolve) => {
        reachedNMinus1 = resolve;
      });

      mockFetchAgentRun.mockImplementation(async () => {
        callCount += 1;
        if (callCount === NEXT_UP_LOOP_POLL_MAX_FAILURES - 1) {
          reachedNMinus1!();
        }
        throw pollError;
      });

      const resultPromise = waitForAgentRunTerminal('run-1', () => false);

      while (callCount < NEXT_UP_LOOP_POLL_MAX_FAILURES - 1) {
        await vi.advanceTimersByTimeAsync(NEXT_UP_LOOP_POLL_MAX_DELAY_MS);
        await Promise.resolve();
      }

      await atNMinus1;
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(callCount).toBe(NEXT_UP_LOOP_POLL_MAX_FAILURES - 1);

      await vi.advanceTimersByTimeAsync(NEXT_UP_LOOP_POLL_MAX_DELAY_MS);
      await Promise.resolve();

      const result = await resultPromise;
      expect(result.outcome).toBe('poll_failed');
      expect(result.lastPollError).toBe(pollError);
      expect(callCount).toBe(NEXT_UP_LOOP_POLL_MAX_FAILURES);
    });

    it('returns stopped when stop is requested during the poll delay', async () => {
      let stopRequested = false;
      mockFetchAgentRun.mockResolvedValue(
        makeRunDetail('run-1', 'ticket-1', 'running'),
      );

      const resultPromise = waitForAgentRunTerminal('run-1', () => stopRequested);
      await Promise.resolve();
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(1);

      stopRequested = true;
      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS);

      const result = await resultPromise;
      expect(result.outcome).toBe('stopped');
    });
  });

  describe('runNextUpTicketLoop', () => {
    it('does not start the next ticket when polling fails', async () => {
      const pollError = new Error('persistent poll error');
      mockFetchAgentRun.mockRejectedValue(pollError);

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: () => {},
      });

      await finishLoopWithTimers(loopPromise);
      const result = (await loopPromise) as NextUpLoopProgress;
      expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
      expect(result.unknownCount).toBe(1);
      expect(result.endReason).toBe('poll_failed');
      expect(result.lastFailureReason).toMatch(
        /実行状況を確認できませんでした/,
      );
      expect(result.lastFailureReason).toContain('persistent poll error');
    });

    it('keeps currentTicketId on poll_failed', async () => {
      mockFetchAgentRun.mockRejectedValue(new Error('persistent poll error'));

      const progressSnapshots: Array<{
        currentTicketId: string | null;
      }> = [];

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: (progress) => {
          progressSnapshots.push({
            currentTicketId: progress.currentTicketId,
          });
        },
      });

      await finishLoopWithTimers(loopPromise);
      await loopPromise;
      const lastProgress = progressSnapshots.at(-1);
      expect(lastProgress?.currentTicketId).toBe('ticket-1');
    });

    it('keeps currentTicketId on stopped', async () => {
      let stopRequested = false;
      mockFetchAgentRun.mockResolvedValue(
        makeRunDetail('run-ticket-1', 'ticket-1', 'running'),
      );

      const progressSnapshots: Array<{
        currentTicketId: string | null;
      }> = [];

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => stopRequested,
        onProgress: (progress) => {
          progressSnapshots.push({
            currentTicketId: progress.currentTicketId,
          });
        },
      });

      await Promise.resolve();
      stopRequested = true;
      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS);

      await loopPromise;
      const lastProgress = progressSnapshots.at(-1);
      expect(lastProgress?.currentTicketId).toBe('ticket-1');
    });

    it('clears currentTicketId after a fully successful batch', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        return makeRunDetail(runId, ticketId, 'succeeded');
      });

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: () => {},
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;

      expect(mockStartTicketRun).toHaveBeenCalledTimes(2);
      expect(result.completedCount).toBe(2);
      expect(result.endReason).toBe('completed');
      expect(result.currentTicketId).toBeNull();
    });

    it('sets endReason to stopped when stop is requested during delay after start failure', async () => {
      let stopRequested = false;
      mockStartTicketRun.mockRejectedValueOnce(new Error('start failed'));

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => stopRequested,
        onProgress: () => {},
      });

      await Promise.resolve();
      stopRequested = true;
      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS);

      const result = await loopPromise;
      expect(result.failedCount).toBe(1);
      expect(result.endReason).toBe('stopped');
      expect(mockStartTicketRun).toHaveBeenCalledTimes(1);
    });

    it('sets endReason to stopped when stop is requested', async () => {
      let stopRequested = false;
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        if (ticketId === 'ticket-1') {
          return makeRunDetail(runId, ticketId, 'succeeded');
        }
        return makeRunDetail(runId, ticketId, 'running');
      });

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2', 'ticket-3'],
        isStopRequested: () => stopRequested,
        onProgress: () => {},
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS);
      stopRequested = true;
      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS);

      const result = await loopPromise;
      expect(result.completedCount).toBe(1);
      expect(result.endReason).toBe('stopped');
      expect(mockStartTicketRun).toHaveBeenCalledTimes(2);
    });

    it('sets endReason to poll_failed when polling fails', async () => {
      mockFetchAgentRun.mockRejectedValue(new Error('persistent poll error'));

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: () => {},
      });

      await finishLoopWithTimers(loopPromise);
      const result = await loopPromise;
      expect(result.endReason).toBe('poll_failed');
    });

    it('sets endReason to completed when every ticket finishes', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        return makeRunDetail(runId, ticketId, 'succeeded');
      });

      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: () => {},
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;
      expect(result.endReason).toBe('completed');
    });

    it('never hands the same progress object to two emissions', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        return makeRunDetail(runId, ticketId, 'succeeded');
      });

      const emissions: NextUpLoopProgress[] = [];
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: (progress) => {
          emissions.push(progress);
        },
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;

      // Identity, not value. A subscriber that stores what it receives (React
      // state does exactly that) must not have its stored value rewritten by a
      // later iteration, so no two emissions may be the same object.
      expect(new Set(emissions).size).toBe(emissions.length);
      expect(emissions).not.toContain(result);

      // The first emission described an empty batch. If the loop leaked its
      // mutable accumulator, this snapshot would now read 2 completed instead
      // of 0 — which is precisely the silent corruption being guarded against.
      expect(emissions[0]).toEqual({
        currentTicketId: null,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        unknownCount: 0,
        totalCount: 2,
        lastFailureReason: null,
        endReason: null,
      });
    });

    it('stops the batch after two consecutive failures and posts a harness comment', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        return makeRunDetail(runId, ticketId, 'failed');
      });

      const postComment = vi.fn().mockResolvedValue(undefined);
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2', 'ticket-3'],
        isStopRequested: () => false,
        onProgress: () => {},
        postComment,
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;

      expect(result.endReason).toBe('consecutive_failures');
      expect(result.failedCount).toBe(2);
      expect(mockStartTicketRun).toHaveBeenCalledTimes(2);
      expect(mockStartTicketRun).not.toHaveBeenCalledWith('ticket-3');
      expect(postComment).toHaveBeenCalledTimes(1);
      expect(postComment).toHaveBeenCalledWith(
        'ticket-2',
        expect.stringContaining('[harness]'),
      );
      const commentText = postComment.mock.calls[0]?.[1] as string;
      expect(commentText).toContain('ticket-1');
      expect(commentText).toContain('ticket-2');
    });

    it('resets the consecutive failure counter when a success is sandwiched', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        if (ticketId === 'ticket-2') {
          return makeRunDetail(runId, ticketId, 'succeeded');
        }
        return makeRunDetail(runId, ticketId, 'failed');
      });

      const postComment = vi.fn().mockResolvedValue(undefined);
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2', 'ticket-3'],
        isStopRequested: () => false,
        onProgress: () => {},
        postComment,
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 3);
      const result = await loopPromise;

      expect(result.endReason).toBe('completed');
      expect(result.failedCount).toBe(2);
      expect(result.completedCount).toBe(1);
      expect(mockStartTicketRun).toHaveBeenCalledTimes(3);
      expect(postComment).not.toHaveBeenCalled();
    });

    it('counts two consecutive start failures toward the stop threshold', async () => {
      mockStartTicketRun
        .mockRejectedValueOnce(new Error('start failed 1'))
        .mockRejectedValueOnce(new Error('start failed 2'));

      const postComment = vi.fn().mockResolvedValue(undefined);
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2', 'ticket-3'],
        isStopRequested: () => false,
        onProgress: () => {},
        postComment,
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;

      expect(result.endReason).toBe('consecutive_failures');
      expect(result.failedCount).toBe(2);
      expect(mockStartTicketRun).toHaveBeenCalledTimes(2);
      expect(mockStartTicketRun).not.toHaveBeenCalledWith('ticket-3');
      expect(postComment).toHaveBeenCalledTimes(1);
    });

    it('counts mixed start failure and terminal failed as consecutive failures', async () => {
      mockStartTicketRun.mockRejectedValueOnce(new Error('start failed'));
      mockFetchAgentRun.mockImplementation(async (runId) =>
        makeRunDetail(runId, 'ticket-2', 'failed'),
      );

      const postComment = vi.fn().mockResolvedValue(undefined);
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2', 'ticket-3'],
        isStopRequested: () => false,
        onProgress: () => {},
        postComment,
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;

      expect(result.endReason).toBe('consecutive_failures');
      expect(result.failedCount).toBe(2);
      expect(mockStartTicketRun).not.toHaveBeenCalledWith('ticket-3');
    });

    it('does not reset the consecutive failure counter on cancelled outcomes', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        if (ticketId === 'ticket-2') {
          return makeRunDetail(runId, ticketId, 'cancelled');
        }
        return makeRunDetail(runId, ticketId, 'failed');
      });

      const postComment = vi.fn().mockResolvedValue(undefined);
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2', 'ticket-3'],
        isStopRequested: () => false,
        onProgress: () => {},
        postComment,
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 3);
      const result = await loopPromise;

      expect(result.endReason).toBe('consecutive_failures');
      expect(result.failedCount).toBe(2);
      expect(result.cancelledCount).toBe(1);
      expect(mockStartTicketRun).toHaveBeenCalledTimes(3);
      expect(postComment).toHaveBeenCalledTimes(1);
    });

    it('still stops with consecutive_failures when postComment rejects', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        return makeRunDetail(runId, ticketId, 'failed');
      });

      const postComment = vi.fn().mockRejectedValue(new Error('comment failed'));
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: () => {},
        postComment,
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;

      expect(result.endReason).toBe('consecutive_failures');
      expect(result.failedCount).toBe(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to post consecutive-failure comment',
        expect.any(Error),
      );
    });

    it('emits independent progress copies on the consecutive_failures path', async () => {
      mockFetchAgentRun.mockImplementation(async (runId) => {
        const ticketId = runId.replace(/^run-/, '');
        return makeRunDetail(runId, ticketId, 'failed');
      });

      const emissions: NextUpLoopProgress[] = [];
      const loopPromise = runNextUpTicketLoop({
        ticketIds: ['ticket-1', 'ticket-2'],
        isStopRequested: () => false,
        onProgress: (progress) => {
          emissions.push(progress);
        },
        postComment: vi.fn().mockResolvedValue(undefined),
      });

      await vi.advanceTimersByTimeAsync(AGENT_RUN_POLL_INTERVAL_MS * 2);
      const result = await loopPromise;

      expect(result.endReason).toBe('consecutive_failures');
      expect(new Set(emissions).size).toBe(emissions.length);
      expect(emissions).not.toContain(result);

      const firstEmission = emissions[0]!;
      firstEmission.failedCount = 999;
      expect(emissions[1]!.failedCount).not.toBe(999);
      expect(result.failedCount).toBe(2);
    });
  });

  /**
   * useNextUpRunLoopController onProgress generation guard (bdboard-54be.4 M3 / 54be.2 R10)
   *
   * No test here fails when the guard in beginBatchRun's onProgress
   * (`if (loopRunIdRef.current !== runId) return`) is removed. That is intentional,
   * not a coverage gap to paper over:
   *
   * - loopRunIdRef advances mid-flight only via useEffect cleanup on controller unmount.
   * - App-scoped ownership means view switches do not unmount the controller; only
   *   leaving the app does.
   * - When cleanup invalidates a generation, the stale onProgress closure still holds
   *   the unmounted instance's setProgress; React 18 silently ignores it, so the guard
   *   and its removal produce the same observable progress.
   * - A second batch cannot start until loopActiveRef is false; the only way to get
   *   loopActiveRef false while fetchAgentRun is still pending is that same unmount
   *   cleanup path — same dead-setState situation.
   *
   * NextUpView.test.tsx "does not let an unmounted loop generation overwrite progress
   * after remount" exercises the remount UX but does not kill M3 for the reason above.
   * The guard remains documented at the call site in nextUpRunLoop.ts.
   */

  describe('nextUpLoopPollDelayMs', () => {
    it('is monotonically non-decreasing from 0 through N', () => {
      for (let i = 0; i < NEXT_UP_LOOP_POLL_MAX_FAILURES; i += 1) {
        expect(nextUpLoopPollDelayMs(i)).toBeLessThanOrEqual(
          nextUpLoopPollDelayMs(i + 1),
        );
      }
    });

    it('caps at NEXT_UP_LOOP_POLL_MAX_DELAY_MS for large inputs', () => {
      expect(
        nextUpLoopPollDelayMs(NEXT_UP_LOOP_POLL_MAX_FAILURES + 100),
      ).toBe(NEXT_UP_LOOP_POLL_MAX_DELAY_MS);
    });

    it('returns AGENT_RUN_POLL_INTERVAL_MS at zero consecutive failures', () => {
      expect(nextUpLoopPollDelayMs(0)).toBe(AGENT_RUN_POLL_INTERVAL_MS);
    });
  });
});
