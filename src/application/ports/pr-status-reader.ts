import type { PrStatus } from '../../domain/pr-link.js';

export interface PrStatusReader {
  /**
   * PR/CIの状態を取得する。gh未インストール/未認証/レート制限/ネットワーク不通/
   * 想定外のJSON形状など、判定できない理由が何であれ例外を投げてはならない —
   * 呼び出し元はそのチケットのPRバッジをURLのみで表示するのにnullを使う。
   */
  getPrStatus(prUrl: string): Promise<PrStatus | null>;
}
