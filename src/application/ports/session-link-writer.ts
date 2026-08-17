/**
 * セッション↔チケットの手動リンクを bd の `bdboard.session` メタデータ経由で
 * 書き込む/消すポート。値は1チケットにつき1セッションIDのみ(--set-metadataは
 * 単一キーを上書きする)。誤リンクの解除は unlinkSession でキーごと削除する。
 */
export interface SessionLinkWriterPort {
  linkSession(
    rootPath: string,
    ticketId: string,
    sessionId: string,
  ): Promise<void>;
  unlinkSession(rootPath: string, ticketId: string): Promise<void>;
}
