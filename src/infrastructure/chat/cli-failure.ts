import type { ChatFailureCode } from '../../application/ports/chat-agent.js';
import type { CommandResult } from '../../application/ports/command-runner.js';

/** サーバーログに出す生出力の上限。ログを溢れさせないため。 */
export const MAX_FAILURE_LOG_CHARS = 2_000;

function truncateForLog(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength);
}

export function classifyCommandFailure(result: CommandResult): ChatFailureCode {
  if (result.failureKind === 'spawn-failed') {
    return 'agent-not-found';
  }
  if (result.failureKind === 'timeout') {
    return 'agent-timeout';
  }
  return 'agent-exit-nonzero';
}

export interface ChatAgentFailureLog {
  readonly agentId: string;
  readonly code: ChatFailureCode;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * bdboard-l1t.9 Opus レビュー S8: ストリーミング経路の32MBバッファ上限到達は
   * classifyCommandFailure では汎用の 'agent-exit-nonzero' に潰れる(専用の
   * ChatFailureCode/HTTPレスポンスを新設するのは今回のスコープ外)。せめてサーバー
   * ログでは元の理由が分かるよう、任意の注記をここに残せるようにする。
   */
  readonly note?: string;
}

/**
 * 生の stdout/stderr が出てよい唯一の場所。HTTP レスポンスには絶対に載せない(bdboard-pvl)。
 */
export function logChatAgentFailure(entry: ChatAgentFailureLog): void {
  const stderr = truncateForLog(entry.stderr, MAX_FAILURE_LOG_CHARS);
  const stdout = truncateForLog(entry.stdout, MAX_FAILURE_LOG_CHARS);
  const note = entry.note === undefined ? '' : ` note=${entry.note}`;
  console.error(
    `Chat agent failure: agent=${entry.agentId} code=${entry.code} exitCode=${entry.exitCode}${note} stderr=${stderr} stdout=${stdout}`,
  );
}
