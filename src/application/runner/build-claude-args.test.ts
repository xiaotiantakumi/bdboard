import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../ports/agent-runner.js';
import { buildClaudeCommand, MissingSessionIdError } from './build-claude-args.js';

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

describe('buildClaudeCommand', () => {
  it('spawn without prompt', () => {
    expect(buildClaudeCommand(makeRequest({ mode: 'spawn' }))).toEqual({
      command: 'claude',
      args: [],
    });
  });

  it('spawn with prompt', () => {
    expect(
      buildClaudeCommand(makeRequest({ mode: 'spawn', prompt: 'do the thing' })),
    ).toEqual({
      command: 'claude',
      args: ['do the thing'],
    });
  });

  it('resume without prompt', () => {
    expect(
      buildClaudeCommand(
        makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
      ),
    ).toEqual({
      command: 'claude',
      args: ['--resume', 'sess-1'],
    });
  });

  it('resume with prompt', () => {
    expect(
      buildClaudeCommand(
        makeRequest({
          mode: 'resume',
          sessionId: 'sess-1',
          prompt: 'do the thing',
        }),
      ),
    ).toEqual({
      command: 'claude',
      args: ['--resume', 'sess-1', 'do the thing'],
    });
  });

  it('uses claudePath when provided', () => {
    expect(
      buildClaudeCommand(makeRequest(), {
        claudePath: '/opt/wrappers/claude',
      }),
    ).toEqual({
      command: '/opt/wrappers/claude',
      args: [],
    });
  });

  it('does not escape special characters in prompt', () => {
    const prompt = 'fix "it"; now';
    expect(
      buildClaudeCommand(makeRequest({ mode: 'spawn', prompt })),
    ).toEqual({
      command: 'claude',
      args: [prompt],
    });
  });

  it('throws instead of silently building a spawn command when resume has no sessionId', () => {
    // Dropping --resume here would produce the exact argv of a fresh spawn, so a
    // resume request would quietly start a new agent session once dispatch is real.
    expect(() => buildClaudeCommand(makeRequest({ mode: 'resume' }))).toThrow(
      MissingSessionIdError,
    );
    expect(() =>
      buildClaudeCommand(makeRequest({ mode: 'resume', sessionId: '   ' })),
    ).toThrow(MissingSessionIdError);
  });
});
