import type { Ticket } from './ticket.js';

export interface StalledThresholds {
  /**
   * 既定 24時間。
   *
   * 当初 48時間にしていたが、実データで検証したところ in_progress の最古が 41時間で
   * 1件も拾えなかった。ユーザーが実際に「滞留している」と感じて手作業で洗い出した
   * チケット群はちょうど 24〜41時間帯に固まっており、48時間では機能しない。
   * 「丸一日誰も触っておらず、動いているセッションも無い」を境界とする。
   */
  readonly stalledAfterMs: number;
}

export const DEFAULT_STALLED_THRESHOLDS: StalledThresholds = {
  stalledAfterMs: 24 * 60 * 60_000,
};

// 条件2だけだと、ノートPCを閉じている間や、ちょっと席を立った間の正常に作業中のチケットまで
// 滞留扱いになる(セッションは常時あるとは限らない)。
// 条件3だけだと、今まさに作業中でセッションも動いているのに bd の updated_at がたまたま古いだけの
// チケットを誤検知する。
// 両方を要求することで「誰も見ていない」かつ「動きが無い」を確実に捉える。
export function isStalled(
  ticket: Ticket,
  ctx: {
    readonly now: Date;
    readonly hasActiveSession: boolean;
    readonly thresholds?: StalledThresholds;
  },
): boolean {
  if (ticket.status !== 'in_progress') {
    return false;
  }

  if (ctx.hasActiveSession) {
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
