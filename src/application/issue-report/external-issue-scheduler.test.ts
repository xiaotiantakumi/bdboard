import { describe, expect, it, vi } from 'vitest';
import { createVirtualTimers } from './external-issue-poll-test-support.js';
import { createExternalIssueScheduler, type ExternalIssuePollOutcome } from './external-issue-scheduler.js';

const MINUTE_MS = 60_000;
const OK: ExternalIssuePollOutcome = { state: 'ok', error: null };
const failure = (kind: string): ExternalIssuePollOutcome => ({ state: 'error', error: { kind } });

/** 結果を順に返す偽の確認。使い切ったあとは成功を返す。 */
function scriptedPoll(outcomes: readonly ExternalIssuePollOutcome[]) {
  const queue = [...outcomes];
  return vi.fn(() => Promise.resolve(queue.shift() ?? OK));
}

function setup(options: { poll: () => Promise<ExternalIssuePollOutcome>; baseIntervalMs?: number; firstDelayMs?: number }) {
  const timers = createVirtualTimers();
  const onResult = vi.fn<(outcome: ExternalIssuePollOutcome) => void>();
  const scheduler = createExternalIssueScheduler({
    poll: options.poll,
    baseIntervalMs: options.baseIntervalMs ?? 15 * MINUTE_MS,
    ...(options.firstDelayMs !== undefined ? { firstDelayMs: options.firstDelayMs } : {}),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onResult,
  });
  return { timers, scheduler, onResult };
}

/** 置かれたタイマーの待ち時間 (置いた順)。 */
const delaysOf = (timers: ReturnType<typeof createVirtualTimers>) => timers.created.map((timer) => timer.delayMs);

