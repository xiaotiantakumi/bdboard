import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../../application/ports/agent-runner.js';
import { createDisabledRunner } from './disabled-runner.js';

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

describe('createDisabledRunner', () => {
  it('always supports any request', () => {
    const runner = createDisabledRunner('disabled');
    expect(runner.supports(makeRequest())).toBe(true);
    expect(runner.supports(makeRequest({ mode: 'resume', sessionId: 's' }))).toBe(
      true,
    );
  });

  it('returns dispatch-disabled without launching a process', async () => {
    const runner = createDisabledRunner('disabled');
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('dispatch-disabled');
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.runner).toBe('disabled');
    expect(outcome.error).toContain('dispatch disabled');
  });

  it('honors experimental option', () => {
    expect(createDisabledRunner('x').experimental).toBe(false);
    expect(createDisabledRunner('x', { experimental: true }).experimental).toBe(
      true,
    );
  });
});
