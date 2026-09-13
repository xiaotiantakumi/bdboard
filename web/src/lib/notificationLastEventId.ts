import { UI_STORAGE_KEYS } from '../uiPersistedState';

/**
 * サーバーが `notification` に振る SSE の event id のうち、このブラウザが最後に受け取ったもの
 * (bdboard-3tw.161)。ページを開き直した直後の EventSource は Last-Event-ID を持たないので、
 * これを接続 URL に付けてサーバーに「ここから先」を再送させる。
 *
 * localStorage は使えないことがある (プライベートモード等) ので、読み書きとも失敗は黙って
 * 無視する。失われても再送が全件になり、クライアント側の id 重複除去で吸収されるだけ。
 */
export function readNotificationLastEventId(): string | null {
  try {
    const value = localStorage.getItem(UI_STORAGE_KEYS.notificationLastEventId);
    return value !== null && value !== '' ? value : null;
  } catch {
    return null;
  }
}

export function writeNotificationLastEventId(id: string): void {
  if (id === '') {
    return;
  }
  try {
    localStorage.setItem(UI_STORAGE_KEYS.notificationLastEventId, id);
  } catch {
    // 保存できなくても再送が多めになるだけ。
  }
}
