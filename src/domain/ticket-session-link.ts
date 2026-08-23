/** bd メタデータのキー: 手動で紐付けたセッションID。 */
export const SESSION_LINK_METADATA_KEY = 'bdboard.session';

/**
 * `bdboard.session` の値を取り出す。メタデータは外部入力なので、空文字や
 * 非文字列はリンクなしとして扱う。
 */
export function parseTicketManualSessionId(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const value = metadata?.[SESSION_LINK_METADATA_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
