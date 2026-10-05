/**
 * bdboard-4y8q.9.4: 届いた issue の定期確認のテスト用の、仮想の時計と偽のタイマー。
 * *-test-support.ts なので本番コードからの import は src/test-support-import-guard.test.ts が止める。
 */
import type { ExternalIssueSchedulerTimerHandle } from './external-issue-scheduler.js';

export interface FakeTimer extends ExternalIssueSchedulerTimerHandle {
  readonly dueMs: number;
  readonly delayMs: number;
  readonly callback: () => void;
  /** `unref` が呼ばれた回数。 */
  unrefs: number;
  cleared: boolean;
}

/**
 * 時計を持った偽のタイマー。実際には待たず、`advanceTo` で時計を進めたぶんだけ、期限が来たタイマーを時刻順に発火する。
 * 発火した確認が終わって次のタイマーが置かれる (または止められる) まで待ってから次へ進むので、
 * 確認が実際のファイル入出力を挟んでも、順序が決まる。
 */
export interface VirtualTimers {
  /** 仮想の時計 (ミリ秒)。 */
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => FakeTimer;
  readonly clearTimer: (handle: ExternalIssueSchedulerTimerHandle) => void;
  /** これまでに置かれたタイマー (置いた順)。 */
  readonly created: readonly FakeTimer[];
  /** 今置かれていて、まだ発火も取り消しもされていないタイマー。 */
  pending(): readonly FakeTimer[];
  /** 時計を `targetMs` まで進める。期限が来たタイマーは、その期限の時刻に時計を合わせて発火する。 */
  advanceTo(targetMs: number): Promise<void>;
}

export function createVirtualTimers(startMs = 0): VirtualTimers {
  let nowMs = startMs;
  const created: FakeTimer[] = [];
  let waiting: Array<FakeTimer> = [];
  /** 発火したあと、次のタイマーが置かれるのを待つための呼び出し口 (置かれたら解く)。 */
  let onNextTimer: (() => void) | undefined;

  const timers: VirtualTimers = {
    now: () => nowMs,
    setTimer(callback, ms) {
      const timer: FakeTimer = {
        dueMs: nowMs + ms,
        delayMs: ms,
        callback,
        unrefs: 0,
        cleared: false,
        unref() {
          timer.unrefs += 1;
        },
      };
      created.push(timer);
      waiting.push(timer);
      onNextTimer?.();
      return timer;
    },
    clearTimer(handle) {
      const timer = handle as FakeTimer;
      timer.cleared = true;
      waiting = waiting.filter((candidate) => candidate !== timer);
      onNextTimer?.();
    },
    created,
    pending: () => waiting,
    async advanceTo(targetMs) {
      for (;;) {
        const next = [...waiting].sort((a, b) => a.dueMs - b.dueMs)[0];
        if (next === undefined || next.dueMs > targetMs) break;
        waiting = waiting.filter((candidate) => candidate !== next);
        nowMs = Math.max(nowMs, next.dueMs);
        const placedAgain = new Promise<void>((resolve) => {
          onNextTimer = resolve;
        });
        next.callback();
        await placedAgain;
        onNextTimer = undefined;
      }
      nowMs = Math.max(nowMs, targetMs);
    },
  };
  return timers;
}
