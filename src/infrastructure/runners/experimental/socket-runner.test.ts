import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../../../application/ports/agent-runner.js';
import { createExperimentalSocketRunner } from './socket-runner.js';

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'resume',
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('createExperimentalSocketRunner', () => {
  it('is marked experimental', () => {
    expect(createExperimentalSocketRunner().experimental).toBe(true);
  });

  it('supports resume mode only', () => {
    const runner = createExperimentalSocketRunner();
    expect(runner.supports(makeRequest({ mode: 'resume', sessionId: 's' }))).toBe(
      true,
    );
    expect(runner.supports(makeRequest({ mode: 'spawn' }))).toBe(false);
  });

  it('returns dispatch-disabled without connecting to a socket', async () => {
    const runner = createExperimentalSocketRunner();
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('dispatch-disabled');
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.runner).toBe('experimental-socket');
  });
});
