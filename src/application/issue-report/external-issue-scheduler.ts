import {
  EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS,
  nextExternalIssuePollDelayMs,
} from '../../domain/external-issue-poll-policy.js';

/**
 * 届いた issue を定期的に確かめるタイマー (bdboard-4y8q.9.4、docs/ISSUE-REPORTING.md 8節)。
 *
 * 1 本ずつ `setTimeout` を置く: 確認が終わってから次を置くので、遅い確認が重ならない。間隔の延ばし方は
 * `nextExternalIssuePollDelayMs` (rate-limited / failed のときだけ倍にして 1 時間まで)。
 */

/** タイマーの持ち手。Node の `Timeout` は `unref` を持つ (プロセスの終了を止めないために呼ぶ)。 */
export interface ExternalIssueSchedulerTimerHandle {
  unref?(): unknown;
}

/** 確認の結果のうち、次の間隔を決めるのに見るところだけ (`ExternalIssueList` の一部)。 */
export interface ExternalIssuePollOutcome {
  readonly state: string;
  readonly error: { readonly kind: string } | null;
}

export interface ExternalIssueSchedulerOptions {
  /** 1 回の確認。`ExternalIssueService.poll` を渡す (失敗は例外にせず `state: 'error'` で返る契約。投げても止まらない)。 */
  readonly poll: () => Promise<ExternalIssuePollOutcome>;
  /** 丸め済みの通常の間隔 (ミリ秒)。 */
  readonly baseIntervalMs: number;
  /** 最初の確認までの待ち (既定は起動の 60 秒後)。 */
  readonly firstDelayMs?: number;
  /** 既定はグローバルの `setTimeout`。テストが偽のタイマーに差し替える。 */
  readonly setTimer?: (callback: () => void, ms: number) => ExternalIssueSchedulerTimerHandle;
  readonly clearTimer?: (handle: ExternalIssueSchedulerTimerHandle) => void;
  /** 確認が終わるたびの通知 (ログ用)。ここが投げても、タイマーは止めない。 */
  readonly onResult?: (outcome: ExternalIssuePollOutcome) => void;
}

export interface ExternalIssueScheduler {
  /** 最初の確認を置く。2 回目以降と、`stop` の後は何もしない (使い捨て)。 */
  start(): void;
  /** 置いてあるタイマーを止め、以後は置かない。実行中の確認が終わっても、次は置かない。 */
  stop(): void;
}

export function createExternalIssueScheduler(options: ExternalIssueSchedulerOptions): ExternalIssueScheduler {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let started = false;
  let stopped = false;
  let timer: ExternalIssueSchedulerTimerHandle | undefined;
  let previousDelayMs = options.baseIntervalMs;

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      void checkOnce();
    }, delayMs);
    // 確認のタイマーだけでプロセスを生かし続けない (終了のシグナルを待たずに止まれるように)。
    timer.unref?.();
  }

  async function checkOnce(): Promise<void> {
    let outcome: ExternalIssuePollOutcome;
    try {
      outcome = await options.poll();
    } catch {
      // サービスは投げない契約だが、投げても止めない。失敗として延ばす。
      outcome = { state: 'error', error: { kind: 'failed' } };
    }
    try {
      options.onResult?.(outcome);
    } catch {
      // 通知 (ログ) の失敗で、次の確認を置き損ねない。
    }
    const errorKind = outcome.state === 'error' ? (outcome.error?.kind ?? 'failed') : null;
    previousDelayMs = nextExternalIssuePollDelayMs({
      baseMs: options.baseIntervalMs,
      previousMs: previousDelayMs,
      errorKind,
    });
    schedule(previousDelayMs);
  }

  return {
    start() {
      if (started) return;
      started = true;
      schedule(options.firstDelayMs ?? EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
