// bdboard-sso1.12: dto.ts のモジュール分割。セッション・セッション履歴・チャット発見
// セッション・エージェントプロセスなど「セッション/プロセス系」DTO。
// session-process-routes.ts / chat-routes.ts / board.ts (BoardCardDto.sessions 等) から
// 参照される (dto.ts の barrel 経由なので import 側は無変更)。
import {
  computeLiveness,
  type Liveness,
  type LivenessThresholds,
} from '../../../domain/liveness.js';
import type { AgentSession } from '../../../domain/session.js';
import type {
  SessionHistoryEntry,
  SessionHistoryTicketRef,
} from '../../../application/session/get-session-history.js';
import type { TranscriptTailMessage } from '../../../application/transcript/parse-transcript-messages.js';
import type { ListedAgentProcess } from '../../../application/session/list-agent-processes.js';

export interface SessionDto {
  sessionId: string;
  pid: number;
  cwd: string;
  alive: boolean;
  startedAt: string;
  lastActivityAt: string;
  liveness: Liveness;
  name?: string;
}

export interface SessionHistoryTicketDto {
  ticketId: string;
  title?: string;
}

export interface SessionHistoryEntryDto {
  session: SessionDto;
  projectId?: string;
  projectName?: string;
  tickets: SessionHistoryTicketDto[];
}

export interface SessionTailMessageDto {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface DiscoveredChatSessionDto {
  sessionId: string;
  lastActivityAt: string;
  alreadyAdopted: boolean;
  firstMessagePreview?: string;
  lastMessagePreview?: string;
}

export interface AgentProcessDto {
  pid: number;
  command: string;
  cwd: string;
  startedAt?: string;
  projectId?: string;
  projectName?: string;
}

/*
 * liveness を出す DTO 変換はすべて、解決済みの閾値 (ユーザー設定の上書きを
 * 含む) を **必須の第3引数** で受け取る (bdboard-3tw.102.5 → bdboard-5kz2)。
 *
 * 当初は任意引数にして「省略時は computeLiveness のデフォルト」に落としていたが、
 * それだと渡し忘れが型でも全テストでも検出できなかった。実際 bdboard-3tw.102.5 の
 * 初版では、toBoardCardDto / toBoardDto / toBoardViewDto のどこで引数を落としても
 * サーバー全2327テストが通ってしまう状態だった (渡し忘れの症状は「古い閾値のまま
 * 表示される」で、例外にならないぶん気づけない)。必須にして tsc で落とす。
 *
 * 既定値でよい呼び出し元は DEFAULT_LIVENESS_THRESHOLDS を明示的に渡すこと。
 * 「既定でよい」と「渡し忘れた」を、読んで区別できるようにするのが狙い。
 */
export function toSessionDto(
  session: AgentSession,
  now: Date,
  livenessThresholds: LivenessThresholds,
): SessionDto {
  return {
    sessionId: session.sessionId,
    pid: session.pid,
    cwd: session.cwd,
    alive: session.alive,
    startedAt: session.startedAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    liveness: computeLiveness(now, session, livenessThresholds),
    ...(session.name !== undefined ? { name: session.name } : {}),
  };
}

function toSessionHistoryTicketDto(
  ticket: SessionHistoryTicketRef,
): SessionHistoryTicketDto {
  return {
    ticketId: ticket.ticketId,
    ...(ticket.title !== undefined ? { title: ticket.title } : {}),
  };
}

export function toSessionTailMessageDto(
  message: TranscriptTailMessage,
): SessionTailMessageDto {
  return {
    role: message.role,
    text: message.text,
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  };
}

/*
 * 注意: ここで渡した閾値は結果に影響しない。getSessionHistory が返すのは
 * alive === false のセッションだけで、computeLiveness は !alive を閾値より先に
 * 見て dormant を返すため。「ended だけ」という条件が将来外れたときに配線漏れを
 * 作らないよう、引数は他と同じ形で受け取っている (bdboard-3tw.102.5)。
 */
export function toSessionHistoryEntryDto(
  entry: SessionHistoryEntry,
  now: Date,
  livenessThresholds: LivenessThresholds,
): SessionHistoryEntryDto {
  return {
    session: toSessionDto(entry.session, now, livenessThresholds),
    ...(entry.project !== undefined
      ? {
          projectId: entry.project.id,
          projectName: entry.project.name,
        }
      : {}),
    tickets: entry.tickets.map(toSessionHistoryTicketDto),
  };
}

export function toAgentProcessDto(process: ListedAgentProcess): AgentProcessDto {
  return {
    pid: process.pid,
    command: process.command,
    cwd: process.cwd,
    ...(process.startedAt !== undefined
      ? { startedAt: process.startedAt.toISOString() }
      : {}),
    ...(process.projectId !== undefined ? { projectId: process.projectId } : {}),
    ...(process.projectName !== undefined
      ? { projectName: process.projectName }
      : {}),
  };
}
