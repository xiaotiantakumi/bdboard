/** 「トンネル稼働中にサーバーが停止した」という事実だけを永続化するポート (bdboard-8v8)。
 *  資格情報 (URL/ユーザー名/パスワード) は絶対に保存しない。張り直しは常に新しい
 *  パスワードでの新規開始として扱う。 */
export interface TunnelInterruptionStore {
  /** 記録があればその時刻、なければ null。読めない/壊れている場合も null 扱い。 */
  read(): Date | null;
  markInterrupted(at: Date): void;
  clear(): void;
}
