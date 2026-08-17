import type { TicketModelRecord } from '../../domain/ticket-model.js';

/** 1回の `bd show --json` から取り出せる、表示専用の補助メタデータ。 */
export interface TicketBdMetadata {
  /** `bdboard.session` メタデータ経由の手動セッションリンク。無ければ undefined。 */
  readonly manualSessionId?: string;
  /** `bdboard.model.<工程>` メタデータ。無ければ空配列。 */
  readonly models: readonly TicketModelRecord[];
}

export interface SessionLinkReaderPort {
  /**
   * チケットの bd メタデータを1回の `bd show --json` で読む。
   * チケット未発見・bd失敗・パース失敗はいずれも「情報なし」
   * (`{ models: [] }`) に落とす — 表示専用の補助データであり、
   * チケット詳細全体の取得を失敗させるべきではないため。
   */
  readTicketMetadata(
    rootPath: string,
    ticketId: string,
  ): Promise<TicketBdMetadata>;
}
