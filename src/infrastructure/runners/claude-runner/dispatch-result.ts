// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// streamingRunner.run() の結果 (StreamingCommandResult) を RunOutcome へ変換する。
// createClaudeRunner の dispatch() 本体から末尾の結果分岐だけを、同じ入出力のまま
// buildDispatchResultOutcome(id, request, startedAt, result) という1関数に切り出した
// (内部で `const finishedAt = new Date()` と `buildClaudeRunId(request, startedAt)` を計算する
// 順序も元のままなので、挙動は変わらない)。
import type {
  RunOutcome,
  RunRequest,
} from '../../../application/ports/agent-runner.js';
import type { StreamingCommandResult } from '../../../application/ports/streaming-command-runner.js';
import { describeClaudeSettingSourcesFailure } from '../../../domain/claude-version-check.js';
import { buildClaudeRunId } from './run-outcome.js';

/**
 * bdboard-99g5: dispatch-result.ts 内で2箇所に完全重複していた
 * settingSourcesHint/translated の計算を1関数へ統合。
 * spawn-failed 分岐・generic failed 分岐のどちらも、元のインライン計算と
 * 同じ入力(stderr)から同じ出力(translated)を返す。
 */
function translateStderrForSettingSourcesHint(
  stderr: string,
): string | null {
  const settingSourcesHint = describeClaudeSettingSourcesFailure(stderr);
  return settingSourcesHint === null
    ? null
    : stderr
      ? `${settingSourcesHint}\n${stderr}`
      : settingSourcesHint;
}

export function buildDispatchResultOutcome(
  id: string,
  request: RunRequest,
  startedAt: Date,
  result: StreamingCommandResult,
): RunOutcome {
  const finishedAt = new Date();
  const runId = buildClaudeRunId(request, startedAt);

  if (result.failureKind === 'spawn-failed') {
    const translated = translateStderrForSettingSourcesHint(result.stderr);
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

  const translated = translateStderrForSettingSourcesHint(result.stderr);

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
