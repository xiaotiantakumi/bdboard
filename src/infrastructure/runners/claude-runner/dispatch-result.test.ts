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

// setting-sources には言及するが unknown-option シグナルが無いケース。
// describeClaudeSettingSourcesFailure が null を返すので、hint 抽出は
// スキップされ raw stderr にフォールバックするはず。
const SETTING_SOURCES_WITHOUT_UNKNOWN_OPTION_STDERR =
  '--setting-sources project,local applied';

function dispatch(
  result: StreamingCommandResult,
): ReturnType<typeof buildDispatchResultOutcome> {
  return buildDispatchResultOutcome(
    'claude-spawn',
    makeRequest(),
    startedAt,
    result,
  );
}

describe('buildDispatchResultOutcome settingSourcesHint dedup', () => {
  it('translates a hint-triggering stderr the same way for spawn-failed as for a generic failed exit', () => {
    const spawnFailedOutcome = dispatch({
      stdout: '',
      stderr: HINT_TRIGGERING_STDERR,
      exitCode: 1,
      failureKind: 'spawn-failed',
    });
    const genericFailedOutcome = dispatch({
      stdout: '',
      stderr: HINT_TRIGGERING_STDERR,
      exitCode: 1,
    });

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

  it('falls back to the same raw-stderr/generic-message rule in both branches when the stderr does not match the hint', () => {
    // 同じ2種類の入力(非空だがヒント非該当の stderr / 空の stderr)を両分岐に
    // 通し、フォールバック規則が分岐間で一致することを確認する。
    for (const stderr of ['boom', '']) {
      const spawnFailedOutcome = dispatch({
        stdout: '',
        stderr,
        exitCode: 1,
        failureKind: 'spawn-failed',
      });
      const genericFailedOutcome = dispatch({
        stdout: '',
        stderr,
        exitCode: 7,
      });

      if (spawnFailedOutcome.ok || genericFailedOutcome.ok) {
        throw new Error('expected both outcomes to be failures');
      }

      if (stderr === '') {
        expect(spawnFailedOutcome.error).toBe('failed to spawn claude');
        expect(spawnFailedOutcome.run.error).toBeUndefined();
        expect(genericFailedOutcome.error).toBe(
          'claude exited with code 7',
        );
        expect(genericFailedOutcome.run.error).toBeUndefined();
      } else {
        expect(spawnFailedOutcome.error).toBe('boom');
        expect(spawnFailedOutcome.run.error).toBe('boom');
        expect(genericFailedOutcome.error).toBe('boom');
        expect(genericFailedOutcome.run.error).toBe('boom');
      }
    }
  });

  it('falls back to the raw stderr when it mentions setting-sources but has no unknown-option signal', () => {
    const spawnFailedOutcome = dispatch({
      stdout: '',
      stderr: SETTING_SOURCES_WITHOUT_UNKNOWN_OPTION_STDERR,
      exitCode: 1,
      failureKind: 'spawn-failed',
    });
    const genericFailedOutcome = dispatch({
      stdout: '',
      stderr: SETTING_SOURCES_WITHOUT_UNKNOWN_OPTION_STDERR,
      exitCode: 1,
    });

    if (spawnFailedOutcome.ok || genericFailedOutcome.ok) {
      throw new Error('expected both outcomes to be failures');
    }

    expect(spawnFailedOutcome.error).toBe(
      SETTING_SOURCES_WITHOUT_UNKNOWN_OPTION_STDERR,
    );
    expect(genericFailedOutcome.error).toBe(
      SETTING_SOURCES_WITHOUT_UNKNOWN_OPTION_STDERR,
    );
  });

  it('leaves the aborted branch untranslated (hint computation only applies to spawn-failed/generic failure)', () => {
    const outcome = dispatch({
      stdout: '',
      stderr: HINT_TRIGGERING_STDERR,
      exitCode: 130,
      failureKind: 'aborted',
    });

    if (outcome.ok) {
      throw new Error('expected an aborted outcome');
    }
    expect(outcome.run.status).toBe('cancelled');
    // aborted 分岐は translateStderrForSettingSourcesHint を呼ばず、raw stderr
    // をそのまま使う。
    expect(outcome.error).toBe(HINT_TRIGGERING_STDERR);
    expect(outcome.run.error).toBe(HINT_TRIGGERING_STDERR);
  });

  it('leaves the success path untouched and computes the run id via the renamed buildClaudeRunId', () => {
    const outcome = dispatch({
      stdout: 'done',
      stderr: '',
      exitCode: 0,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected success outcome');
    }
    expect(outcome.run.status).toBe('succeeded');
    expect(outcome.run.id).toBe('bd-1:spawn:2026-01-01T00:00:00.000Z');
  });
});
