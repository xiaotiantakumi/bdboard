import { fetchJson } from './http';

export interface AttachmentDto {
  fileName: string;
  url: string;
  byteLength: number;
  createdAt: string;
}

/** bdboard-qw26: チケット詳細の添付画像一覧。0件のときは空配列(セクション自体を隠すのは呼び出し側)。 */
export function fetchTicketAttachments(ticketId: string): Promise<{ attachments: AttachmentDto[] }> {
  return fetchJson<{ attachments: AttachmentDto[] }>(
    `/api/tickets/${encodeURIComponent(ticketId)}/attachments`,
  );
}

/**
 * bdboard-ij1h: 添付画像を削除する (実体はサーバー側でゴミ箱へ退避され、一覧/取得から
 * 消えるだけ。誤削除からの復旧はサーバー側のファイルから行う想定で、UI からの復元は
 * 提供しない)。
 */
export function deleteTicketAttachment(ticketId: string, fileName: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(fileName)}`,
    { method: 'DELETE' },
  ).then(() => undefined);
}
