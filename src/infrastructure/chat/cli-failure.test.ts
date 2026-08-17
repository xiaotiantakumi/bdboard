import { describe, expect, it, vi } from 'vitest';
import {
  classifyCommandFailure,
  logChatAgentFailure,
  MAX_FAILURE_LOG_CHARS,
} from './cli-failure.js';

describe('classifyCommandFailure', () => {
  it('maps spawn-failed to agent-not-found', () => {
    expect(
      classifyCommandFailure({
        stdout: '',
        stderr: '',
        exitCode: -1,
        failureKind: 'spawn-failed',
      }),
    ).toBe('agent-not-found');
  });

  it('maps timeout to agent-timeout', () => {
    expect(
      classifyCommandFailure({
        stdout: '',
        stderr: '',
        exitCode: -1,
        failureKind: 'timeout',
      }),
    ).toBe('agent-timeout');
  });

  it('maps other non-zero exits to agent-exit-nonzero', () => {
    expect(
      classifyCommandFailure({
        stdout: '',
        stderr: 'boom',
        exitCode: 2,
      }),
    ).toBe('agent-exit-nonzero');
  });
});

describe('logChatAgentFailure', () => {
  it('logs with the Chat agent failure prefix and truncates output', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const longText = 'z'.repeat(MAX_FAILURE_LOG_CHARS + 500);

    logChatAgentFailure({
      agentId: 'test-agent',
      code: 'agent-exit-nonzero',
      exitCode: 1,
      stdout: longText,
      stderr: longText,
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged.startsWith('Chat agent failure:')).toBe(true);
    expect(logged).toContain('agent=test-agent');
    expect(logged).toContain('code=agent-exit-nonzero');
    expect(logged).toContain('exitCode=1');

    const stderrPart = logged.slice(
      logged.indexOf('stderr=') + 'stderr='.length,
      logged.indexOf(' stdout='),
    );
    const stdoutPart = logged.slice(logged.indexOf('stdout=') + 'stdout='.length);
    expect(stderrPart.length).toBeLessThanOrEqual(MAX_FAILURE_LOG_CHARS);
    expect(stdoutPart.length).toBeLessThanOrEqual(MAX_FAILURE_LOG_CHARS);
    expect(stderrPart).toBe('z'.repeat(MAX_FAILURE_LOG_CHARS));
    expect(stdoutPart).toBe('z'.repeat(MAX_FAILURE_LOG_CHARS));

    errorSpy.mockRestore();
  });
});
