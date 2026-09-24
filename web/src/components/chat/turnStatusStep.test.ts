import { describe, expect, it } from 'vitest';
import type { ChatTurnStatusDto } from '../../api';
import { decideTurnStatusStep, type TurnStatusStepDetached } from './turnStatusStep';

const idle: ChatTurnStatusDto = { state: 'idle' };
const processing: ChatTurnStatusDto = { state: 'processing' };

function failed(
  overrides: Partial<Extract<ChatTurnStatusDto, { state: 'failed' }>> = {},
): ChatTurnStatusDto {
  return {
    state: 'failed',
    code: 'agent_error',
    agentId: 'agent-1',
    failedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function completed(
  overrides: Partial<Extract<ChatTurnStatusDto, { state: 'completed' }>> = {},
): ChatTurnStatusDto {
  return {
    state: 'completed',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    completedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const baseArgs = {
  detached: undefined as TurnStatusStepDetached | undefined,
  isRecoveredCompletedSession: false,
  isDrainedFailedSession: false,
  unmatchedSessionlessFailedStreak: 0,
};

describe('decideTurnStatusStep', () => {
  it('idle with no tracked detached send: done, streak reset', () => {
    const step = decideTurnStatusStep({ ...baseArgs, status: idle });
    expect(step).toEqual({ kind: 'done', nextUnmatchedSessionlessFailedStreak: 0 });
  });

  it('idle with a tracked detached send: fails without ack', () => {
    const detached: TurnStatusStepDetached = { sessionId: 'sess-1', detachedAt: 0 };
    const step = decideTurnStatusStep({
      ...baseArgs,
      status: idle,
      detached,
      unmatchedSessionlessFailedStreak: 3,
    });
    expect(step).toEqual({
      kind: 'fail-detached',
      ackSessionId: undefined,
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });

  it('failed matching a tracked send by sessionId: fails with ack', () => {
    const detached: TurnStatusStepDetached = { sessionId: 'sess-1', detachedAt: 0 };
    const step = decideTurnStatusStep({
      ...baseArgs,
      status: failed({ sessionId: 'sess-1' }),
      detached,
    });
    expect(step).toEqual({
      kind: 'fail-detached',
      ackSessionId: 'sess-1',
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });

  it('failed matching a sessionId-less tracked send within the clock-skew window: fails without ack', () => {
    const detached: TurnStatusStepDetached = { sessionId: undefined, detachedAt: 100_000 };
    const step = decideTurnStatusStep({
      ...baseArgs,
      status: failed({ failedAt: new Date(110_000).toISOString() }),
      detached,
    });
    expect(step).toEqual({
      kind: 'fail-detached',
      ackSessionId: undefined,
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });

  it('failed sessionId-less with no sessionId-less tracked send: keeps polling, streak resets to 0', () => {
    const step = decideTurnStatusStep({ ...baseArgs, status: failed(), unmatchedSessionlessFailedStreak: 5 });
    expect(step).toEqual({ kind: 'poll-later', delayMs: 1_000, nextUnmatchedSessionlessFailedStreak: 0 });
  });

  it('failed sessionId-less tracked send outside the clock-skew window: keeps polling and increments the streak', () => {
    const detached: TurnStatusStepDetached = { sessionId: undefined, detachedAt: 1_000_000 };
    const step = decideTurnStatusStep({
      ...baseArgs,
      status: failed({ failedAt: new Date(0).toISOString() }),
      detached,
      unmatchedSessionlessFailedStreak: 2,
    });
    expect(step).toEqual({ kind: 'poll-later', delayMs: 1_000, nextUnmatchedSessionlessFailedStreak: 3 });
  });

  it('gives up and fails once the sessionId-less mismatch streak reaches the configured limit', () => {
    const detached: TurnStatusStepDetached = { sessionId: undefined, detachedAt: 1_000_000 };
    const step = decideTurnStatusStep({
      ...baseArgs,
      status: failed({ failedAt: new Date(0).toISOString() }),
      detached,
      unmatchedSessionlessFailedStreak: 19,
    });
    expect(step).toEqual({
      kind: 'fail-detached',
      ackSessionId: undefined,
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });

  it('failed with a sessionId already drained this effect run: keeps polling without acking again', () => {
    const step = decideTurnStatusStep({
      ...baseArgs,
      status: failed({ sessionId: 'sess-2' }),
      isDrainedFailedSession: true,
    });
    expect(step).toEqual({ kind: 'poll-later', delayMs: 1_000, nextUnmatchedSessionlessFailedStreak: 0 });
  });

  it('failed with an unrelated sessionId not yet drained: acks and rechecks immediately', () => {
    const step = decideTurnStatusStep({ ...baseArgs, status: failed({ sessionId: 'sess-2' }) });
    expect(step).toEqual({ kind: 'ack-and-recheck', sessionId: 'sess-2', nextUnmatchedSessionlessFailedStreak: 0 });
  });

  it('processing: keeps polling', () => {
    const step = decideTurnStatusStep({ ...baseArgs, status: processing, unmatchedSessionlessFailedStreak: 4 });
    expect(step).toEqual({ kind: 'poll-later', delayMs: 1_000, nextUnmatchedSessionlessFailedStreak: 0 });
  });

  it('completed and already recovered this effect run: keeps polling instead of re-hydrating', () => {
    const step = decideTurnStatusStep({ ...baseArgs, status: completed(), isRecoveredCompletedSession: true });
    expect(step).toEqual({ kind: 'poll-later', delayMs: 1_000, nextUnmatchedSessionlessFailedStreak: 0 });
  });

  it('completed and not yet recovered, matching tracked send by sessionId: hydrates as a match', () => {
    const detached: TurnStatusStepDetached = { sessionId: 'sess-1', detachedAt: 0 };
    const step = decideTurnStatusStep({ ...baseArgs, status: completed({ sessionId: 'sess-1' }), detached });
    expect(step).toEqual({
      kind: 'hydrate',
      sessionId: 'sess-1',
      detachedMatchesThisRecovery: true,
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });

  it('completed and not yet recovered, sessionId-less tracked send: hydrates as a match unconditionally', () => {
    const detached: TurnStatusStepDetached = { sessionId: undefined, detachedAt: 0 };
    const step = decideTurnStatusStep({ ...baseArgs, status: completed({ sessionId: 'sess-9' }), detached });
    expect(step).toEqual({
      kind: 'hydrate',
      sessionId: 'sess-9',
      detachedMatchesThisRecovery: true,
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });

  it('completed and not yet recovered with no tracked detached send: hydrates without a match', () => {
    const step = decideTurnStatusStep({ ...baseArgs, status: completed({ sessionId: 'sess-9' }) });
    expect(step).toEqual({
      kind: 'hydrate',
      sessionId: 'sess-9',
      detachedMatchesThisRecovery: false,
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });

  it('completed and not yet recovered, tracked send for a different sessionId: hydrates without a match', () => {
    const detached: TurnStatusStepDetached = { sessionId: 'sess-other', detachedAt: 0 };
    const step = decideTurnStatusStep({ ...baseArgs, status: completed({ sessionId: 'sess-9' }), detached });
    expect(step).toEqual({
      kind: 'hydrate',
      sessionId: 'sess-9',
      detachedMatchesThisRecovery: false,
      nextUnmatchedSessionlessFailedStreak: 0,
    });
  });
});
