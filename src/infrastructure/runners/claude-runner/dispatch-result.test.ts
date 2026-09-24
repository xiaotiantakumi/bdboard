import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../../../application/ports/agent-runner.js';
import type { StreamingCommandResult } from '../../../application/ports/streaming-command-runner.js';
import { buildDispatchResultOutcome } from './dispatch-result.js';

// bdboard-99g5: settingSourcesHint/translated の計算は分割前 (旧 claude-runner.ts
// 631-639行目・696-704行目) に2箇所重複していたものを共通ヘルパーへ抽出した。
// ここでは spawn-failed 分岐と generic failed 分岐の両方が、同じ stderr から
// 同じ translated 文字列(またはフォールバック)を導くことをテストで押さえる。

function makeRequest(): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
  };
}

const startedAt = new Date('2026-01-01T00:00:00.000Z');

const HINT_TRIGGERING_STDERR =
  'error: unknown option --setting-sources\nusage: claude [options]';

describe('buildDispatchResultOutcome settingSourcesHint dedup', () => {
  it('translates a hint-triggering stderr the same way for spawn-failed as for a generic failed exit', () => {
    const spawnFailedResult: StreamingCommandResult = {
      stdout: '',
      stderr: HINT_TRIGGERING_STDERR,
      exitCode: 1,
      failureKind: 'spawn-failed',
    };
    const genericFailedResult: StreamingCommandResult = {
      stdout: '',
      stderr: HINT_TRIGGERING_STDERR,
      exitCode: 1,
    };

    const spawnFailedOutcome = buildDispatchResultOutcome(
      'claude-spawn',
      makeRequest(),
      startedAt,
      spawnFailedResult,
    );
    const genericFailedOutcome = buildDispatchResultOutcome(
      'claude-spawn',
      makeRequest(),
      startedAt,
      genericFailedResult,
    );

    expect(spawnFailedOutcome.ok).toBe(false);
    expect(genericFailedOutcome.ok).toBe(false);
    if (spawnFailedOutcome.ok || genericFailedOutcome.ok) {
      throw new Error('expected both outcomes to be failures');
    }

    // 同じ stderr から導出される translated 文字列は両分岐で同一。
    expect(spawnFailedOutcome.error).toBe(genericFailedOutcome.error);
    expect(spawnFailedOutcome.run.error).toBe(genericFailedOutcome.run.error);
    expect(spawnFailedOutcome.error).toContain(
      'claude CLI is too old for agent runs',
    );
    expect(spawnFailedOutcome.error).toContain(HINT_TRIGGERING_STDERR);
  });

  it('falls back to the raw stderr (or a generic message) when it does not match the setting-sources hint', () => {
    const plainStderrResult: StreamingCommandResult = {
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
      failureKind: 'spawn-failed',
    };
    const emptyStderrResult: StreamingCommandResult = {
      stdout: '',
      stderr: '',
      exitCode: 7,
    };

    const spawnFailedOutcome = buildDispatchResultOutcome(
      'claude-spawn',
      makeRequest(),
      startedAt,
      plainStderrResult,
    );
    const genericFailedOutcome = buildDispatchResultOutcome(
      'claude-spawn',
      makeRequest(),
      startedAt,
      emptyStderrResult,
    );

    if (spawnFailedOutcome.ok || genericFailedOutcome.ok) {
      throw new Error('expected both outcomes to be failures');
    }

    expect(spawnFailedOutcome.error).toBe('boom');
    expect(genericFailedOutcome.error).toBe('claude exited with code 7');
  });

  it('leaves the success path untouched (exitCode 0 skips the hint computation)', () => {
    const successResult: StreamingCommandResult = {
      stdout: 'done',
      stderr: '',
      exitCode: 0,
    };

    const outcome = buildDispatchResultOutcome(
      'claude-spawn',
      makeRequest(),
      startedAt,
      successResult,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected success outcome');
    }
    expect(outcome.run.status).toBe('succeeded');
    expect(outcome.run.id).toBe('bd-1:spawn:2026-01-01T00:00:00.000Z');
  });
});
