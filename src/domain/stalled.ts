import type { Ticket } from './ticket.js';

export interface StalledThresholds {
  /**
   * 既定 24時間。
   *
   * 当初 48時間にしていたが、実データで検証したところ in_progress の最古が 41時間で
   * 1件も拾えなかった。ユーザーが実際に「滞留している」と感じて手作業で洗い出した
   * チケット群はちょうど 24〜41時間帯に固まっており、48時間では機能しない。
   * 「丸一日誰も触っていない」を境界とする。
   */
  readonly stalledAfterMs: number;
}

export const DEFAULT_STALLED_THRESHOLDS: StalledThresholds = {
  stalledAfterMs: 24 * 60 * 60_000,
};

// in_progress かつ updatedAt が閾値以上古いものを滞留とみなす。
export function isStalled(
  ticket: Ticket,
  ctx: {
    readonly now: Date;
    readonly thresholds?: StalledThresholds;
  },
): boolean {
  if (ticket.status !== 'in_progress') {
    return false;
  }

  if (
    !(ticket.updatedAt instanceof Date) ||
    !Number.isFinite(ticket.updatedAt.getTime())
  ) {
    return false;
  }

  const thresholds = ctx.thresholds ?? DEFAULT_STALLED_THRESHOLDS;
  const elapsedMs = ctx.now.getTime() - ticket.updatedAt.getTime();

  return elapsedMs >= thresholds.stalledAfterMs;
}
