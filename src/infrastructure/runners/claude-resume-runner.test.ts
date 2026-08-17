import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../../application/ports/agent-runner.js';
import { createClaudeResumeRunner } from './claude-resume-runner.js';

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

describe('createClaudeResumeRunner', () => {
  it('supports resume mode only', () => {
    const runner = createClaudeResumeRunner();
    expect(runner.supports(makeRequest({ mode: 'resume', sessionId: 's' }))).toBe(
      true,
    );
    expect(runner.supports(makeRequest({ mode: 'spawn' }))).toBe(false);
  });

  it('returns dispatch-disabled without executing', async () => {
    const runner = createClaudeResumeRunner();
    const outcome = await runner.dispatch(
      makeRequest({ mode: 'resume', sessionId: 'sess-1', prompt: 'continue' }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('dispatch-disabled');
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.runner).toBe('claude-resume');
    expect(outcome.run.sessionId).toBe('sess-1');
    expect(outcome.error).toContain('would run: claude --resume sess-1 continue');
  });

  it('reports invalid-request instead of throwing when resume has no sessionId', async () => {
    const runner = createClaudeResumeRunner();
    const outcome = await runner.dispatch(
      makeRequest({ mode: 'resume', sessionId: undefined }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('invalid-request');
    // Must never degrade into a fresh-spawn command.
    expect(outcome.error).not.toContain('would run');
  });

  it('includes custom claudePath in the would-run message', async () => {
    const runner = createClaudeResumeRunner({
      claudePath: '/opt/wrappers/claude',
    });
    const outcome = await runner.dispatch(
      makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
    );

    expect(outcome.error).toContain(
      'would run: /opt/wrappers/claude --resume sess-1',
    );
  });
});
