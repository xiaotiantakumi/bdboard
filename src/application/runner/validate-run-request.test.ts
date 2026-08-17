import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../ports/agent-runner.js';
import { validateRunRequest } from './validate-run-request.js';

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

describe('validateRunRequest', () => {
  it('returns null for a valid spawn request', () => {
    expect(validateRunRequest(makeRequest({ mode: 'spawn' }))).toBeNull();
  });

  it('returns null for a valid resume request with sessionId', () => {
    expect(
      validateRunRequest(
        makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
      ),
    ).toBeNull();
  });

  it('rejects resume without sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume' })),
    ).toBe('invalid-request');
  });

  it('rejects resume with empty sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume', sessionId: '' })),
    ).toBe('invalid-request');
  });

  it('rejects resume with whitespace-only sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume', sessionId: '   ' })),
    ).toBe('invalid-request');
  });

  it('rejects empty cwd', () => {
    expect(validateRunRequest(makeRequest({ cwd: '' }))).toBe('invalid-request');
  });

  it('rejects whitespace-only cwd', () => {
    expect(validateRunRequest(makeRequest({ cwd: '  ' }))).toBe(
      'invalid-request',
    );
  });

  it('rejects empty ticketId', () => {
    expect(validateRunRequest(makeRequest({ ticketId: '' }))).toBe(
      'invalid-request',
    );
  });

  it('rejects whitespace-only ticketId', () => {
    expect(validateRunRequest(makeRequest({ ticketId: '  ' }))).toBe(
      'invalid-request',
    );
  });
});
