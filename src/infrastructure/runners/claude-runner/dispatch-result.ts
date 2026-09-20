// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// streamingRunner.run() の結果 (StreamingCommandResult) を RunOutcome へ変換する。
// createClaudeRunner の dispatch() 本体から末尾の結果分岐だけを、同じ入出力のまま
// buildDispatchResultOutcome(id, request, startedAt, result) という1関数に切り出した
// (内部で `const finishedAt = new Date()` と `buildRunId(request, startedAt)` を計算する
// 順序も元のままなので、挙動は変わらない)。
import type {
  RunOutcome,
  RunRequest,
} from '../../../application/ports/agent-runner.js';
import type { StreamingCommandResult } from '../../../application/ports/streaming-command-runner.js';
import { describeClaudeSettingSourcesFailure } from '../../../domain/claude-version-check.js';
import { buildRunId } from './run-outcome.js';

export function buildDispatchResultOutcome(
  id: string,
  request: RunRequest,
  startedAt: Date,
  result: StreamingCommandResult,
): RunOutcome {
  const finishedAt = new Date();
  const runId = buildRunId(request, startedAt);

  if (result.failureKind === 'spawn-failed') {
    const settingSourcesHint = describeClaudeSettingSourcesFailure(
      result.stderr,
    );
    const translated =
      settingSourcesHint === null
        ? null
        : result.stderr
          ? `${settingSourcesHint}\n${result.stderr}`
          : settingSourcesHint;
    return {
      ok: false,
      failureKind: 'runner-unavailable',
      error: translated ?? (result.stderr || 'failed to spawn claude'),
      run: {
        id: runId,
        ticketId: request.ticketId,
        runner: id,
        mode: request.mode,
        status: 'failed',
        startedAt,
        finishedAt,
        sessionId: request.sessionId,
        exitCode: result.exitCode,
        error: translated ?? (result.stderr || undefined),
      },
    };
  }

  if (result.failureKind === 'aborted') {
    return {
      ok: false,
      failureKind: 'failed',
      error: result.stderr || 'run aborted',
      run: {
        id: runId,
        ticketId: request.ticketId,
        runner: id,
        mode: request.mode,
        status: 'cancelled',
        startedAt,
        finishedAt,
        sessionId: request.sessionId,
        exitCode: result.exitCode,
        error: result.stderr || undefined,
      },
    };
  }

  if (result.exitCode === 0) {
    return {
      ok: true,
      run: {
        id: runId,
        ticketId: request.ticketId,
        runner: id,
        mode: request.mode,
        status: 'succeeded',
        startedAt,
        finishedAt,
        sessionId: request.sessionId,
        exitCode: result.exitCode,
      },
    };
  }

  const settingSourcesHint = describeClaudeSettingSourcesFailure(
    result.stderr,
  );
  const translated =
    settingSourcesHint === null
      ? null
      : result.stderr
        ? `${settingSourcesHint}\n${result.stderr}`
        : settingSourcesHint;

  return {
    ok: false,
    failureKind: 'failed',
    error:
      translated ??
      (result.stderr || `claude exited with code ${result.exitCode}`),
    run: {
      id: runId,
      ticketId: request.ticketId,
      runner: id,
      mode: request.mode,
      status: 'failed',
      startedAt,
      finishedAt,
      sessionId: request.sessionId,
      exitCode: result.exitCode,
      error: translated ?? (result.stderr || undefined),
    },
  };
}
