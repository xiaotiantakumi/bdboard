import { isTicketId, type TicketId } from './ticket-id.js';

/** bd メタデータのキー: 確認待ちレーン内の表示順 (ブロック依存とは独立)。 */
export const TICKET_REVIEW_AFTER_METADATA_KEY = 'bdboard.review_after';

/** `bdboard.review_after` のチケット ID リストを読み取る。 */
export function parseTicketReviewAfter(
  metadata: Readonly<Record<string, unknown>> | undefined,
): readonly TicketId[] | undefined {
  const value = metadata?.[TICKET_REVIEW_AFTER_METADATA_KEY];
  if (typeof value !== 'string') return undefined;
  const ids = new Set<TicketId>();
  for (const part of value.split(',')) {
    const id = part.trim();
    if (id && isTicketId(id)) ids.add(id);
  }
  return ids.size > 0 ? [...ids] : undefined;
}
