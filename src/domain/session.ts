import type { TicketId } from './ticket-id.js';

export interface AgentSession {
  readonly sessionId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly startedAt: Date;
  readonly lastActivityAt: Date;
  readonly alive: boolean;
  readonly kind?: string;
  readonly entrypoint?: string;
  readonly name?: string;
}

export const SESSION_LINK_SOURCES = ['metadata', 'transcript'] as const;

export type SessionLinkSource = (typeof SESSION_LINK_SOURCES)[number];

export interface SessionLink {
  readonly ticketId: TicketId;
  readonly sessionId: string;
  readonly source: SessionLinkSource;
  readonly confidence: number;
  readonly observedAt: Date;
}

/**
 * トランスクリプト走査由来のセッションリンクをインメモリ/永続キャッシュの双方で保持する上限。
 * main.ts の transcriptLinkMap と infrastructure/cache/sqlite-board-cache.ts の
 * session_links テーブルは、どちらも observedAt 昇順(古い順)にこの件数まで切り詰める。
 */
export const MAX_TRANSCRIPT_SESSION_LINKS = 5000;