describe('createExternalIssueScheduler: when it checks', () => {
  it('places nothing until started, then the first check 60 seconds after the start', () => {
    const poll = scriptedPoll([]);
    const { timers, scheduler } = setup({ poll });
    expect(timers.created).toHaveLength(0);

    scheduler.start();

    expect(delaysOf(timers)).toEqual([60_000]);
    expect(poll).not.toHaveBeenCalled();
  });

  it('checks once at 60 seconds and then every base interval after each check finishes', async () => {
    const poll = scriptedPoll([]);
    const { timers, scheduler } = setup({ poll });
    scheduler.start();

    await timers.advanceTo(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await timers.advanceTo(60_000 + 15 * MINUTE_MS - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await timers.advanceTo(60_000 + 15 * MINUTE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    await timers.advanceTo(60_000 + 30 * MINUTE_MS);
    expect(poll).toHaveBeenCalledTimes(3);

    expect(delaysOf(timers)).toEqual([60_000, 900_000, 900_000, 900_000]);
  });

  it('takes the first delay from the option when one is given', () => {
    const { timers, scheduler } = setup({ poll: scriptedPoll([]), firstDelayMs: 1234 });
    scheduler.start();
    expect(delaysOf(timers)).toEqual([1234]);
  });

  it('does nothing on a second start', () => {
    const { timers, scheduler } = setup({ poll: scriptedPoll([]) });
    scheduler.start();
    scheduler.start();
    expect(timers.created).toHaveLength(1);
  });

  it('never has two checks running at once: the next timer is placed only after the check finished', async () => {
    let finishCheck: (outcome: ExternalIssuePollOutcome) => void = () => undefined;
    const poll = vi.fn(
      () =>
        new Promise<ExternalIssuePollOutcome>((resolve) => {
          finishCheck = resolve;
        }),
    );
    const { timers, scheduler } = setup({ poll });
    scheduler.start();

    // advanceTo は次のタイマーが置かれるまで戻らないので、確認が終わらない間は await しない。
    const advancing = timers.advanceTo(60_000);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toHaveLength(0);
    // 確認が長引いて何時間たっても、次の確認は始まらない。
    expect(timers.created).toHaveLength(1);

    finishCheck(OK);
    await advancing;
    expect(delaysOf(timers)).toEqual([60_000, 900_000]);
  });
});

describe('createExternalIssueScheduler: stretching the interval on failures', () => {
  it('doubles after each rate-limited result (15 -> 30 -> 60 minutes) and stays at an hour', async () => {
    const { timers, scheduler } = setup({
      poll: scriptedPoll([failure('rate-limited'), failure('rate-limited'), failure('rate-limited'), failure('rate-limited')]),
    });
    scheduler.start();

    await timers.advanceTo(10 * 60 * MINUTE_MS);

    // 4 回の失敗のあと 5 回目 (成功) で通常の間隔に戻る (ここでは 5 本目までを見る)。
    expect(delaysOf(timers).slice(0, 5)).toEqual([60_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000]);
    expect(delaysOf(timers)[5]).toBe(900_000);
  });

  it('does the same for failed, and goes back to the base interval at the first success', async () => {
    const { timers, scheduler } = setup({
      poll: scriptedPoll([failure('failed'), failure('failed'), OK, failure('failed')]),
    });
    scheduler.start();

    await timers.advanceTo(6 * 60 * MINUTE_MS);

    // 失敗 (30) → 失敗 (60) → 成功 (15 に戻る) → 失敗 (また 30 から) → あとは成功 (15)。
    expect(delaysOf(timers).slice(0, 6)).toEqual([60_000, 1_800_000, 3_600_000, 900_000, 1_800_000, 900_000]);
  });

  it('starts the stretch from the five-minute floor and also stops at an hour', async () => {
    const { timers, scheduler } = setup({
      poll: scriptedPoll(Array.from({ length: 6 }, () => failure('failed'))),
      baseIntervalMs: 5 * MINUTE_MS,
    });
    scheduler.start();

    await timers.advanceTo(12 * 60 * MINUTE_MS);

    expect(delaysOf(timers).slice(0, 7)).toEqual([60_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000, 3_600_000]);
  });

  it.each(['gh-missing', 'gh-unauthenticated', 'bd-failed', 'storage-failed', 'unexpected'])(
    'keeps the base interval for %s (waiting does not fix it)',
    async (kind) => {
      const { timers, scheduler } = setup({ poll: scriptedPoll([failure(kind), failure(kind), failure(kind)]) });
      scheduler.start();

      await timers.advanceTo(3 * 60 * MINUTE_MS);

      expect(delaysOf(timers).slice(0, 4)).toEqual([60_000, 900_000, 900_000, 900_000]);
    },
  );

  it('treats a check that rejects as a failure: it does not stop, and it stretches', async () => {
    const poll = vi
      .fn<() => Promise<ExternalIssuePollOutcome>>()
      .mockRejectedValueOnce(new Error('the service broke its contract'))
      .mockResolvedValue(OK);
    const { timers, scheduler, onResult } = setup({ poll });
    scheduler.start();

    await timers.advanceTo(2 * 60 * MINUTE_MS);

    expect(delaysOf(timers).slice(0, 3)).toEqual([60_000, 1_800_000, 900_000]);
    expect(onResult.mock.calls[0]?.[0]).toEqual(failure('failed'));
  });

  it('treats an error state that carries no error as a failure', async () => {
    const { timers, scheduler } = setup({ poll: scriptedPoll([{ state: 'error', error: null }]) });
    scheduler.start();

    await timers.advanceTo(60 * MINUTE_MS);

    expect(delaysOf(timers).slice(0, 2)).toEqual([60_000, 1_800_000]);
  });
});

describe('createExternalIssueScheduler: the result callback', () => {
  it('is told about every check, in order', async () => {
    const { timers, scheduler, onResult } = setup({ poll: scriptedPoll([failure('failed'), OK]) });
    scheduler.start();

    await timers.advanceTo(2 * 60 * MINUTE_MS);

    expect(onResult.mock.calls.slice(0, 2).map(([outcome]) => outcome)).toEqual([failure('failed'), OK]);
  });

  it('does not stop the checks when the callback throws', async () => {
    const poll = scriptedPoll([]);
    const timers = createVirtualTimers();
    const scheduler = createExternalIssueScheduler({
      poll,
      baseIntervalMs: 15 * MINUTE_MS,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onResult: () => {
        throw new Error('the logger broke');
      },
    });
    scheduler.start();

    await timers.advanceTo(60_000 + 15 * MINUTE_MS);

    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe('createExternalIssueScheduler: not keeping the process alive, and stopping', () => {
  it('unrefs every timer it places', async () => {
    const { timers, scheduler } = setup({ poll: scriptedPoll([failure('failed')]) });
    scheduler.start();

    await timers.advanceTo(3 * 60 * MINUTE_MS);

    expect(timers.created.length).toBeGreaterThanOrEqual(3);
    expect(timers.created.every((timer) => timer.unrefs === 1)).toBe(true);
  });

  it('tolerates a timer handle that has no unref (a fake or a browser-style timer)', () => {
    const scheduler = createExternalIssueScheduler({
      poll: scriptedPoll([]),
      baseIntervalMs: 15 * MINUTE_MS,
      setTimer: () => ({}),
      clearTimer: () => undefined,
    });
    expect(() => scheduler.start()).not.toThrow();
  });

  it('clears the pending timer on stop and places nothing afterwards', async () => {
    const poll = scriptedPoll([]);
    const { timers, scheduler } = setup({ poll });
    scheduler.start();
    const [first] = timers.created;

    scheduler.stop();

    expect(first?.cleared).toBe(true);
    expect(timers.pending()).toHaveLength(0);
    await timers.advanceTo(10 * 60 * MINUTE_MS);
    expect(poll).not.toHaveBeenCalled();
    expect(timers.created).toHaveLength(1);
  });

  it('does not place the next timer when stop is called while a check is running', async () => {
    let finishCheck: (outcome: ExternalIssuePollOutcome) => void = () => undefined;
    const poll = vi.fn(
      () =>
        new Promise<ExternalIssuePollOutcome>((resolve) => {
          finishCheck = resolve;
        }),
    );
    const { timers, scheduler } = setup({ poll });
    scheduler.start();
    void timers.advanceTo(60_000);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);

    scheduler.stop();
    finishCheck(OK);
    // 確認の後始末 (結果の通知と次のタイマー) が済むまで、マイクロタスクを流す。
    await new Promise((resolve) => setImmediate(resolve));

    expect(timers.created).toHaveLength(1);
    expect(timers.pending()).toHaveLength(0);
  });

  it('is safe to stop twice, or before start, and a start after stop places nothing', () => {
    const { timers, scheduler } = setup({ poll: scriptedPoll([]) });

    expect(() => {
      scheduler.stop();
      scheduler.stop();
    }).not.toThrow();
    scheduler.start();

    expect(timers.created).toHaveLength(0);
  });
});

describe('createExternalIssueScheduler: with the real timers', () => {
  it('uses setTimeout by default and the timer does not keep the process alive', () => {
    vi.useFakeTimers();
    try {
      const poll = scriptedPoll([]);
      const scheduler = createExternalIssueScheduler({ poll, baseIntervalMs: 15 * MINUTE_MS });
      scheduler.start();
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(59_999);
      expect(poll).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(poll).toHaveBeenCalledTimes(1);

      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the real Node timer unref-ed, so it alone cannot keep the process alive', () => {
    // 呼び出しはそのまま本物の setTimeout へ通し、返ってきた Timeout が ref されていないことを見る。
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const scheduler = createExternalIssueScheduler({ poll: scriptedPoll([]), baseIntervalMs: 15 * MINUTE_MS });
    try {
      scheduler.start();
      const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout | undefined;
      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(false);
    } finally {
      scheduler.stop();
      setTimeoutSpy.mockRestore();
    }
  });
});
