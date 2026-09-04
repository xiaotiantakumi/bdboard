import type { ChatFailureCode } from '../../application/ports/chat-agent.js';
import type { CommandResult } from '../../application/ports/command-runner.js';

/** サーバーログに出す生出力の上限。ログを溢れさせないため。 */
export const MAX_FAILURE_LOG_CHARS = 2_000;

/**
 * head+tail 切り出しの配分。bdboard-98ph: Claude CLI の stream 出力は先頭の init JSON
 * (tools/skills 一覧) だけで上限を超えるため、先頭のみ切り出すと末尾の result/エラー行が
 * 必ず捨てられる。tail のみだと起動前エラーの情報が失われる。両端を残し、省略量は
 * 区切り文字列で示す。
 *
 * 配分は MAX_FAILURE_LOG_CHARS 前提の決め打ち。出力長は
 * `500 + 1450 + (16 + omitted の桁数)` で、omitted は文字列長なので高々 16 桁 →
 * 最大 1982 < 2000。つまり上限を超える経路は存在しないので、詰め直しの分岐は置かない。
 * この3つの数のどれかを変えるときはこの不等式を確認すること（上限そのものは
 * cli-failure.test.ts が機械的に検証している）。
 */
const TRUNCATE_HEAD_CHARS = 500;
const TRUNCATE_TAIL_CHARS = 1_450;

function truncateForLog(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_FAILURE_LOG_CHARS) {
    return trimmed;
  }
  // ここに来る時点で trimmed.length > 2000 > 500 + 1450 なので head と tail は重ならない。
  const head = trimmed.slice(0, TRUNCATE_HEAD_CHARS);
  const tail = trimmed.slice(-TRUNCATE_TAIL_CHARS);
  const omitted = trimmed.length - TRUNCATE_HEAD_CHARS - TRUNCATE_TAIL_CHARS;
  return `${head}…${omitted} chars omitted…${tail}`;
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
  const stderr = truncateForLog(entry.stderr);
  const stdout = truncateForLog(entry.stdout);
  const note = entry.note === undefined ? '' : ` note=${entry.note}`;
  console.error(
    `Chat agent failure: agent=${entry.agentId} code=${entry.code} exitCode=${entry.exitCode}${note} stderr=${stderr} stdout=${stdout}`,
  );
}
