import {
  EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS,
  nextExternalIssuePollDelayMs,
} from '../../domain/external-issue-poll-policy.js';

export interface ExternalIssueSchedulerTimerHandle { unref?(): unknown }
export interface ExternalIssueSchedulerOptions {
  readonly poll: () => Promise<{ readonly state: string; readonly error: { readonly kind: string } | null }>;
  readonly baseIntervalMs: number;
  readonly firstDelayMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => ExternalIssueSchedulerTimerHandle;
  readonly clearTimer?: (handle: ExternalIssueSchedulerTimerHandle) => void;
  readonly onResult?: (result: { state: string; error: { kind: string } | null }) => void;
}
export interface ExternalIssueScheduler { start(): void; stop(): void }

export function createExternalIssueScheduler(options: ExternalIssueSchedulerOptions): ExternalIssueScheduler {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let started = false;
  let stopped = false;
  let timer: ExternalIssueSchedulerTimerHandle | undefined;
  let previousMs = options.baseIntervalMs;
  function schedule(ms: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      void runPoll();
    }, ms);
    timer.unref?.();
  }
  async function runPoll(): Promise<void> {
    let result: { state: string; error: { kind: string } | null };
    try {
      result = await options.poll();
    } catch {
      result = { state: 'error', error: { kind: 'failed' } };
    }
    options.onResult?.(result);
    const delay = nextExternalIssuePollDelayMs({
      baseMs: options.baseIntervalMs,
      previousMs,
      errorKind: result.state === 'error' ? result.error?.kind ?? 'failed' : null,
    });
    previousMs = delay;
    schedule(delay);
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
