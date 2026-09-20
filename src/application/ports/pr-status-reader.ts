import type { PrStatus } from '../../domain/pr-link.js';

/**
 * gh 呼び出しが失敗したときの理由。呼び出し元 (PrBadgeStatusCache の否定キャッシュ /
 * サーキットブレーカー) が再試行の間隔を決めるのに使う。UI に見せる形は変えない —
 * status===null は従来どおり「状態不明 (URLのみのバッジ)」として扱われる (bdboard-7ln6)。
 */
export type PrStatusFailureReason = 'rate-limit' | 'not-found' | 'timeout' | 'other';

export type PrStatusResult =
  | { readonly status: PrStatus }
  | { readonly status: null; readonly reason: PrStatusFailureReason };

export interface PrStatusReader {
  /**
   * PR/CIの状態を取得する。gh未インストール/未認証/レート制限/ネットワーク不通/
   * 想定外のJSON形状など、判定できない理由が何であれ例外を投げてはならない —
   * 失敗時は { status: null, reason } を返す。呼び出し元はそのチケットのPRバッジを
   * URLのみで表示するのに status===null を使う。reason は呼び出し元が再試行間隔
   * (通常の否定キャッシュ / rate-limit時のサーキットブレーカー) を決めるためだけに使い、
   * UI表示契約 (status===null → 状態不明) には影響しない。
   */
  getPrStatus(prUrl: string): Promise<PrStatusResult>;
}
