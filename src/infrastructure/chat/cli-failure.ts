import type { ChatFailureCode } from '../../application/ports/chat-agent.js';
import type { CommandResult } from '../../application/ports/command-runner.js';

/** サーバーログに出す生出力の上限。ログを溢れさせないため。 */
export const MAX_FAILURE_LOG_CHARS = 2_000;

/**
 * head+tail 切り出しの配分。bdboard-98ph: Claude CLI の stream 出力は先頭の init JSON
 * (tools/skills 一覧) だけで上限を超えるため、先頭のみ切り出すと末尾の result/エラー行が
 * 必ず捨てられる。tail のみだと起動前エラーの情報が失われる。両端を残し、省略量は
 * 区切り文字列で示す。
 */
const TRUNCATE_HEAD_CHARS = 500;
const TRUNCATE_TAIL_CHARS = 1_450;

function truncateForLog(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  const head = trimmed.slice(0, TRUNCATE_HEAD_CHARS);
  const tail = trimmed.slice(-TRUNCATE_TAIL_CHARS);
  const omitted = trimmed.length - TRUNCATE_HEAD_CHARS - TRUNCATE_TAIL_CHARS;
  const separator = `…${omitted} chars omitted…`;
  const result = head + separator + tail;
  if (result.length <= maxLength) {
    return result;
  }
  // 区切りが長くなった場合は tail を詰めて上限内に収める
  const excess = result.length - maxLength;
  return head + separator + trimmed.slice(-(TRUNCATE_TAIL_CHARS - excess));
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
