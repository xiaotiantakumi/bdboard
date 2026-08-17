import { describe, expect, it, vi } from 'vitest';
import type { AgentRunner, RunOutcome, RunRequest } from '../ports/agent-runner.js';
import { dispatchRun } from './dispatch-run.js';
import { createAgentRunnerRegistry } from './runner-registry.js';

const FIXED_NOW = new Date('2026-08-14T12:00:00.000Z');
const now = () => FIXED_NOW;

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

function successOutcome(runnerId: string): RunOutcome {
  return {
    ok: true,
    run: {
      id: `${runnerId}-run`,
      ticketId: 'bd-1',
      runner: runnerId,
      mode: 'spawn',
      status: 'succeeded',
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
    },
  };
}

function failureOutcome(runnerId: string, failureKind: RunOutcome['failureKind'] = 'failed'): RunOutcome {
  return {
    ok: false,
    failureKind,
    run: {
      id: `${runnerId}-run`,
      ticketId: 'bd-1',
      runner: runnerId,
      mode: 'spawn',
      status: 'failed',
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
    },
  };
}

function makeRunner(
  id: string,
  dispatch: AgentRunner['dispatch'],
  supports = true,
): AgentRunner {
  return {
    id,
    experimental: false,
    supports: () => supports,
    dispatch,
  };
}

describe('dispatchRun', () => {
  it('returns on first successful runner without calling later runners', async () => {
    const registry = createAgentRunnerRegistry();
    const secondDispatch = vi.fn(async () => successOutcome('second'));
    const firstDispatch = vi.fn(async () => successOutcome('first'));

    registry.register(makeRunner('first', firstDispatch));
    registry.register(makeRunner('second', secondDispatch));

    const outcome = await dispatchRun(registry, makeRequest(), now);

    expect(outcome.ok).toBe(true);
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(secondDispatch).not.toHaveBeenCalled();
  });

  it('tries the next runner when the first fails', async () => {
    const registry = createAgentRunnerRegistry();
    const secondDispatch = vi.fn(async () => successOutcome('second'));
    const firstDispatch = vi.fn(async () => failureOutcome('first'));

    registry.register(makeRunner('first', firstDispatch));
    registry.register(makeRunner('second', secondDispatch));

    const outcome = await dispatchRun(registry, makeRequest(), now);

    expect(outcome.ok).toBe(true);
    expect(outcome.run.runner).toBe('second');
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(secondDispatch).toHaveBeenCalledTimes(1);
  });

  it('returns the last failure when all runners fail', async () => {
    const registry = createAgentRunnerRegistry();
    registry.register(
      makeRunner('first', async () => failureOutcome('first', 'runner-unavailable')),
    );
    registry.register(
      makeRunner('second', async () => failureOutcome('second', 'dispatch-disabled')),
    );

    const outcome = await dispatchRun(registry, makeRequest(), now);

    expect(outcome.ok).toBe(false);
    expect(outcome.run.runner).toBe('second');
    expect(outcome.failureKind).toBe('dispatch-disabled');
  });

  it('returns unsupported when no runner matches', async () => {
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner('only', async () => successOutcome('only'), false));

    const outcome = await dispatchRun(registry, makeRequest(), now);

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('unsupported');
    expect(outcome.run.runner).toBe('none');
    expect(outcome.run.id).toBe('bd-1:spawn:2026-08-14T12:00:00.000Z');
  });

  it('skips runners that throw and continues to the next', async () => {
    const registry = createAgentRunnerRegistry();
    registry.register(
      makeRunner('throws', async () => {
        throw new Error('boom');
      }),
    );
    registry.register(
      makeRunner('second', async () => successOutcome('second')),
    );

    const outcome = await dispatchRun(registry, makeRequest(), now);

    expect(outcome.ok).toBe(true);
    expect(outcome.run.runner).toBe('second');
  });

  it('returns failed when all runners throw', async () => {
    const registry = createAgentRunnerRegistry();
    registry.register(
      makeRunner('throws-1', async () => {
        throw new Error('first boom');
      }),
    );
    registry.register(
      makeRunner('throws-2', async () => {
        throw new Error('second boom');
      }),
    );

    const outcome = await dispatchRun(registry, makeRequest(), now);

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('failed');
    expect(outcome.error).toBe('second boom');
  });

  it('does not call any runner for invalid requests', async () => {
    const registry = createAgentRunnerRegistry();
    const dispatch = vi.fn(async () => successOutcome('never'));
    registry.register(makeRunner('runner', dispatch));

    const outcome = await dispatchRun(
      registry,
      makeRequest({ mode: 'resume' }),
      now,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('invalid-request');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
