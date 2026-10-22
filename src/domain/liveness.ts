/**
 * board-thresholds (設定) が保持する liveness 閾値。セッション一覧の撤去
 * (bdboard-i9g4.9) 以降、盤面の計算は参照しない。設定ファイルの互換のためだけに残している。
 */
export interface LivenessThresholds {
  readonly activeMs: number;
  readonly idleMs: number;
  readonly staleMs: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  activeMs: 5 * 60_000,
  idleMs: 30 * 60_000,
  staleMs: 24 * 60 * 60_000,
};
